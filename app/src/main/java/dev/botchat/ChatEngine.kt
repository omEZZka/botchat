package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Адаптер одного шага диалога: нормализует SSE-дельты и tool_calls
 * разных API в единый поток событий для UI.
 */
object ChatEngine {

    private class Run(val cancelled: AtomicBoolean = AtomicBoolean(false)) {
        var handle: Net.Handle? = null
        var thread: Thread? = null
        val startedAt: Long = System.currentTimeMillis()
    }

    private val runs = ConcurrentHashMap<String, Run>()

    /** Сколько раз повторяем упёршуюся в квоту модель, прежде чем идти по fallback. */
    /** Сколько всего ждать перегрузку канала, прежде чем показать ошибку. */
    private const val RETRY_BUDGET_MS = 75_000L

    /** Как часто отправлять накопленный текст в UI. */
    private const val FLUSH_MS = 60L



    fun start(context: Context, payload: JSONObject): JSONObject {
        val chatId = payload.optString("chatId")
        val requestId = payload.optString("requestId")
        val providerId = payload.optString("providerId")
        val modelId = payload.optString("modelId")
        if (modelId.isBlank()) {
            return JSONObject().put("ok", false).put("error", "Модель не выбрана")
        }
        val provider = Providers.byId(context, providerId)
            ?: return JSONObject().put("ok", false).put("error", "Провайдер не найден")
        if (!Net.isOnline(context)) {
            return JSONObject().put("ok", false).put("error", "Нет сети")
        }
        val host = MainActivity.host()
            ?: return JSONObject().put("ok", false).put("error", "UI не готов")
        val run = Run()
        runs[chatId] = run
        val thread = Thread {
            execute(context, host, run, payload, provider, requestId, chatId, modelId)
        }.apply {
            name = "ChatEngine-$chatId"
            isDaemon = true
        }
        run.thread = thread
        thread.start()
        return JSONObject().put("ok", true).put("requestId", requestId)
    }

    fun cancel(chatId: String): JSONObject {
        val run = runs.remove(chatId) ?: return JSONObject().put("ok", true)
        run.cancelled.set(true)
        run.handle?.cancel()
        run.thread?.interrupt()
        return JSONObject().put("ok", true)
    }

    /**
     * Сжатие сессии: помечаем чат и сохраняем метку в папке чата.
     * UI после этого сокращает окно истории, отправляемое модели.
     */
    fun compact(context: Context, chatId: String): JSONObject {
        return runCatching {
            val file = java.io.File(Tools.chatRoot(context, chatId), "compact.json")
            val payload = JSONObject()
                .put("ts", System.currentTimeMillis())
                .put("keep", 12)
            val tmp = java.io.File(file.parentFile, ".compact.json.tmp")
            tmp.writeText(payload.toString())
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
            Steps.append(context, chatId, Steps.event("session.compact").put("keep", 12))
            JSONObject().put("ok", true).put("keep", 12)
        }.getOrElse {
            JSONObject().put("ok", false).put("error", it.message ?: "compact failed")
        }
    }

