package dev.botchat

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannels()
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val agent = NotificationChannel(
                CH_AGENT,
                getString(R.string.channel_agent),
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Ход агентских задач и запросы разрешений"
                setShowBadge(true)
            }
            val errors = NotificationChannel(
                CH_ERRORS,
                getString(R.string.channel_errors),
                NotificationManager.IMPORTANCE_HIGH
            ).apply { description = "Ошибки агента и сети" }
            nm.createNotificationChannel(agent)
            nm.createNotificationChannel(errors)
        }
    }

    companion object {
        const val CH_AGENT = "agent"
        const val CH_ERRORS = "errors"
        lateinit var instance: App
            private set
    }
}