package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Проверка моделей коротким запросом — быстро, но без «залпа», который
 * сам вызывает 429.
 *
 * Схема: небольшой пул (3 потока) + общий ограничитель частоты (один запрос
 * каждые ~220 мс). Если провайдер просит подождать — пул ставится на паузу
 * целиком (общий `pauseUntil`), а не отдельные ветки. Признак лимита аккаунта
 * прекращает проверку остальных моделей.
 */
object ModelCheck {

    private const val PROMPT = "ping"
    private const val MAX_TOKENS = 4
    private const val WORKERS = 1
    private const val RETRY_WAIT_CAP_MS = 10_000L
    private const val TOTAL_BUDGET_MS = 90_000L

    private val running = AtomicBoolean(false)

    data class Verdict(val ok: Boolean, val reason: String, val code: Int, val detail: String = "")

    fun isRunning(): Boolean = running.get()

    private fun progress(index: Int, total: Int, id: String, verdict: Verdict) {
        runCatching {
            val host = MainActivity.host() ?: return
            host.emit(
                "models.verify.progress",
                JSONObject()
                    .put("index", index)
                    .put("total", total)
                    .put("id", id)
                    .put("ok", verdict.ok)
                    .put("reason", verdict.reason)
                    .put("code", verdict.code)
                    .put("detail", verdict.detail.take(300))
            )
        }
    }

    fun checkProvider(
        context: Context,
        provider: Providers.Provider,
        models: List<String>
    ): JSONObject {
        val keys = Secrets.keyRing(context, provider.id)
        if (provider.needsKey && keys.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "Нет ключа провайдера")
        }
        running.set(true)
        val results = arrayOfNulls<JSONObject>(models.size)
        val done = java.util.concurrent.atomic.AtomicInteger(0)
        val pauseUntil = AtomicLong(0L)
        val accountBlocked = AtomicBoolean(false)
        val latch = CountDownLatch(models.size)
        val deadline = System.currentTimeMillis() + TOTAL_BUDGET_MS
        val gate = Any()
        val consecutiveBusy = java.util.concurrent.atomic.AtomicInteger(0)
        val channelBusy = AtomicBoolean(false)

        fun waitForSlot() {
            while (true) {
                if (System.currentTimeMillis() > deadline) return
                val pause = pauseUntil.get()
                val now = System.currentTimeMillis()
                if (pause > now) {
                    Thread.sleep((pause - now).coerceAtMost(500L))
                    continue
                }
                synchronized(gate) {
                    val t = System.currentTimeMillis()
                    if (t >= nextSlotAt) {
                        nextSlotAt = t + Throttle.interval(provider.id)
                        return
                    }
                }
                Thread.sleep(40)
            }
        }

        val pool = Executors.newFixedThreadPool(WORKERS) { r ->
            Thread(r, "ModelCheck").apply { isDaemon = true }
        }

        try {
            models.forEachIndexed { index, modelId ->
                pool.execute {
                    try {
                        if (accountBlocked.get()) {
                            results[index] = rejected(modelId, "account_limit", 0, "пропущено: лимит аккаунта")
                            return@execute
                        }
                        if (channelBusy.get()) {
                            results[index] = rejected(modelId, "rate_limit", 429, "канал занят лимитом")
                            return@execute
                        }
                        val knownWait = Quota.remaining(context, provider.id, modelId)
                        if (knownWait > 0) {
                            results[index] = rejected(
                                modelId, "rate_limit", 429,
                                "пауза ещё " + (knownWait / 1000) + " с"
                            )
                            progress(done.incrementAndGet(), models.size, modelId, Verdict(false, "rate_limit", 429))
                            return@execute
                        }
                        waitForSlot()
                        if (System.currentTimeMillis() > deadline) {
                            results[index] = rejected(modelId, "rate_limit", 429, "превышен бюджет проверки")
                            return@execute
                        }

                        var verdict = probeModel(context, provider, keys, modelId)

                        // Временная перегрузка канала: пауза для всего пула и один повтор.
                        if (!verdict.ok && verdict.reason == "rate_limit") {
                            // Три подряд «канал занят» — прекращаем проверку,
                            // чтобы не выжигать лимит и не показывать ложные отказы.
                            if (consecutiveBusy.incrementAndGet() >= 3) channelBusy.set(true)
                            val hint = waitHint(verdict.detail)
                            val wait = hint.coerceAtMost(RETRY_WAIT_CAP_MS)
                            // Пауза для всего пула и для общего шлюза провайдера.
                            pauseUntil.set(System.currentTimeMillis() + wait)
                            Throttle.pause(provider.id, wait)
                            Thread.sleep(wait)
                            verdict = probeModel(context, provider, keys, modelId)
                        }

                        results[index] = JSONObject()
                            .put("id", modelId)
                            .put("ok", verdict.ok)
                            .put("reason", verdict.reason)
                            .put("code", verdict.code)
                            .put("detail", verdict.detail)

                        if (verdict.ok) consecutiveBusy.set(0)
                        when {
                            verdict.ok -> Quota.clear(context, provider.id, modelId)
                            verdict.reason == "account_limit" -> {
                                Quota.markAccountLimited(context, provider.id, 5 * 60_000L)
                                accountBlocked.set(true)
                            }
                            verdict.reason == "rate_limit" -> Quota.markLimited(
                                context,
                                provider.id,
                                modelId,
                                if (verdict.detail.contains("не выполнялся", ignoreCase = true)) 15_000L else 30_000L
                            )
                            else -> Unit
                        }
                        progress(done.incrementAndGet(), models.size, modelId, verdict)
                    } catch (t: Throwable) {
                        results[index] = rejected(modelId, "error", 0, t.message ?: "ошибка")
                    } finally {
                        latch.countDown()
                    }
                }
            }
            latch.await(TOTAL_BUDGET_MS + 10_000L, TimeUnit.MILLISECONDS)
        } finally {
            pool.shutdownNow()
            running.set(false)
        }

        val arr = JSONArray()
        var blocked = false
        models.forEachIndexed { index, modelId ->
            val item = results[index] ?: rejected(modelId, "rate_limit", 0, "не проверялась")
            if (!item.optBoolean("ok") && item.optString("reason") == "account_limit") blocked = true
            arr.put(item)
        }
        return JSONObject()
            .put("ok", true)
            .put("results", arr)
            .put("accountBlocked", blocked)
            .put("channelBusy", channelBusy.get())
    }

    private fun rejected(id: String, reason: String, code: Int, detail: String): JSONObject =
        JSONObject().put("id", id).put("ok", false).put("reason", reason).put("code", code).put("detail", detail)

    @Volatile
    private var nextSlotAt: Long = 0L

    private fun waitHint(detail: String): Long {
        val hinted = Net.retryHintFromBody(detail)
        return when {
            hinted > 0 -> hinted
            detail.contains("не выполнялся", ignoreCase = true) -> 5_000L
            else -> 2_000L
        }
    }

    private fun probeModel(
        context: Context,
        provider: Providers.Provider,
        keys: List<String>,
        modelId: String
    ): Verdict {
        val attemptKeys: List<String?> = if (keys.isEmpty()) listOf(null) else keys
        var last = Verdict(false, "no_answer", 0)
        for (key in attemptKeys) {
            last = probeOnce(context, provider, key, modelId)
            if (last.ok) return last
            if (last.reason != "rate_limit") return last
            if (key != null && attemptKeys.size > 1) continue
            return last
        }
        return last
    }

    private fun probeOnce(
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