    private fun execute(
        context: Context,
        host: BridgeHost,
        run: Run,
        payload: JSONObject,
        provider: Providers.Provider,
        requestId: String,
        chatId: String,
        modelId: String
    ) {
        val system = payload.optString("system")
        val messages = withImages(payload.optJSONArray("messages") ?: JSONArray(), payload.optJSONArray("images"))
        val images = payload.optJSONArray("images")
        val toolsEnabled = payload.optBoolean("tools", true)
        val planOnly = payload.optBoolean("planOnly", false)
        var lastError = "Не удалось получить ответ"
        var succeeded = false
        var current: Triple<Providers.Provider, String, String?>? = Triple(provider, modelId, null)

        // Цепочка fallback: основная модель → резервные; на каждую — все ключи провайдера.
        val candidates = ArrayList<Pair<Providers.Provider, String>>()
        candidates.add(provider to modelId)
        val chain = payload.optJSONArray("fallbackModels")
        if (chain != null) {
            for (i in 0 until chain.length()) {
                val item = chain.optJSONObject(i) ?: continue
                val pid = item.optString("provider", provider.id)
                val mid = item.optString("id")
                if (mid.isBlank()) continue
                val p = Providers.byId(context, pid) ?: continue
                if (candidates.none { it.first.id == p.id && it.second == mid }) {
                    candidates.add(p to mid)
                }
            }
        }

        var lastRetryAfter = -1L
        val ordered = Quota.order(context, candidates.map { it.first.id to it.second })
            .mapNotNull { pair -> candidates.firstOrNull { it.first.id == pair.first && it.second == pair.second } }

        val skippedProviders = HashSet<String>()

        for ((candidateProvider, candidateModel) in ordered) {
            if (skippedProviders.contains(candidateProvider.id)) continue
            // Аккаунтный лимит пропускаем только если у провайдера нет своих ключей:
            // при платном балансе 429 относится к модели, а не ко всему аккаунту.
            val hasKeys = Secrets.keyRing(context, candidateProvider.id).isNotEmpty()
            val accountWait = if (hasKeys) 0L else Quota.accountRemaining(context, candidateProvider.id)
            if (accountWait > 0) {
                skippedProviders.add(candidateProvider.id)
                lastRetryAfter = maxOf(lastRetryAfter, accountWait)
                lastError = "Лимит провайдера " + candidateProvider.name + " · ещё " +
                    (accountWait / 1000) + " с"
                emitNotice(
                    host,
                    requestId,
                    candidateProvider.name + ": лимит на все модели, переключаюсь"
                )
                continue
            }
            val knownWait = Quota.remaining(context, candidateProvider.id, candidateModel)
            if (knownWait > 0 && candidates.size > 1) {
                // Модель недавно упёрлась в квоту — не тратим на неё попытку.
                lastRetryAfter = maxOf(lastRetryAfter, knownWait)
                lastError = "Квота: " + candidateProvider.name + " · " + candidateModel
                continue
            }
            if (run.cancelled.get()) return
            val keys = Secrets.keyRing(context, candidateProvider.id)
            val attemptKeys: List<String?> = if (keys.isEmpty()) listOf(null) else keys
            var modelDone = false

            // Волна повторов: при квоте ждём подсказку провайдера и пробуем ещё раз,
            // не обрывая диалог. Лимит волн защищает от бесконечного ожидания.
            var wave = 0
            while (!succeeded && !modelDone) {
                val exhaustedKeys = ArrayList<String?>()
                for (key in attemptKeys) {
                    if (run.cancelled.get()) return
                    if (candidateProvider.needsKey && key == null) {
                        lastError = if (candidateProvider.id == provider.id) {
                            "Введите API-ключ в настройках провайдера"
                        } else {
                            "Нет ключа для " + candidateProvider.name
                        }
                        modelDone = true
                        break
                    }
                    if (exhaustedKeys.any { it != null && it == key }) continue
                    current = Triple(candidateProvider, candidateModel, key)
                    // Шлюз частоты нужен только для повторов: первая попытка идёт сразу.
                    if (wave > 0 || !exhaustedKeys.isEmpty()) {
                        if (!Throttle.acquire(candidateProvider.id) { run.cancelled.get() }) return
                    }
                    val outcome = attempt(
                        context, host, run, candidateProvider, key, requestId, system, messages,
                        toolsEnabled, planOnly, candidateModel
                    )
                    if (outcome.ok) {
                        succeeded = true
                        Quota.clear(context, candidateProvider.id, candidateModel)
                        ModelLimiter.reset(candidateProvider.id)
                        Throttle.relax(candidateProvider.id)
                        break
                    }
                    lastError = outcome.error
                    if (outcome.status == 429 || outcome.status == 402) {
                        lastRetryAfter = outcome.retryAfterMs
                        if (outcome.scope == "account") {
                            // Провайдер закрыл все бесплатные модели: нет смысла перебирать их.
                            Quota.markAccountLimited(
                                context,
                                candidateProvider.id,
                                if (outcome.retryAfterMs > 0) outcome.retryAfterMs else 600_000L
                            )
                            emitNotice(
                                host,
                                requestId,
                                candidateProvider.name + ": бесплатный лимит исчерпан, " +
                                    "продолжаю на другой бесплатной модели"
                            )
                            skippedProviders.add(candidateProvider.id)
                            modelDone = true
                            break
                        }
                        // «Запрос не выполнялся» — это временная перегрузка канала,
                        // а не исчерпание модели: не помечаем её лимитом, а ждём и повторяем.
                        val notExecuted = outcome.error.contains("не выполнялся", ignoreCase = true) ||
                            outcome.error.contains("not_executed", ignoreCase = true) ||
                            outcome.error.contains("не выполнен", ignoreCase = true) ||
                            outcome.error.contains("was not executed", ignoreCase = true)
                        if (notExecuted) {
                            // Держим паузу для всех запросов к этому провайдеру.
                            Throttle.pause(
                                candidateProvider.id,
                                outcome.retryAfterMs.takeIf { it > 0 } ?: 6_000L
                            )
                            ModelLimiter.backoff(candidateProvider.id)
                        } else {
                            Quota.markLimited(
                                context,
                                candidateProvider.id,
                                candidateModel,
                                (outcome.retryAfterMs.takeIf { it > 0 } ?: 8_000L)
                            )
                            ModelLimiter.backoff(candidateProvider.id)
                        }
                        if (key != null && attemptKeys.size > 1) {
                            exhaustedKeys.add(key)
                            Secrets.rotate(context, candidateProvider.id, key)
                            continue
                        }
                        // Один ключ: ждём и пробуем ту же модель в следующей волне.
                        break
                    }
                    if (!outcome.retryable) {
                        modelDone = true
                        break
                    }
                    break
                }
                if (succeeded || modelDone) break
                wave += 1
                val elapsed = System.currentTimeMillis() - run.startedAt
                if (elapsed > RETRY_BUDGET_MS) break
                val wait = quotaWait(lastRetryAfter, wave)
                emitNotice(
                    host,
                    requestId,
                    "Канал занят, жду " + (wait / 1000) + " с и повторяю…"
                )
                if (!sleepCancellable(run, wait)) return
            }
        }
        if (succeeded) {
            runCatching {
                host.emit(
                    "llm.model",
                    JSONObject()
                        .put("requestId", requestId)
                        .put("provider", current?.first?.id ?: provider.id)
                        .put("model", current?.second ?: modelId)
                )
            }
        }

        if (!succeeded && !run.cancelled.get()) {
            runCatching {
                host.emit(
                    "llm.error",
                    JSONObject().put("requestId", requestId).put("message", lastError)
                )
            }
        }
        runs.remove(chatId)
    }

