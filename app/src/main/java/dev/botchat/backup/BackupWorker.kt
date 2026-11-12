package dev.botchat.backup

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import dev.botchat.Backup
import java.io.File

/**
 * Периодический бэкап настроек (без ключей) в files/backups.
 */
class BackupWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        return try {
            val dir = File(applicationContext.filesDir, "backups").apply { mkdirs() }
            val payload = Backup.exportSettings(applicationContext).toString()
            val target = File(dir, "settings-${System.currentTimeMillis()}.json")
            val tmp = File(dir, ".${target.name}.tmp")
            tmp.writeText(payload)
            if (!tmp.renameTo(target)) return Result.retry()
            prune(dir)
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        } finally {
            System.gc()
        }
    }

    private fun prune(dir: File) {
        val files = dir.listFiles()?.sortedByDescending { it.lastModified() } ?: return
        files.drop(10).forEach { it.delete() }
    }
}