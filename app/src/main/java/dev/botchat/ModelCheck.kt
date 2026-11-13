package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Реальная проверка моделей: короткий запрос к каждой модели.
 *
 * Модель попадает в список только если ответила. Ошибки квоты/лимита/доступа
 * помечаются и запоминаются в Quota, чтобы их не предлагать и не тратить время.
 */
object ModelCheck {

    private const val PROMPT = "ping"
    private const val MAX_TOKENS = 4
    private const val TIMEOUT_MS = 25_000L

    /** Одновременно проверяем немного моделей, чтобы не ловить 429 от частоты запросов. */
    private val pool = Executors.newFixedThreadPool(4) { r ->
        Thread(r, "ModelCheck").apply { isDaemon = true }
    }

    data class Verdict(val ok: Boolean, val reason: String, val code: Int)

    /**
     * Проверяет список моделей провайдера и возвращает отчёт по каждой.
     * Ключи перебираются кольцом, при 429 — ротация.
     */
    fun checkProvider(
        context: Context,
        provider: Providers.Provider,
        models: List<String>,
        onResult: (String, Verdict) -> Unit
    ): JSONObject {
        val keys = Secrets.keyRing(context, provider.id)
        val attemptKeys: List<String?> = if (keys.isEmpty()) listOf(null) else keys
        if (provider.needsKey && keys.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "Нет ключа провайдера")
        }
        val results = java.util.Collections.synchronizedMap(LinkedHashMap<String, JSONObject>())
        val latch = java.util.concurrent.CountDownLatch(models.size)

        models.forEach { modelId ->
            pool.execute {
                try {
                    var verdict = Verdict(false, "нет ответа", 0)
                    for (key in attemptKeys) {
                        verdict = probeModel(context, provider, key, modelId)
                        if (verdict.ok) break
                        if (verdict.code == 429 && key != null) {
                            Secrets.rotate(context, provider.id, key)
                            continue
                        }
                        if (verdict.reason != "rate_limit") break
                        Thread.sleep(600)
                        verdict = probeModel(context, provider, key, modelId)
                        if (verdict.ok) break
                    }
                    results[modelId] = verdictToJson(verdict)

                    // Неудачные по квоте/лимиту запоминаем, чтобы не предлагать снова.
                    if (!verdict.ok) {
                        when {
                            verdict.reason == "account_limit" -> Quota.markAccountLimited(context, provider.id, 5 * 60_000L)
                            verdict.code == 429 || verdict.reason == "rate_limit" ->
                                Quota.markLimited(context, provider.id, modelId, 3 * 60_000L)
                            verdict.code == 402 ->
                                Quota.markAccountLimited(context, provider.id, 5 * 60_000L)
                            else -> Unit
                        }
                    } else {
                        Quota.clear(context, provider.id, modelId)
                    }
                    onResult(modelId, verdict)
                } catch (t: Throwable) {
                    val failure = Verdict(false, t.message ?: "ошибка", 0)
                    results[modelId] = verdictToJson(failure)
                    onResult(modelId, failure)
                } finally {
                    latch.countDown()
                }
            }
        }
        latch.await(TIMEOUT_MS + 15_000, TimeUnit.MILLISECONDS)
        val arr = JSONArray()
        results.forEach { (id, json) -> arr.put(json.put("id", id)) }
        return JSONObject().put("ok", true).put("results", arr)
    }

    private fun verdictToJson(v: Verdict): JSONObject = JSONObject()
        .put("ok", v.ok)
        .put("reason", v.reason)
        .put("code", v.code)

    /** Один минимальный запрос к модели. Никаких ретраев здесь. */
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
            return Verdict(false, e.message ?: "ошибка", 0)
        }

        val failure = call.exceptionOrNull()
        if (failure is Net.NetException) {
            val scope = failure.quotaScope
            val reason = when {
                failure.code == 402 -> "account_limit"
                scope == "account" -> "account_limit"
                failure.code == 429 -> "rate_limit"
                failure.code == 401 || failure.code == 403 -> "no_access"
                failure.code == 404 -> "not_found"
                else -> "error"
            }
            return Verdict(false, reason, failure.code)
        }
        if (failure != null) return Verdict(false, "network", 0)

        val json = call.getOrNull() ?: return Verdict(false, "empty", 0)
        val answered = when (provider.apiType) {
            "anthropic" -> {
                val content = json.optJSONArray("content")
                content != null && content.length() > 0
            }
            "gemini" -> {
                val candidates = json.optJSONArray("candidates")
                candidates != null && candidates.length() > 0
            }
            else -> {
                val choices = json.optJSONArray("choices")
                choices != null && choices.length() > 0
            }
        }
        // Значение 200, но пустой ответ — модель отвечает, просто без контента.
        return if (answered || json.length() > 0) Verdict(true, "ok", 200)
        else Verdict(false, "empty", 0)
    }
}
