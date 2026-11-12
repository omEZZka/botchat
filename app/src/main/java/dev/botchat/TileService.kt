package dev.botchat

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import org.json.JSONObject

/**
 * QS-плитка: показывает статус агента и открывает приложение.
 * Логику не дублирует — читает AppState.
 */
class TileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        render()
    }

    override fun onClick() {
        super.onClick()
        val state = runCatching { JSONObject(AppState.raw()) }.getOrDefault(JSONObject())
        if (state.optBoolean("agentRunning")) {
            val chatId = state.optString("activeChatId", "")
            Agent.stop(chatId, "stopped from tile")
            state.put("agentRunning", false)
            AppState.publish(state.toString())
        } else {
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("action", "new_chat")
            }
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
        }
        render()
    }

    private fun render() {
        val state = runCatching { JSONObject(AppState.raw()) }.getOrDefault(JSONObject())
        val running = state.optBoolean("agentRunning")
        val pending = state.optBoolean("pendingPermission")
        qsTile?.apply {
            state = if (running) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            label = when {
                running -> "Агент работает"
                pending -> "Нужно разрешение"
                else -> getString(R.string.tile_label)
            }
            if (Build.VERSION.SDK_INT >= 29) {
                subtitle = if (running) "шаг ${state.optInt("step", 0)}" else "простой"
            }
            icon = Icon.createWithResource(this@TileService, R.drawable.ic_tile)
            updateTile()
        }
    }

    companion object {
        fun requestRefresh(context: android.content.Context) {
            runCatching {
                requestListeningState(
                    context,
                    android.content.ComponentName(context, TileService::class.java)
                )
            }
        }
    }
}
