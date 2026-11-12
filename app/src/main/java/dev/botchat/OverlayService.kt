package dev.botchat

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.graphics.PixelFormat
import android.os.IBinder
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat

/**
 * Плавающий индикатор: только цветовой маркер статуса, без действий и логики.
 */
class OverlayService : Service() {

    private var view: View? = null
    private var params: WindowManager.LayoutParams? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFY_ID, notification())
        addIndicator()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HIDE -> removeIndicator()
            ACTION_SET_COLOR -> applyColor(intent.getIntExtra("color", 0xFF5B8CFF.toInt()))
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        removeIndicator()
        super.onDestroy()
    }

    private fun notification(): Notification =
        NotificationCompat.Builder(this, App.CH_AGENT)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("botCHAT")
            .setContentText("Индикатор агента")
            .setOngoing(true)
            .setSilent(true)
            .build()

    private fun addIndicator() {
        if (view != null) return
        isVisible = true
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val dot = View(this).apply {
            setBackgroundColor(0xFF5B8CFF.toInt())
        }
        val size = (12 * resources.displayMetrics.density).toInt()
        val container = FrameLayout(this).apply {
            setPadding(size / 3, size / 3, size / 3, size / 3)
            addView(dot, FrameLayout.LayoutParams(size, size))
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = size
            y = size * 6
        }
        runCatching { wm.addView(container, lp) }
        view = container
        params = lp
    }

    private fun removeIndicator() {
        val v = view ?: return
        runCatching { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(v) }
        view = null
        params = null
        isVisible = false
    }

    private fun applyColor(color: Int) {
        val container = view as? FrameLayout ?: return
        val dot = container.getChildAt(0) ?: return
        dot.alpha = if (color == 0) 0f else 1f
        if (color != 0) dot.setBackgroundColor(color)
    }

    companion object {
        @Volatile
        var isVisible: Boolean = false
            private set

        fun setColor(color: Int) {
            val intent = Intent(App.instance, OverlayService::class.java).apply {
                action = ACTION_SET_COLOR
                putExtra("color", color)
            }
            runCatching { App.instance.startService(intent) }
        }

        private const val NOTIFY_ID = 1002
        const val ACTION_HIDE = "dev.botchat.overlay.HIDE"
        const val ACTION_SET_COLOR = "dev.botchat.overlay.COLOR"

        fun start(context: android.content.Context) {
            context.startForegroundService(Intent(context, OverlayService::class.java))
        }

        fun hide(context: android.content.Context) {
            context.stopService(Intent(context, OverlayService::class.java))
        }
    }
}