package dev.botchat

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Файловый слой приложения. Все пути, приходящие из UI, проходят через песочницу:
 * рабочая область чатов живёт в files/workspace, временные и служебные данные — внутри files.
 */
object Fs {

    private const val MAX_TEXT = 512 * 1024

    fun workspaceRoot(): File = Profiles.root(App.instance).apply { mkdirs() }

    fun root(chatId: String = ""): File {
        val safe = chatId.replace(Regex("[^A-Za-z0-9_-]"), "_").ifBlank { "default" }
        return File(workspaceRoot(), safe).apply { mkdirs() }
    }

    fun chatsDir(): File = File(workspaceRoot(), ".chats").apply { mkdirs() }

    fun attachmentsDir(): File = File(App.instance.filesDir, "attachments").apply { mkdirs() }

    fun settingsDir(): File = File(App.instance.filesDir, "settings").apply { mkdirs() }

    /** Приводит пользовательский путь к абсолютному внутри песочницы или возвращает null. */
    fun canonicalPath(path: String, base: File = root()): File? {
        val raw = if (path.isBlank() || path == "." || path == "~") base.absolutePath else path
        val candidate = if (raw.startsWith("/")) File(raw) else File(base, raw)
        val canonical = runCatching { candidate.canonicalFile }.getOrNull() ?: return null
        val baseCanonical = runCatching { base.canonicalFile }.getOrNull() ?: return null
        if (canonical == baseCanonical) return canonical
        if (!canonical.path.startsWith(baseCanonical.path + File.separator)) return null
        return canonical
    }

    fun info(path: String, chatId: String = ""): JSONObject {
        val f = canonicalPath(path, root(chatId)) ?: return err("path outside sandbox")
        return if (!f.exists()) {
            JSONObject().put("ok", false).put("error", "not found").put("exists", false)
        } else {
            JSONObject()
                .put("ok", true)
                .put("exists", true)
                .put("isDir", f.isDirectory)
                .put("size", f.length())
                .put("mtime", f.lastModified())
                .put("path", f.absolutePath)
        }
    }

    fun list(path: String, chatId: String = ""): JSONObject {
        val f = canonicalPath(path, root(chatId)) ?: return err("path outside sandbox")
        if (!f.isDirectory) return err("not a directory")
        val arr = JSONArray()
        f.listFiles()?.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))?.forEach { c ->
            arr.put(
                JSONObject()
                    .put("name", c.name)
                    .put("isDir", c.isDirectory)
                    .put("size", c.length())
                    .put("mtime", c.lastModified())
            )
        }
        return JSONObject().put("ok", true).put("path", f.absolutePath).put("items", arr)
    }

    fun readText(path: String, maxBytes: Int, chatId: String = ""): JSONObject {
        val f = canonicalPath(path, root(chatId)) ?: return err("path outside sandbox")
        if (!f.isFile) return err("not a file")
        val limit = maxBytes.coerceIn(1, 8 * 1024 * 1024)
        val len = minOf(f.length(), limit.toLong()).toInt()
        val bytes = ByteArray(len)
        f.inputStream().use { it.read(bytes) }
        return JSONObject()
            .put("ok", true)
            .put("text", String(bytes, Charsets.UTF_8))
            .put("truncated", f.length() > limit)
            .put("size", f.length())
            .put("mtime", f.lastModified())
    }

    fun writeText(path: String, text: String, chatId: String = ""): JSONObject {
        val f = canonicalPath(path, root(chatId)) ?: return err("path outside sandbox")
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, ".${f.name}.tmp")
        FileOutputStream(tmp).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        Files.move(
            tmp.toPath(), f.toPath(),
            StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE
        )
        return JSONObject().put("ok", true).put("size", f.length()).put("path", f.absolutePath)
    }

    fun mkdir(path: String, chatId: String = ""): JSONObject {
        val f = canonicalPath(path, root(chatId)) ?: return err("path outside sandbox")
        return JSONObject().put("ok", f.mkdirs() || f.isDirectory)
    }

    fun delete(path: String, chatId: String = ""): JSONObject {
        val base = root(chatId)
        val f = canonicalPath(path, base) ?: return err("path outside sandbox")
        if (f == base) return err("cannot delete chat root")
        return JSONObject().put("ok", f.deleteRecursively())
    }

    fun importAttachment(uri: Uri, name: String): File {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifBlank { "file" }
        val target = File(attachmentsDir(), "${System.currentTimeMillis()}-$safe")
        App.instance.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(target).use { out -> input.copyTo(out) }
        }
        return target
    }

    private fun err(message: String) = JSONObject().put("ok", false).put("error", message)
}