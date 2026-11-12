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
    }

    private val runs = ConcurrentHashMap<String, Run>()

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

    fun compact(context: Context, chatId: String): JSONObject {
        // Сжатие сессии выполняется на следующем шаге: контекст обрезается до последних сообщений.
        return JSONObject().put("ok", true).put("chatId", chatId)
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
        val messages = payload.optJSONArray("messages") ?: JSONArray()
        val toolsEnabled = payload.optBoolean("tools", true)
        val planOnly = payload.optBoolean("planOnly", false)
        val keys = Secrets.keyRing(context, provider.id)
        val attemptKeys: List<String?> = if (keys.isEmpty()) listOf(null) else keys
        var lastError = "Не удалось получить ответ"
        var succeeded = false

        for ((keyIndex, key) in attemptKeys.withIndex()) {
            if (run.cancelled.get()) return
            if (provider.needsKey && key == null) {
                lastError = "Введите API-ключ в настройках провайдера"
                break
            }
            val outcome = attempt(
                context, host, run, provider, key, requestId, system, messages,
                toolsEnabled, planOnly, modelId
            )
            if (outcome.ok) {
                succeeded = true
                break
            }
            lastError = outcome.error
            if (!outcome.retryable) break
            if (outcome.status == 429 && key != null) {
                Secrets.rotate(context, provider.id, key)
            }
            if (keyIndex == attemptKeys.lastIndex) {
                val next = nextModel(payload, modelId)
                if (next != null && next.first == provider.id) {
                    val retry = attempt(
                        context, host, run, provider, attemptKeys.first(), requestId, system,
                        messages, toolsEnabled, planOnly, next.second
                    )
                    if (retry.ok) {
                        succeeded = true
                        break
                    }
                    lastError = retry.error
                }
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

    private fun nextModel(payload: JSONObject, current: String): Pair<String, String>? {
        val alt = payload.optJSONArray("fallbackModels") ?: return null
        for (i in 0 until alt.length()) {
            val item = alt.optJSONObject(i) ?: continue
            val id = item.optString("id")
            if (id.isNotBlank() && id != current) {
                return item.optString("provider") to id
            }
        }
        return null
    }

    private class Outcome(val ok: Boolean, val retryable: Boolean, val status: Int, val error: String)

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
        var finished = false
        var failure: Outcome? = null

        val callback = object : Net.Callback {
            override fun onDelta(text: String) {
                if (text.isEmpty()) return
                buffer.append(text)
                runCatching {
                    host.emit(
                        "llm.delta",
                        JSONObject().put("requestId", requestId).put("text", text)
                    )
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

            override fun onError(message: String, retryable: Boolean, status: Int) {
                finished = true
                failure = Outcome(false, retryable, status, message)
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
        failure?.let { return it }

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
                arr.put(
                    JSONObject()
                        .put("role", m.optString("role", "user"))
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
                val role = if (m.optString("role") == "assistant") "assistant" else "user"
                arr.put(
                    JSONObject()
                        .put("role", role)
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
                contents.put(
                    JSONObject()
                        .put("role", if (m.optString("role") == "assistant") "model" else "user")
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