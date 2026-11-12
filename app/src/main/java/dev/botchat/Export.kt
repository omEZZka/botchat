package dev.botchat

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Экспорт данных: настройки (без ключей) и все чаты.
 */
object Export {

    fun data(context: Context, kind: String): JSONObject {
        val payload = when (kind) {
            "chats" -> JSONObject().put("format", "botchat.chats").put("version", 1)
                .put("root", Tools.chatRoot(context, "all").parentFile?.absolutePath ?: "")
            else -> Backup.exportSettings(context)
        }
        val dir = File(context.getExternalFilesDir(null), "exports").apply { mkdirs() }
        val name = if (kind == "chats") "chats.json" else "settings.json"
        val file = File(dir, name)
        val tmp = File(dir, ".$name.tmp")
        tmp.writeText(payload.toString())
        if (!tmp.renameTo(file)) {
            tmp.copyTo(file, overwrite = true)
            tmp.delete()
        }
        return JSONObject().put("ok", true).put("path", file.absolutePath)
    }
}
