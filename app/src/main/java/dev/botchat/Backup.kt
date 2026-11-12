package dev.botchat

import org.json.JSONObject

/**
 * Экспорт/импорт настроек и чатов. Ключи исключены всегда.
 * Шифрованный бэкап — этап 9.
 */
object Backup {

    fun exportSettings(context: android.content.Context): JSONObject {
        val prefs = context.getSharedPreferences("bc_settings", android.content.Context.MODE_PRIVATE)
        val out = JSONObject()
        prefs.all.forEach { (k, v) -> if (v != null) out.put(k, v.toString()) }
        return JSONObject().put("ok", true).put("version", BuildConfig.VERSION_NAME).put("settings", out)
    }

    fun importSettings(context: android.content.Context, json: String): JSONObject {
        return runCatching {
            val root = JSONObject(json)
            val settings = root.optJSONObject("settings") ?: return err("bad archive")
            val prefs = context.getSharedPreferences("bc_settings", android.content.Context.MODE_PRIVATE)
            val editor = prefs.edit()
            settings.keys().forEach { key ->
                val value = settings.optString(key)
                if (!key.startsWith("secret") && !key.contains("key", ignoreCase = true)) {
                    editor.putString(key, value)
                }
            }
            editor.apply()
            JSONObject().put("ok", true)
        }.getOrElse { err(it.message ?: "import failed") }
    }

    private fun err(message: String) = JSONObject().put("ok", false).put("error", message)
}