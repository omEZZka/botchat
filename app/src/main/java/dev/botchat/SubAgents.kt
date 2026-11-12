package dev.botchat

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Реестр субагентов. Каждый — отдельная сессия со своей моделью и промптом;
 * родитель ждёт результат, статусы видны в графе задач.
 */
object SubAgents {

    private val pool = Executors.newFixedThreadPool(2)
    private val tasks = ConcurrentHashMap<String, JSONObject>()

    fun enqueue(context: Context, task: JSONObject) {
        task.put("status", "queued")
        tasks[task.optString("id")] = task
        pool.submit {
            try {
                task.put("status", "running")
                task.put("startedAt", System.currentTimeMillis())
                val providerId = task.optString("provider").ifBlank { "opencode" }
                val model = task.optString("model").ifBlank { "zen-free" }
                val prompt = task.optString("prompt")
                val result = SubAgentRunner.run(context, providerId, model, prompt, task.optString("id"))
                task.put("status", if (result.optBoolean("ok")) "done" else "error")
                task.put("output", result.optString("text"))
                task.put("error", result.optString("error"))
            } catch (t: Throwable) {
                task.put("status", "error")
                task.put("error", t.message ?: "subagent failed")
            } finally {
                task.put("finishedAt", System.currentTimeMillis())
                tasks[task.optString("id")] = task
                Notifier.emitToUi(
                    App.instance,
                    "agent.status",
                    JSONObject()
                        .put("chatId", task.optString("chatId"))
                        .put("finished", true)
                        .put("text", "Субагент завершён: " + task.optString("description"))
                )
            }
        }
    }

    fun all(): JSONObject {
        val arr = org.json.JSONArray()
        tasks.values.sortedBy { it.optLong("ts") }.forEach { arr.put(it) }
        return JSONObject().put("ok", true).put("tasks", arr)
    }
}

/**
 * Минимальный прогон субагента: один запрос без инструментов,
 * чтобы результат был предсказуемым и не блокировал родителя.
 */
object SubAgentRunner {

    fun run(context: Context, providerId: String, model: String, prompt: String, id: String): JSONObject {
        val provider = Providers.byId(context, providerId)
            ?: Providers.byId(context, "opencode")
            ?: return JSONObject().put("ok", false).put("error", "провайдер недоступен")
        val keys = Secrets.keyRing(context, provider.id)
        val key = keys.firstOrNull()
        if (provider.needsKey && key == null) {
            return JSONObject().put("ok", false).put("error", "нет ключа")
        }
        if (!Net.isOnline(context)) {
            return JSONObject().put("ok", false).put("error", "нет сети")
        }
        val body = JSONObject()
            .put("model", model)
            .put(
                "messages",
                org.json.JSONArray()
                    .put(JSONObject().put("role", "system").put("content", "Ты субагент. Отвечай кратко и по делу."))
                    .put(JSONObject().put("role", "user").put("content", prompt))
            )
            .put("stream", false)
        val url = provider.baseUrl + "/chat/completions"
        val headers = Providers.headers(provider, key).toMutableMap()
        headers["Accept"] = "application/json"
        val res = Net.json(url, "POST", headers, body.toString(), idempotent = false)
        return res.getOrElse {
            JSONObject().put("ok", false).put("error", it.message ?: "ошибка сети")
        }.let { json ->
            val choices = json.optJSONArray("choices")
            val text = choices?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: ""
            if (text.isBlank()) JSONObject().put("ok", false).put("error", "пустой ответ")
            else JSONObject().put("ok", true).put("text", text)
        }
    }
}
