package dev.botchat

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Фоновое исполнение агентских задач: держит WakeLock и foreground-уведомление.
 * Сама машина состояний — в Agent.kt, здесь только жизненный цикл.
 */
class AgentService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        startForeground(NOTIFY_ID, buildNotification())
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "botchat:agent")?.apply {
            setReferenceCounted(false)
            acquire(30 * 60 * 1000L)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val chatId = intent.getStringExtra("chat_id") ?: ""
            Agent.stop(chatId, "stopped from service")
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running = false
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val open = android.app.PendingIntent.getBroadcast(
            this, 1,
            Intent(this, Notifier::class.java).apply {
                action = Notifier.ACTION_OPEN
                putExtra("chat_id", "")
            },
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val stop = android.app.PendingIntent.getBroadcast(
            this, 2,
            Intent(this, Notifier::class.java).apply { action = Notifier.ACTION_STOP },
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, App.CH_AGENT)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Агент работает…")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(android.R.string.cancel), stop)
            .build()
    }

    companion object {
        private const val NOTIFY_ID = 1001
        const val ACTION_STOP = "dev.botchat.service.STOP"

        @Volatile
        var running: Boolean = false
            private set

        fun start(context: android.content.Context) {
            val intent = Intent(context, AgentService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: android.content.Context) {
            context.stopService(Intent(context, AgentService::class.java))
        }

        fun publishStatus(chatId: String, step: Int, total: Int, text: String) {
            runCatching {
                Notifier.emitToUi(
                    App.instance, "agent.status",
                    JSONObject().put("chatId", chatId).put("step", step).put("total", total).put("text", text)
                )
            }
        }
    }
}