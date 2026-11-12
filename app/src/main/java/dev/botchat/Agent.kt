package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Машина состояний агента: план → вызов инструмента → результат → продолжение.
 * Состояние сериализуется в файл и переживает перезапуск процесса;
 * каждый шаг дописывается в steps.jsonl (append-only, атомарная строка).
 */
object Agent {

    enum class Phase { IDLE, PLAN, TOOL, WAIT, PAUSED, DONE, ERROR }

    class Session(val chatId: String) {
        val cancelled = AtomicBoolean(false)
        @Volatile
        var paused = false
        val step = AtomicInteger(0)
        @Volatile
        var limit: Int = 30
        @Volatile
        var phase: Phase = Phase.IDLE
        @Volatile
        var label: String = ""
        @Volatile
        var startedAt: Long = 0
        @Volatile
        var updatedAt: Long = System.currentTimeMillis()
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    fun session(chatId: String): Session = sessions.getOrPut(chatId) { Session(chatId) }

    fun begin(context: Context, chatId: String, limit: Int): JSONObject {
        val session = session(chatId)
        session.cancelled.set(false)
        session.paused = false
        session.step.set(0)
        session.limit = limit.coerceIn(1, 200)
        session.phase = Phase.PLAN
        session.label = "план"
        session.startedAt = System.currentTimeMillis()
        session.updatedAt = session.startedAt
        Steps.append(context, chatId, Steps.event("run.begin").put("limit", session.limit))
        persist(context, session)
        AgentService.publishStatus(chatId, 0, session.limit, "план")
        return stateOf(session)
    }

    fun step(context: Context, chatId: String, name: String, input: JSONObject?, output: String?, status: String): JSONObject {
        val session = session(chatId)
        val index = session.step.incrementAndGet()
        session.phase = if (status == "error") Phase.ERROR else Phase.TOOL
        session.label = name
        session.updatedAt = System.currentTimeMillis()
        Steps.append(
            context,
            chatId,
            Steps.event("tool")
                .put("step", index)
                .put("name", name)
                .put("input", input ?: JSONObject())
                .put("output", (output ?: "").take(8000))
                .put("status", status)
        )
        persist(context, session)
        AgentService.publishStatus(chatId, index, session.limit, name)
        return stateOf(session)
    }

    fun pause(chatId: String): JSONObject {
        val session = sessions[chatId] ?: return JSONObject().put("ok", false)
        session.paused = true
        session.phase = Phase.PAUSED
        return stateOf(session)
    }

    fun resume(context: Context, chatId: String): JSONObject {
        val session = sessions[chatId] ?: return JSONObject().put("ok", false)
        session.paused = false
        session.phase = Phase.TOOL
        Steps.append(context, chatId, Steps.event("run.resume").put("step", session.step.get()))
        return stateOf(session)
    }

    fun stop(chatId: String, reason: String) {
        sessions[chatId]?.let { session ->
            session.cancelled.set(true)
            session.phase = Phase.DONE
            session.label = reason
            Steps.append(App.instance, chatId, Steps.event("run.stop").put("reason", reason))
            persist(App.instance, session)
            session.paused = false
        }
        sessions.remove(chatId)
        AgentService.publishStatus(chatId, 0, 0, reason)
    }

    fun finish(context: Context, chatId: String) {
        val session = sessions[chatId] ?: return
        session.phase = Phase.DONE
        session.label = "готово"
        Steps.append(context, chatId, Steps.event("run.done").put("step", session.step.get()))
        persist(context, session)
        sessions.remove(chatId)
    }

    fun publish(stateJson: String) {
        AppState.publish(stateJson)
    }

    fun status(): JSONObject = JSONObject()
        .put("ok", true)
        .put("sessions", JSONArray(sessions.keys.toList()))
        .put("service", AgentService.running)

    fun stateOf(session: Session): JSONObject = JSONObject()
        .put("ok", true)
        .put("chatId", session.chatId)
        .put("step", session.step.get())
        .put("limit", session.limit)
        .put("phase", session.phase.name.lowercase())
        .put("paused", session.paused)
        .put("cancelled", session.cancelled.get())
        .put("label", session.label)

    /** Восстановление после перезапуска: читает последнее состояние сессии. */
    fun restore(context: Context, chatId: String): JSONObject {
        val file = File(Tools.chatRoot(context, chatId), "agent.json")
        if (!file.exists()) return JSONObject().put("ok", false)
        return runCatching { JSONObject(file.readText()) }.getOrElse {
            JSONObject().put("ok", false).put("error", "state corrupted")
        }.put("ok", true)
    }

    private fun persist(context: Context, session: Session) {
        runCatching {
            val file = File(Tools.chatRoot(context, session.chatId), "agent.json")
            val tmp = File(file.parentFile, ".agent.json.tmp")
            tmp.writeText(stateOf(session).toString())
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
        }
    }
}

/**
 * Append-only журнал шагов: одна строка — один JSON-объект.
 * Хвост читается при восстановлении и экспорте отчёта.
 */
object Steps {

    private const val FILE = "steps.jsonl"
    private const val MAX_BYTES = 2L * 1024 * 1024

    fun event(type: String): JSONObject = JSONObject()
        .put("type", type)
        .put("ts", System.currentTimeMillis())

    @Synchronized
    fun append(context: Context, chatId: String, event: JSONObject) {
        runCatching {
            val file = File(Tools.chatRoot(context, chatId), FILE)
            if (file.exists() && file.length() > MAX_BYTES) {
                val backup = File(file.parentFile, "$FILE.1")
                if (backup.exists()) backup.delete()
                file.renameTo(backup)
            }
            file.appendText(event.toString() + "\n")
        }
    }

    fun tail(context: Context, chatId: String, limit: Int = 200): JSONArray {
        val file = File(Tools.chatRoot(context, chatId), FILE)
        if (!file.exists()) return JSONArray()
        val lines = runCatching { file.readLines() }.getOrDefault(emptyList())
        val arr = JSONArray()
        lines.takeLast(limit.coerceIn(1, 2000)).forEach { line ->
            runCatching { arr.put(JSONObject(line)) }
        }
        return arr
    }

    fun report(context: Context, chatId: String): JSONObject {
        val events = tail(context, chatId, 1000)
        val out = JSONObject()
            .put("chatId", chatId)
            .put("steps", events.length())
            .put("events", events)
        return JSONObject().put("ok", true).put("report", out)
    }
}