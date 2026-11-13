package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Проверка моделей коротким запросом.
 *
 * Важно: проверка идёт строго последовательно с паузами. Параллельный «залп»
 * из десятков запросов сам вызывает 429 у провайдера, и рабочий ключ
 * выглядит как исчерпанный.
 */
object ModelCheck {

    private const val PROMPT = "ping"
    private const val MAX_TOKENS = 4
    private const val TIMEOUT_MS = 20_000L
    private const val GAP_MS = 350L

    private val pool = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ModelCheck").apply { isDaemon = true }
    }
    private val running = AtomicBoolean(false)

    data class Verdict(val ok: Boolean, val reason: String, val code: Int, val detail: String = "")

    fun isRunning(): Boolean = running.get()

    /**
     * Проверяет модели по одной. `onProgress` вызывается после каждой,
     * чтобы UI мог показывать живой список.
     */
    fun checkProvider(
        context: Context,
        provider: Providers.Provider,
        models: List<String>,
        onProgress: (checked: Int, total: Int, id: String, verdict: Verdict) -> Unit
    ): JSONObject {
        val keys = Secrets.keyRing(context, provider.id)
        if (provider.needsKey && keys.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "Нет ключа провайдера")
        }
        running.set(true)
        val results = ArrayList<JSONObject>()
        try {
            models.forEachIndexed { index, modelId ->
                val verdict = verifyOne(context, provider, keys, modelId)
                val item = JSONObject()
                    .put("id", modelId)
                    .put("ok", verdict.ok)
                    .put("reason", verdict.reason)
                    .put("code", verdict.code)
                    .put("detail", verdict.detail)
                results.add(item)
                runCatching { onProgress(index + 1, models.size, modelId, verdict) }

                if (verdict.ok) {
                    Quota.clear(context, provider.id, modelId)
                } else {
                    when (verdict.reason) {
                        "account_limit" -> Quota.markAccountLimited(context, provider.id, 5 * 60_000L)
                        "rate_limit" -> Quota.markLimited(context, provider.id, modelId, 60_000L)
                        "no_access" -> Quota.clear(context, provider.id, modelId)
                        else -> Unit
                    }
                }
                if (index < models.size - 1) Thread.sleep(GAP_MS)
            }
        } finally {
            running.set(false)
        }
        val arr = JSONArray()
        results.forEach { arr.put(it) }
        return JSONObject().put("ok", true).put("results", arr)
    }

    /**
     * Одна модель: до двух попыток при явном rate limit и с паузой из `Retry-After`.
     */
    private fun verifyOne(
        context: Context,
        provider: Providers.Provider,
        keys: List<String>,
        modelId: String
    ): Verdict {
        val attemptKeys: List<String?> = if (keys.isEmpty()) listOf(null) else keys
        var last = Verdict(false, "no_answer", 0)
        for (key in attemptKeys) {
            last = probeModel(context, provider, key, modelId)
            if (last.ok) return last
            if (last.reason == "rate_limit") {
                // Уважаем подсказку провайдера, затем одна повторная попытка.
                val wait = if (last.detail.toLongOrNull() ?: 0L > 0) {
                    (last.detail.toLongOrNull() ?: 0L).coerceIn(1_000L, 15_000L)
                } else {
                    1_500L
                }
                Thread.sleep(wait)
                last = probeModel(context, provider, key, modelId)
                if (last.ok) return last
            }
            // Проверка не переключает активный ключ: это делает только чат при реальной работе.
            if (last.reason != "rate_limit") return last
        }
        return last
    }

    private fun probeModel(
        context: Context,
        provider: Providers.Provider,
        key: String?,
        modelId: String
    ): Verdict {
        val headers = Providers.headers(provider, key).toMutableMap()
        headers["Accept"] = "application/json"
        Providers.customHeaders(context, provider.id).forEach { (k, v) -> headers[k] = v }

        val call: Result<JSONObject> = try {
            when (provider.apiType) {
                "anthropic" -> {
                    val body = JSONObject()
                        .put("model", modelId)
                        .put("max_tokens", MAX_TOKENS)
                        .put(
                            "messages",
                            JSONArray().put(JSONObject().put("role", "user").put("content", PROMPT))
                        )
                    Net.json(provider.baseUrl + "/messages", "POST", headers, body.toString(), idempotent = false)
                }
                "gemini" -> {
                    val body = JSONObject().put(
                        "contents",
                        JSONArray().put(
                            JSONObject().put("role", "user")
                                .put("parts", JSONArray().put(JSONObject().put("text", PROMPT)))
                        )
                    )
                    Net.json(
                        provider.baseUrl + "/models/" + modelId + ":generateContent",
                        "POST", headers, body.toString(), idempotent = false
                    )
                }
                else -> {
                    val body = JSONObject()
                        .put("model", modelId)
                        .put(
                            "messages",
                            JSONArray().put(JSONObject().put("role", "user").put("content", PROMPT))
                        )
                        .put("max_tokens", MAX_TOKENS)
                        .put("stream", false)
                    Net.json(provider.baseUrl + "/chat/completions", "POST", headers, body.toString(), idempotent = false)
                }
            }
        } catch (e: Exception) {
            return Verdict(false, "network", 0, e.message ?: "")
        }

        val failure = call.exceptionOrNull()
        if (failure is Net.NetException) {
            val reason = when {
                failure.code == 402 -> "account_limit"
                failure.quotaScope == "account" -> "account_limit"
                failure.code == 429 -> "rate_limit"
                failure.code == 401 || failure.code == 403 -> "no_access"
                failure.code == 404 -> "not_found"
                else -> "error"
            }
            return Verdict(false, reason, failure.code, failure.message)
        }
        if (failure != null) return Verdict(false, "network", 0, failure.message ?: "")

        val json = call.getOrNull() ?: return Verdict(false, "empty", 0)
        val answered = when (provider.apiType) {
            "anthropic" -> (json.optJSONArray("content")?.length() ?: 0) > 0
            "gemini" -> (json.optJSONArray("candidates")?.length() ?: 0) > 0
            else -> (json.optJSONArray("choices")?.length() ?: 0) > 0
        }
        return if (answered) Verdict(true, "ok", 200) else Verdict(false, "empty", 0)
    }
}
