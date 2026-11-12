package dev.botchat

import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Машина состояний агентского цикла. Полная реализация — этап 4,
 * здесь фиксируются общие точки входа и реестр запущенных сессий.
 */
object Agent {

    class Session(val chatId: String) {
        @Volatile
        var cancelled = false
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    fun session(chatId: String): Session = sessions.getOrPut(chatId) { Session(chatId) }

    fun stop(chatId: String, reason: String) {
        sessions[chatId]?.cancelled = true
        sessions.remove(chatId)
        AgentService.publishStatus(chatId, 0, 0, reason)
    }

    fun publish(stateJson: String) {
        AppState.publish(stateJson)
    }

    fun status(): JSONObject = JSONObject()
        .put("ok", true)
        .put("sessions", sessions.keys.toList())
        .put("service", AgentService.isRunning)
}