    private fun quotaWait(retryAfterMs: Long, wave: Int): Long {
        // Провайдер просит «5–10 секунд»: берём верхнюю границу и растём дальше.
        val hinted = if (retryAfterMs > 0) (retryAfterMs * 3 / 2) else 0L
        val backoff = 2_500L * wave
        return maxOf(hinted, backoff).coerceIn(1_500, 20_000)
    }

    private fun sleepCancellable(run: Run, ms: Long): Boolean {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            if (run.cancelled.get()) return false
            Thread.sleep(80)
        }
        return !run.cancelled.get()
    }

    private fun emitNotice(host: BridgeHost, requestId: String, text: String) {
        runCatching {
            host.emit(
                "llm.notice",
                JSONObject().put("requestId", requestId).put("message", text)
            )
        }
    }

    /**
     * Адаптивный интервал между обычными запросами: после отказа растёт,
     * после успеха сбрасывается. Это защита от «все каналы под лимитом».
     */
    private object ModelLimiter {
        private val extra = ConcurrentHashMap<String, Long>()

        fun backoff(providerId: String) {
            val current = extra[providerId] ?: 0L
            extra[providerId] = (current + 800L).coerceAtMost(8_000L)
        }

        fun reset(providerId: String) {
            extra.remove(providerId)
        }
    }

    private class Outcome(
        val ok: Boolean,
        val retryable: Boolean,
        val status: Int,
        val error: String,
        val retryAfterMs: Long = -1L,
        val scope: String = "model"
    )

    private fun attempt(
        context: Context,
        host: BridgeHost,
        run: Run,
        provider: Providers.Provider,
        key: String?,
        requestId: String,
        system: String,
        messages: JSONArray,
        toolsEnabled: Boolean,
        planOnly: Boolean,
        modelId: String
    ): Outcome {
        val cancelled = AtomicBoolean(false)
        val toolAcc = LinkedHashMap<Int, ToolAcc>()
        val buffer = StringBuilder()
        val pending = StringBuilder()
        var lastFlush = System.currentTimeMillis()
        var finished = false
        var failure: Outcome? = null

        fun flush() {
            if (pending.isEmpty()) return
            val chunk = pending.toString()
            pending.setLength(0)
            runCatching {
                host.emit(
                    "llm.delta",
                    JSONObject().put("requestId", requestId).put("text", chunk)
                )
            }
        }

        val callback = object : Net.Callback {
            override fun onDelta(text: String) {
                if (text.isEmpty()) return
                buffer.append(text)
                pending.append(text)
                // Батчинг: один вызов моста на пачку чанков заметно быстрее,
                // чем событие на каждый токен.
                val now = System.currentTimeMillis()
                if (now - lastFlush >= FLUSH_MS) {
                    lastFlush = now
                    flush()
                }
            }

            override fun onToolDelta(index: Int, id: String?, name: String?, argsDelta: String?) {
                val acc = toolAcc.getOrPut(index) { ToolAcc() }
                if (!id.isNullOrBlank()) acc.id = id
                if (!name.isNullOrBlank()) acc.name = name
                if (!argsDelta.isNullOrBlank()) acc.args.append(argsDelta)
            }

            override fun onFinish(reason: String?) {
                finished = true
            }

            override fun onError(
                message: String,
                retryable: Boolean,
                status: Int,
                retryAfterMs: Long,
                scope: String
            ) {
                finished = true
                failure = Outcome(false, retryable, status, message, retryAfterMs, scope)
            }
        }

        val baseHeaders = Providers.headers(provider, key).toMutableMap()
        Providers.customHeaders(context, provider.id).forEach { (k, v) -> baseHeaders[k] = v }

        when (provider.apiType) {
            "anthropic" -> {
                val body = Anthropic.request(system, messages, toolsEnabled, planOnly, modelId)
                val url = provider.baseUrl + "/messages"
                baseHeaders["Accept"] = "text/event-stream"
                run.handle = Net.stream(url, baseHeaders, body.toString(), { line ->
                    if (cancelled.get()) {
                        false
                    } else {
                        Anthropic.parse(line, callback)
                        !finished
                    }
                }, callback)
            }
            "gemini" -> {
                val body = Gemini.request(system, messages, toolsEnabled, planOnly)
                val url = provider.baseUrl + "/models/" + modelId + ":streamGenerateContent?alt=sse"
                baseHeaders["Accept"] = "text/event-stream"
                run.handle = Net.stream(url, baseHeaders, body.toString(), { line ->
                    if (cancelled.get()) {
                        false
                    } else {
                        Gemini.parse(line, callback)
                        !finished
                    }
                }, callback)
            }
            else -> {
                val body = OpenAI.request(system, messages, toolsEnabled, planOnly, modelId)
                val url = provider.baseUrl + "/chat/completions"
                baseHeaders["Accept"] = "text/event-stream"
                run.handle = Net.stream(url, baseHeaders, body.toString(), { line ->
                    if (cancelled.get()) {
                        false
                    } else {
                        OpenAI.parse(line, callback)
                        !finished
                    }
                }, callback)
            }
        }

        val deadline = System.currentTimeMillis() + 180_000
        while (!finished && System.currentTimeMillis() < deadline) {
            if (run.cancelled.get()) {
                cancelled.set(true)
                run.handle?.cancel()
                return Outcome(false, false, 0, "Остановлено")
            }
            Thread.sleep(80)
        }
        if (!finished) {
            run.handle?.cancel()
            return Outcome(false, true, 0, "Превышено время ожидания ответа")
        }
        flush()
        failure?.let {
            runCatching { host.emit("llm.stop", JSONObject().put("requestId", requestId)) }
            return it
        }

        val calls = toolAcc.values.filter { it.name.isNotBlank() }.map { acc ->
            JSONObject()
                .put("id", acc.id.ifBlank { "call_" + Math.abs(acc.name.hashCode()) })
                .put("name", acc.name)
                .put("args", parseArgs(acc.args.toString()))
        }
        if (calls.isNotEmpty()) {
            runCatching {
                host.emit(
                    "llm.tool",
                    JSONObject().put("requestId", requestId).put("calls", JSONArray(calls))
                )
            }
        }
        runCatching { host.emit("llm.stop", JSONObject().put("requestId", requestId)) }
        runCatching {
            host.emit("llm.done", JSONObject().put("requestId", requestId))
        }
        return Outcome(true, false, 200, "")
    }

    private class ToolAcc {
        var index: Int = 0
        var id: String = ""
        var name: String = ""
        val args: StringBuilder = StringBuilder()
    }

    private fun withImages(messages: JSONArray, images: JSONArray?): JSONArray {
        if (images == null || images.length() == 0) return messages
        var lastUser = -1
        for (i in 0 until messages.length()) {
            if (messages.getJSONObject(i).optString("role") == "user") lastUser = i
        }
        if (lastUser < 0) return messages
        val target = messages.getJSONObject(lastUser)
        target.put("images", images)
        return messages
    }

    private fun parseArgs(raw: String): JSONObject {
        val text = raw.trim()
        if (text.isEmpty()) return JSONObject()
        return try {
            JSONObject(text)
        } catch (_: Exception) {
            JSONObject()
        }
    }

    private fun parseData(line: String): String? {
        if (!line.startsWith("data:")) return null
        val data = line.removePrefix("data:").trim()
        if (data.isEmpty() || data == "[DONE]") return null
        return data
    }

    /**
     * OpenAI-совместимый поток: choices[].delta.content и tool_calls по индексам.
     */
    private object OpenAI {

        fun request(
            system: String,
            messages: JSONArray,
            toolsEnabled: Boolean,
            planOnly: Boolean,
            modelId: String
        ): JSONObject {
            val systemText = if (planOnly) system + "\nТолько план, без вызова инструментов." else system
            val arr = JSONArray()
            if (systemText.isNotBlank()) {
                arr.put(JSONObject().put("role", "system").put("content", systemText))
            }
            for (i in 0 until messages.length()) {
                val m = messages.getJSONObject(i)
                val role = m.optString("role", "user")
                if (role == "tool") {
                    arr.put(
                        JSONObject()
                            .put("role", "tool")
                            .put("tool_call_id", m.optString("toolCallId"))
                            .put("content", m.optString("content", ""))
                    )
                    continue
                }
                val calls = m.optJSONArray("toolCalls")
                if (role == "assistant" && calls != null && calls.length() > 0) {
                    val serialized = JSONArray()
                    for (j in 0 until calls.length()) {
                        val call = calls.getJSONObject(j)
                        serialized.put(
                            JSONObject()
                                .put("id", call.optString("id"))
                                .put("type", "function")
                                .put(
                                    "function",
                                    JSONObject()
                                        .put("name", call.optString("name"))
                                        .put("arguments", call.optJSONObject("args")?.toString() ?: "{}")
                                )
                        )
                    }
                    arr.put(
                        JSONObject()
                            .put("role", "assistant")
                            .put("content", m.optString("content", ""))
                            .put("tool_calls", serialized)
                    )
                    continue
                }
                val imgs = m.optJSONArray("images")
                if (imgs != null && imgs.length() > 0) {
                    val content = JSONArray()
                    if (m.optString("content").isNotBlank()) {
                        content.put(JSONObject().put("type", "text").put("text", m.optString("content")))
                    }
                    for (j in 0 until imgs.length()) {
                        val img = imgs.getJSONObject(j)
                        content.put(
                            JSONObject()
                                .put("type", "image_url")
                                .put(
                                    "image_url",
                                    JSONObject().put("url", img.optString("dataUrl"))
                                )
                        )
                    }
                    arr.put(JSONObject().put("role", role).put("content", content))
                    continue
                }
                arr.put(
                    JSONObject()
                        .put("role", role)
                        .put("content", m.optString("content", ""))
                )
            }
            val body = JSONObject()
                .put("model", modelId)
                .put("messages", arr)
                .put("stream", true)
                .put("stream_options", JSONObject().put("include_usage", true))
                .put("temperature", 0.4)
            if (toolsEnabled && !planOnly) {
                body.put("tools", Tools.schemaOpenAI())
                body.put("tool_choice", "auto")
            }
            return body
        }

        fun parse(line: String, cb: Net.Callback) {
            val data = parseData(line) ?: return
            val json = runCatching { JSONObject(data) }.getOrNull() ?: return
            val choices = json.optJSONArray("choices") ?: return
            if (choices.length() == 0) return
            val choice = choices.optJSONObject(0) ?: return
            val delta = choice.optJSONObject("delta") ?: return
            val content = delta.optString("content")
            if (content.isNotEmpty()) cb.onDelta(content)
            val toolCalls = delta.optJSONArray("tool_calls")
            if (toolCalls != null) {
                for (i in 0 until toolCalls.length()) {
                    val call = toolCalls.optJSONObject(i) ?: continue
                    val fn = call.optJSONObject("function")
                    cb.onToolDelta(
                        call.optInt("index", i),
                        call.optString("id").ifBlank { null },
                        fn?.optString("name")?.ifBlank { null },
                        fn?.optString("arguments")?.ifBlank { null }
                    )
                }
            }
        }
    }

    /**
     * Anthropic Messages API: content_block_delta с text_delta и input_json_delta.
     */
    private object Anthropic {

        fun request(
            system: String,
            messages: JSONArray,
            toolsEnabled: Boolean,
            planOnly: Boolean,
            modelId: String
        ): JSONObject {
            val arr = JSONArray()
            val systemText = if (planOnly) system + "\nТолько план, без вызова инструментов." else system
            for (i in 0 until messages.length()) {
                val m = messages.getJSONObject(i)
                val role = m.optString("role")
                if (role == "tool") {
                    arr.put(
                        JSONObject()
                            .put("role", "user")
                            .put(
                                "content",
                                JSONArray().put(
                                    JSONObject()
                                        .put("type", "tool_result")
                                        .put("tool_use_id", m.optString("toolCallId"))
                                        .put("content", m.optString("content", ""))
                                )
                            )
                    )
                    continue
                }
                val calls = m.optJSONArray("toolCalls")
                if (role == "assistant" && calls != null && calls.length() > 0) {
                    val content = JSONArray()
                    if (m.optString("content").isNotBlank()) {
                        content.put(JSONObject().put("type", "text").put("text", m.optString("content")))
                    }
                    for (j in 0 until calls.length()) {
                        val call = calls.getJSONObject(j)
                        content.put(
                            JSONObject()
                                .put("type", "tool_use")
                                .put("id", call.optString("id"))
                                .put("name", call.optString("name"))
                                .put("input", call.optJSONObject("args") ?: JSONObject())
                        )
                    }
                    arr.put(JSONObject().put("role", "assistant").put("content", content))
                    continue
                }
                val imgs = m.optJSONArray("images")
                if (imgs != null && imgs.length() > 0) {
                    val content = JSONArray()
                    for (j in 0 until imgs.length()) {
                        val img = imgs.getJSONObject(j)
                        val dataUrl = img.optString("dataUrl")
                        val comma = dataUrl.indexOf(',')
                        val media = img.optString("mime", "image/png")
                        val b64 = if (comma >= 0) dataUrl.substring(comma + 1) else dataUrl
                        content.put(
                            JSONObject()
                                .put("type", "image")
                                .put(
                                    "source",
                                    JSONObject()
                                        .put("type", "base64")
                                        .put("media_type", media)
                                        .put("data", b64)
                                )
                        )
                    }
                    if (m.optString("content").isNotBlank()) {
                        content.put(JSONObject().put("type", "text").put("text", m.optString("content")))
                    }
                    arr.put(JSONObject().put("role", "user").put("content", content))
                    continue
                }
                arr.put(
                    JSONObject()
                        .put("role", if (role == "assistant") "assistant" else "user")
                        .put("content", m.optString("content", ""))
                )
            }
            val body = JSONObject()
                .put("model", modelId)
                .put("messages", arr)
                .put("max_tokens", 4096)
                .put("stream", true)
            if (systemText.isNotBlank()) body.put("system", systemText)
            if (toolsEnabled && !planOnly) body.put("tools", Tools.schemaAnthropic())
            return body
        }

        fun parse(line: String, cb: Net.Callback) {
            val data = parseData(line) ?: return
            val json = runCatching { JSONObject(data) }.getOrNull() ?: return
            when (json.optString("type")) {
                "content_block_start" -> {
                    val block = json.optJSONObject("content_block") ?: return
                    if (block.optString("type") == "tool_use") {
                        cb.onToolDelta(
                            json.optInt("index", 0),
                            block.optString("id").ifBlank { null },
                            block.optString("name").ifBlank { null },
                            null
                        )
                    }
                }
                "content_block_delta" -> {
                    val delta = json.optJSONObject("delta") ?: return
                    when (delta.optString("type")) {
                        "text_delta" -> cb.onDelta(delta.optString("text"))
                        "input_json_delta" -> cb.onToolDelta(
                            json.optInt("index", 0), null, null, delta.optString("partial_json")
                        )
                    }
                }
                "message_stop" -> cb.onFinish("stop")
                "error" -> {
                    val err = json.optJSONObject("error")
                    cb.onError(err?.optString("message") ?: "Ошибка Anthropic", true, 0)
                }
            }
        }
    }

    /**
     * Gemini: candidates[].content.parts[].text и functionCall.
     */
    private object Gemini {

        fun request(system: String, messages: JSONArray, toolsEnabled: Boolean, planOnly: Boolean): JSONObject {
            val contents = JSONArray()
            for (i in 0 until messages.length()) {
                val m = messages.getJSONObject(i)
                val role = m.optString("role")
                if (role == "tool") {
                    contents.put(
                        JSONObject()
                            .put("role", "user")
                            .put(
                                "parts",
                                JSONArray().put(
                                    JSONObject().put(
                                        "functionResponse",
                                        JSONObject()
                                            .put("name", m.optString("name", "tool"))
                                            .put(
                                                "response",
                                                JSONObject().put("result", m.optString("content", ""))
                                            )
                                    )
                                )
                            )
                    )
                    continue
                }
                val calls = m.optJSONArray("toolCalls")
                if (role == "assistant" && calls != null && calls.length() > 0) {
                    val parts = JSONArray()
                    if (m.optString("content").isNotBlank()) {
                        parts.put(JSONObject().put("text", m.optString("content")))
                    }
                    for (j in 0 until calls.length()) {
                        val call = calls.getJSONObject(j)
                        parts.put(
                            JSONObject().put(
                                "functionCall",
                                JSONObject()
                                    .put("name", call.optString("name"))
                                    .put("args", call.optJSONObject("args") ?: JSONObject())
                            )
                        )
                    }
                    contents.put(JSONObject().put("role", "model").put("parts", parts))
                    continue
                }
                val imgs = m.optJSONArray("images")
                if (imgs != null && imgs.length() > 0) {
                    val parts = JSONArray()
                    for (j in 0 until imgs.length()) {
                        val img = imgs.getJSONObject(j)
                        val dataUrl = img.optString("dataUrl")
                        val comma = dataUrl.indexOf(',')
                        val b64 = if (comma >= 0) dataUrl.substring(comma + 1) else dataUrl
                        parts.put(
                            JSONObject().put(
                                "inlineData",
                                JSONObject()
                                    .put("mimeType", img.optString("mime", "image/png"))
                                    .put("data", b64)
                            )
                        )
                    }
                    if (m.optString("content").isNotBlank()) {
                        parts.put(JSONObject().put("text", m.optString("content")))
                    }
                    contents.put(JSONObject().put("role", "user").put("parts", parts))
                    continue
                }
                contents.put(
                    JSONObject()
                        .put("role", if (role == "assistant") "model" else "user")
                        .put("parts", JSONArray().put(JSONObject().put("text", m.optString("content", ""))))
                )
            }
            val body = JSONObject().put("contents", contents)
            val sysText = if (planOnly) system + "\nТолько план, без вызова инструментов." else system
            if (sysText.isNotBlank()) {
                body.put(
                    "systemInstruction",
                    JSONObject().put("parts", JSONArray().put(JSONObject().put("text", sysText)))
                )
            }
            if (toolsEnabled && !planOnly) {
                body.put(
                    "tools",
                    JSONArray().put(JSONObject().put("functionDeclarations", Tools.schemaGemini()))
                )
            }
            return body
        }

        fun parse(line: String, cb: Net.Callback) {
            val data = parseData(line) ?: return
            val json = runCatching { JSONObject(data) }.getOrNull() ?: return
            val candidates = json.optJSONArray("candidates") ?: return
            if (candidates.length() == 0) return
            val parts = candidates.optJSONObject(0)?.optJSONObject("content")?.optJSONArray("parts") ?: return
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                val text = part.optString("text")
                if (text.isNotEmpty()) cb.onDelta(text)
                val fn = part.optJSONObject("functionCall")
                if (fn != null) {
                    cb.onToolDelta(
                        i,
                        "call_" + fn.optString("name"),
                        fn.optString("name"),
                        fn.optJSONObject("args")?.toString() ?: "{}"
                    )
                }
            }
        }
    }
}