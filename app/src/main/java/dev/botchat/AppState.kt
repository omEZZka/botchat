package dev.botchat

import android.content.Context
import org.json.JSONObject

/**
 * Единый снимок состояния для фоновых поверхностей. Логику не дублирует:
 * источник истины — UI, который публикует состояние через Bridge.
 */
object AppState {

    @Volatile
    private var last: String = "{}"

    fun publish(json: String) {
        last = if (json.isBlank()) "{}" else json
    }

    fun raw(): String = last

    fun snapshot(context: Context): JSONObject {
        val base = runCatching { JSONObject(last) }.getOrDefault(JSONObject())
        return base
            .put("ok", true)
            .put("rootfs", Runtime.rootfsReady())
            .put("agentService", AgentService.running)
            .put("ts", System.currentTimeMillis())
    }
}