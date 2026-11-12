package dev.botchat

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Уведомления агента: действия «Открыть» и «Стоп», без дублирования логики.
 */
class Notifier : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_STOP -> {
                val chatId = intent.getStringExtra("chat_id") ?: ""
                Agent.stop(chatId, "stopped from notification")
                NotificationManagerCompatHolder.cancel(context, notifyId(chatId))
                emitToUi(context, "agent.stop", JSONObject().put("chatId", chatId))
            }
            ACTION_OPEN -> {
                val target = Intent(context, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    putExtra("chat_id", intent.getStringExtra("chat_id") ?: "")
                    putExtra("action", "open")
                }
                context.startActivity(target)
            }
        }
    }

    companion object {
        const val EVENT = "dev.botchat.EVENT"
        const val ACTION_STOP = "dev.botchat.STOP_AGENT"
        const val ACTION_OPEN = "dev.botchat.OPEN_CHAT"

        fun notifyId(chatId: String): Int = (chatId.hashCode() and 0x7FFFFFFF) % 100000

        fun emitToUi(context: Context, event: String, payload: JSONObject) {
            val i = Intent(EVENT).setPackage(context.packageName)
            i.putExtra("event", event)
            i.putExtra("payload", payload.toString())
            context.sendBroadcast(i)
        }

        /**
         * Статус агента в одном уведомлении: обновляется на месте, не копится.
         */
        fun progress(context: Context, chatId: String, title: String, text: String, step: Int, total: Int): JSONObject {
            val open = PendingIntent.getBroadcast(
                context, notifyId(chatId) * 10 + 1,
                Intent(context, Notifier::class.java).apply {
                    action = ACTION_OPEN
                    putExtra("chat_id", chatId)
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val stop = PendingIntent.getBroadcast(
                context, notifyId(chatId) * 10 + 2,
                Intent(context, Notifier::class.java).apply {
                    action = ACTION_STOP
                    putExtra("chat_id", chatId)
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val builder = NotificationCompat.Builder(context, App.CH_AGENT)
                .setSmallIcon(R.drawable.ic_tile)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setContentIntent(open)
                .addAction(0, context.getString(android.R.string.cancel), stop)
            if (total > 0) {
                builder.setProgress(total, step, false)
            }
            NotificationManagerCompatHolder.notify(context, notifyId(chatId), builder.build())
            return JSONObject().put("ok", true)
        }

        fun post(context: Context, payload: JSONObject): JSONObject {
            val chatId = payload.optString("chatId", "chat")
            val title = payload.optString("title", "botCHAT")
            val text = payload.optString("text", "")
            val running = payload.optBoolean("running", false)
            val open = PendingIntent.getBroadcast(
                context, notifyId(chatId) * 10 + 1,
                Intent(context, Notifier::class.java).apply {
                    action = ACTION_OPEN
                    putExtra("chat_id", chatId)
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val builder = NotificationCompat.Builder(context, App.CH_AGENT)
                .setSmallIcon(R.drawable.ic_tile)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(!running)
                .setOngoing(running)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)

            if (running) {
                val stop = PendingIntent.getBroadcast(
                    context, notifyId(chatId) * 10 + 2,
                    Intent(context, Notifier::class.java).apply {
                        action = ACTION_STOP
                        putExtra("chat_id", chatId)
                    },
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                builder.addAction(0, context.getString(android.R.string.cancel), stop)
            }
            NotificationManagerCompatHolder.notify(context, notifyId(chatId), builder.build())
            return JSONObject().put("ok", true)
        }
    }

    internal object NotificationManagerCompatHolder {
        fun notify(context: Context, id: Int, n: Notification) {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            nm.notify(id, n)
        }

        fun cancel(context: Context, id: Int) {
            context.getSystemService(NotificationManager::class.java)?.cancel(id)
        }
    }
}