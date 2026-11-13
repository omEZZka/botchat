package dev.botchat

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Рабочие области агента.
 *
 *  - `sandbox` — изолированная папка чата (по умолчанию): безопасно, ничего не сломать.
 *  - `device`  — общая память устройства (/storage/emulated/0) при выданном доступе.
 *  - `custom`  — конкретная папка на устройстве.
 *
 * Пути резолвятся только внутри разрешённых корней: `..` и абсолютные пути
 * вне корней отклоняются.
 */
object Storage {

    private const val PREFS = "bc_storage"

    fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Корень песочницы конкретного чата. */
    fun sandboxRoot(context: Context, chatId: String): File = Tools.chatRoot(context, chatId)

    fun deviceRoot(): File = Environment.getExternalStorageDirectory()

    fun hasAllFilesAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                App.instance,
                Manifest.permission.READ_EXTERNAL_STORAGE
            ) == PackageManager.PERMISSION_GRANTED
        }
    }

    /** Режим для чата: sandbox | device | custom. */
    fun scope(context: Context, chatId: String): String =
        prefs(context).getString("scope:$chatId", "sandbox") ?: "sandbox"

    fun setScope(context: Context, chatId: String, scope: String, customPath: String = "") {
        prefs(context).edit().apply {
            putString("scope:$chatId", scope)
            if (customPath.isNotBlank()) putString("custom:$chatId", customPath)
            else remove("custom:$chatId")
        }.apply()
    }

    fun customPath(context: Context, chatId: String): String =
        prefs(context).getString("custom:$chatId", "") ?: ""

    /** Активный корень чата (первый в списке разрешённых). */
    fun activeRoot(context: Context, chatId: String): File {
        return when (scope(context, chatId)) {
            "device" -> if (hasAllFilesAccess()) deviceRoot() else sandboxRoot(context, chatId)
            "custom" -> {
                val path = customPath(context, chatId)
                val dir = if (path.isBlank()) null else File(path)
                if (dir != null && dir.isDirectory && hasAllFilesAccess()) dir
                else sandboxRoot(context, chatId)
            }
            else -> sandboxRoot(context, chatId)
        }
    }

    /** Все корни, куда агенту разрешено писать и читать. */
    fun roots(context: Context, chatId: String): List<File> {
        val list = ArrayList<File>()
        list.add(sandboxRoot(context, chatId))
        if (hasAllFilesAccess()) {
            val scope = scope(context, chatId)
            if (scope == "device") list.add(deviceRoot())
            if (scope == "custom") {
                val path = customPath(context, chatId)
                if (path.isNotBlank()) {
                    val dir = File(path)
                    if (dir.isDirectory) list.add(dir)
                }
            }
        }
        return list
    }

    /**
     * Приводит путь к файлу внутри разрешённых корней.
     * `relative` — от активного корня; `/sdcard/...` и `/storage/emulated/0/...` — от памяти.
     */
    fun resolve(context: Context, chatId: String, path: String): File? {
        val roots = roots(context, chatId)
        if (roots.isEmpty()) return null
        val trimmed = path.trim()
        if (trimmed.isEmpty() || trimmed == "." || trimmed == "/") return roots.first()

        val normalized = trimmed
            .removePrefix("/sdcard")
            .removePrefix("/storage/emulated/0")

        val candidates = ArrayList<File>()
        if (trimmed.startsWith("/sdcard") || trimmed.startsWith("/storage/emulated/0")) {
            candidates.add(File(deviceRoot(), normalized.trimStart('/')))
        } else if (trimmed.startsWith("/")) {
            candidates.add(File(trimmed))
        } else {
            candidates.add(File(roots.first(), trimmed))
            if (roots.size > 1) candidates.add(File(roots[1], trimmed))
        }

        for (candidate in candidates) {
            val canonical = runCatching { candidate.canonicalFile }.getOrNull() ?: continue
            for (root in roots) {
                val base = runCatching { root.canonicalFile }.getOrNull() ?: continue
                if (canonical == base) return canonical
                if (canonical.path.startsWith(base.path + File.separator)) return canonical
            }
        }
        return null
    }

    fun info(context: Context, chatId: String): JSONObject {
        val scope = scope(context, chatId)
        val roots = JSONArray()
        roots(context, chatId).forEach { roots.put(it.absolutePath) }
        return JSONObject()
            .put("ok", true)
            .put("scope", scope)
            .put("customPath", customPath(context, chatId))
            .put("allFiles", hasAllFilesAccess())
            .put("roots", roots)
            .put("deviceRoot", deviceRoot().absolutePath)
            .put("sandbox", sandboxRoot(context, chatId).absolutePath)
            .put("active", activeRoot(context, chatId).absolutePath)
    }

    /** Открывает системный экран «Доступ ко всем файлам». */
    fun requestAllFiles(context: Context): JSONObject {
        if (hasAllFilesAccess()) return JSONObject().put("ok", true).put("granted", true)
        return try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:" + context.packageName)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:" + context.packageName)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            context.startActivity(intent)
            JSONObject().put("ok", true).put("granted", false).put("opened", true)
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Не удалось открыть настройки")
        }
    }

    /** Создаёт папку в выбранном корне и возвращает путь. */
    fun ensureDir(context: Context, chatId: String, path: String): JSONObject {
        val dir = resolve(context, chatId, path)
            ?: return JSONObject().put("ok", false).put("error", "Путь вне разрешённых папок")
        val ok = dir.exists() || dir.mkdirs()
        return JSONObject().put("ok", ok).put("path", dir.absolutePath)
    }
}
