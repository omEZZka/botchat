package dev.botchat.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import dev.botchat.Agent
import dev.botchat.AppState
import dev.botchat.MainActivity
import dev.botchat.R
import org.json.JSONObject

/**
 * Виджет статуса: одно состояние, никакой собственной логики.
 */
class StatusWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(context, manager, it) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_STOP) {
            val state = runCatching { JSONObject(AppState.raw()) }.getOrDefault(JSONObject())
            Agent.stop(state.optString("activeChatId", ""), "stopped from widget")
        }
    }

    private fun render(context: Context, manager: AppWidgetManager, id: Int) {
        val state = runCatching { JSONObject(AppState.raw()) }.getOrDefault(JSONObject())
        val running = state.optBoolean("agentRunning")
        val text = when {
            state.optBoolean("pendingPermission") -> "Нужно разрешение"
            running -> "Агент работает · шаг ${state.optInt("step", 0)}"
            else -> "Агент простаивает"
        }
        val views = RemoteViews(context.packageName, R.layout.widget_status)
        views.setTextViewText(R.id.widget_title, context.getString(R.string.app_name))
        views.setTextViewText(R.id.widget_text, text)
        views.setInt(
            R.id.widget_dot, "setBackgroundColor",
            when {
                state.optBoolean("pendingPermission") -> 0xFFFFB020.toInt()
                running -> 0xFF3FBF6F.toInt()
                else -> 0xFF6B7280.toInt()
            }
        )
        val open = PendingIntent.getActivity(
            context, 1,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("chat_id", state.optString("activeChatId", ""))
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        views.setOnClickPendingIntent(R.id.widget_root, open)
        val stop = PendingIntent.getBroadcast(
            context, 2,
            Intent(context, StatusWidget::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        views.setOnClickPendingIntent(R.id.widget_stop, stop)
        manager.updateAppWidget(id, views)
    }

    companion object {
        const val ACTION_STOP = "dev.botchat.widget.STOP"
    }
}