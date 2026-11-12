package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Профили с изоляцией: каждый профиль — отдельный корень рабочей области.
 * Переключение профиля не затрагивает файлы другого профиля.
 */
object Profiles {

    private const val PREFS = "bc_profiles"
    private const val KEY_ACTIVE = "active"
    private const val KEY_LIST = "list"

    fun active(context: Context): String {
        val value = prefs(context).getString(KEY_ACTIVE, "default") ?: "default"
        return sanitize(value)
    }

    fun setActive(context: Context, id: String): JSONObject {
        val clean = sanitize(id)
        prefs(context).edit().putString(KEY_ACTIVE, clean).apply()
        return JSONObject().put("ok", true).put("active", clean)
    }

    fun list(context: Context): JSONArray {
        val stored = prefs(context).getString(KEY_LIST, null)
        if (stored == null) {
            val arr = JSONArray()
            arr.put(JSONObject().put("id", "default").put("name", "Профиль по умолчанию"))
            prefs(context).edit().putString(KEY_LIST, arr.toString()).apply()
            return arr
        }
        return runCatching { JSONArray(stored) }.getOrDefault(JSONArray())
    }

    fun add(context: Context, id: String, name: String): JSONObject {
        val clean = sanitize(id)
        if (clean.isBlank()) return JSONObject().put("ok", false).put("error", "Некорректный id")
        val arr = list(context)
        for (i in 0 until arr.length()) {
            if (arr.getJSONObject(i).optString("id") == clean) {
                return JSONObject().put("ok", false).put("error", "Профиль уже существует")
            }
        }
        arr.put(JSONObject().put("id", clean).put("name", name.ifBlank { clean }))
        prefs(context).edit().putString(KEY_LIST, arr.toString()).apply()
        File(workspaceBase(context), clean).mkdirs()
        return JSONObject().put("ok", true).put("id", clean)
    }

    fun workspaceBase(context: Context): File =
        File(context.filesDir, "workspace").apply { mkdirs() }

    fun root(context: Context): File =
        File(workspaceBase(context), active(context)).apply { mkdirs() }

    private fun sanitize(value: String): String =
        value.lowercase().replace(Regex("[^a-z0-9_-]"), "").take(32).ifBlank { "default" }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
