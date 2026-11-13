package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Субагенты: дочерние сессии с отдельной моделью и промптом.
 * Родитель ждёт результат; статусы видны в графе задач и переживают сворачивание приложения.
 */
object SubAgents {

    private val pool = Executors.newFixedThreadPool(2)
    private val tasks = ConcurrentHashMap<String, JSONObject>()

    private fun tasksFile(context: Context): File =
        File(Tools.chatRoot(context, "subagents"), "tasks.json")

    fun enqueue(context: Context, task: JSONObject) {
        val id = task.optString("id").ifBlank { "task_" + System.currentTimeMillis().toString(36) }
        task.put("id", id)
        task.put("status", "queued")
        task.put("ts", task.optLong("ts", System.currentTimeMillis()))
        task.put("chatId", task.optString("chatId"))
        tasks[id] = task
        persist(context)
        Steps.append(
            context,
            task.optString("chatId"),
            Steps.event("task.enqueue").put("id", id).put("role", task.optString("role"))
        )
        pool.submit { execute(context, task) }
    }

    private fun execute(context: Context, task: JSONObject) {
        val id = task.optString("id")
        try {
            task.put("status", "running")
            task.put("startedAt", System.currentTimeMillis())
            persist(context)
            notifyStatus(task)
            val providerId = task.optString("provider").ifBlank { "opencode" }
            val model = task.optString("model").ifBlank { "big-pickle" }
            val prompt = task.optString("prompt").ifBlank { task.optString("description") }
            val result = SubAgentRunner.run(context, providerId, model, prompt)
            task.put("status", if (result.optBoolean("ok")) "done" else "error")
            task.put("output", result.optString("text"))
            task.put("error", result.optString("error"))
        } catch (t: Throwable) {
            task.put("status", "error")
            task.put("error", t.message ?: "subagent failed")
        } finally {
            task.put("finishedAt", System.currentTimeMillis())
            persist(context)
            Steps.append(
                context,
                task.optString("chatId"),
                Steps.event("task.done")
                    .put("id", id)
                    .put("status", task.optString("status"))
            )
            notifyStatus(task)
        }
    }

    private fun notifyStatus(task: JSONObject) {
        val finished = task.optString("status") == "done" || task.optString("status") == "error"
        Notifier.emitToUi(
            App.instance,
            "agent.status",
            JSONObject()
                .put("chatId", task.optString("chatId"))
                .put("taskId", task.optString("id"))
                .put("status", task.optString("status"))
                .put("finished", finished)
                .put("text", "Субагент: " + task.optString("description"))
        )
        if (finished) {
            Notifier.post(
                App.instance,
                JSONObject()
                    .put("chatId", task.optString("chatId"))
                    .put("title", "Субагент завершён")
                    .put("text", task.optString("description"))
                    .put("running", false)
            )
        }
    }

    fun all(context: Context): JSONObject {
        val arr = JSONArray()
        tasks.values.sortedBy { it.optLong("ts") }.forEach { arr.put(it) }
        return JSONObject().put("ok", true).put("tasks", arr)
    }

    private fun persist(context: Context) {
        runCatching {
            val file = tasksFile(context)
            file.parentFile?.mkdirs()
            val arr = JSONArray()
            tasks.values.forEach { arr.put(it) }
            val tmp = File(file.parentFile, ".tasks.json.tmp")
            tmp.writeText(arr.toString())
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
        }
    }

    fun restore(context: Context) {
        runCatching {
            val file = tasksFile(context)
            if (!file.exists()) return
            val arr = JSONArray(file.readText())
            for (i in 0 until arr.length()) {
                val item = arr.getJSONObject(i)
                if (item.optString("status") == "running") item.put("status", "queued")
                tasks[item.optString("id")] = item
            }
        }
    }
}

/**
 * Прогон субагента: один запрос без инструментов, чтобы результат был предсказуемым
 * и не блокировал родителя. Поддерживает все три типа API.
 */
object SubAgentRunner {

    fun run(context: Context, providerId: String, model: String, prompt: String): JSONObject {
        val first = attempt(context, providerId, model, prompt)
        if (first.optBoolean("ok")) return first
        val errorText = first.optString("error")
        if (errorText.contains("429") || errorText.contains("лимит", ignoreCase = true)) {
            Quota.markAccountLimited(context, providerId, 600_000L)
        }
        return first
    }

    private fun attempt(
        context: Context,
        providerId: String,
        model: String,
        prompt: String
    ): JSONObject {
        val provider = Providers.byId(context, providerId)
            ?: return JSONObject().put("ok", false).put("error", "провайдер недоступен")
        val keys = Secrets.keyRing(context, provider.id)
        val key = keys.firstOrNull()
        if (provider.needsKey && key == null) {
            return JSONObject().put("ok", false).put("error", "нет ключа")
        }
        if (!Net.isOnline(context)) {
            return JSONObject().put("ok", false).put("error", "нет сети")
        }
        val headers = Providers.headers(provider, key).toMutableMap()
        headers["Accept"] = "application/json"
        Providers.customHeaders(context, provider.id).forEach { (k, v) -> headers[k] = v }

        val started = System.currentTimeMillis()
        val result: Result<JSONObject> = when (provider.apiType) {
            "anthropic" -> {
                val body = JSONObject()
                    .put("model", model)
                    .put("max_tokens", 2048)
                    .put(
                        "messages",
                        JSONArray().put(JSONObject().put("role", "user").put("content", prompt))
                    )
                    .put("system", "Ты субагент. Отвечай кратко и по делу.")
                Net.json(provider.baseUrl + "/messages", "POST", headers, body.toString(), idempotent = false)
            }
            "gemini" -> {
                val body = JSONObject()
                    .put(
                        "contents",
                        JSONArray().put(
                            JSONObject()
                                .put("role", "user")
                                .put("parts", JSONArray().put(JSONObject().put("text", prompt)))
                        )
                    )
                    .put(
                        "systemInstruction",
                        JSONObject().put(
                            "parts",
                            JSONArray().put(JSONObject().put("text", "Ты субагент. Отвечай кратко и по делу."))
                        )
                    )
                Net.json(
                    provider.baseUrl + "/models/" + model + ":generateContent",
                    "POST", headers, body.toString(), idempotent = false
                )
            }
            else -> {
                val body = JSONObject()
                    .put("model", model)
                    .put(
                        "messages",
                        JSONArray()
                            .put(JSONObject().put("role", "system").put("content", "Ты субагент. Отвечай кратко и по делу."))
                            .put(JSONObject().put("role", "user").put("content", prompt))
                    )
                    .put("stream", false)
                Net.json(provider.baseUrl + "/chat/completions", "POST", headers, body.toString(), idempotent = false)
            }
        }
        val elapsed = System.currentTimeMillis() - started
        return result.getOrElse {
            JSONObject().put("ok", false).put("error", it.message ?: "ошибка сети").put("ms", elapsed)
        }.let { json ->
            val text = extractText(json, provider.apiType)
            if (text.isBlank()) JSONObject().put("ok", false).put("error", "пустой ответ")
            else JSONObject().put("ok", true).put("text", text).put("ms", elapsed)
        }
    }

    private fun extractText(json: JSONObject, apiType: String): String = when (apiType) {
        "anthropic" -> {
            val content = json.optJSONArray("content") ?: JSONArray()
            (0 until content.length())
                .mapNotNull { i -> content.optJSONObject(i)?.takeIf { it.optString("type") == "text" }?.optString("text") }
                .joinToString("")
        }
        "gemini" -> json.optJSONArray("candidates")
            ?.optJSONObject(0)
            ?.optJSONObject("content")
            ?.optJSONArray("parts")
            ?.optJSONObject(0)
            ?.optString("text") ?: ""
        else -> json.optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?.optString("content") ?: ""
    }
}
