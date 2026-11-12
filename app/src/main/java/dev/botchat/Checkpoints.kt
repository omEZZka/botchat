package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Shadow-git чекпоинты: снимок рабочей папки чата перед первым изменением файлов.
 * Реализовано без внешнего git: манифест + копии файлов, атомарная запись.
 */
object Checkpoints {

    private const val DIR = ".checkpoints"
    private const val MAX_SNAPSHOTS = 20

    private fun dir(root: File): File = File(root, DIR).apply { mkdirs() }

    private var lastSnapshotAt = 0L
    private const val DEDUP_MS = 20_000L

    /** Снимок перед первым изменением файлов в серии: повторные вызовы в окне дедупа пропускаются. */
    fun snapshot(root: File, reason: String): JSONObject? {
        val now = System.currentTimeMillis()
        synchronized(this) {
            if (now - lastSnapshotAt < DEDUP_MS) return null
            lastSnapshotAt = now
        }
        return runCatching {
            val base = dir(root)
            val id = "cp" + System.currentTimeMillis()
            val target = File(base, id).apply { mkdirs() }
            val manifest = JSONObject()
                .put("id", id)
                .put("ts", System.currentTimeMillis())
                .put("reason", reason)
            val files = JSONArray()
            root.walkTopDown()
                .onEnter { it.name != DIR && !it.name.startsWith(".git") }
                .forEach { f ->
                    if (!f.isFile) return@forEach
                    if (f.name.endsWith(".tmp")) return@forEach
                    val rel = f.relativeTo(root).path
                    val copy = File(target, rel)
                    copy.parentFile?.mkdirs()
                    f.copyTo(copy, overwrite = true)
                    files.put(
                        JSONObject()
                            .put("path", rel)
                            .put("size", f.length())
                    )
                }
            manifest.put("files", files)
            val manifestTmp = File(target, "manifest.json.tmp")
            manifestTmp.writeText(manifest.toString())
            Files.move(
                manifestTmp.toPath(),
                File(target, "manifest.json").toPath(),
                StandardCopyOption.REPLACE_EXISTING
            )
            prune(base)
            manifest
        }.getOrNull()
    }

    fun list(context: Context, chatId: String): JSONObject {
        val root = Tools.chatRoot(context, chatId)
        val base = dir(root)
        val arr = JSONArray()
        base.listFiles()?.filter { it.isDirectory }?.sortedByDescending { it.name }?.forEach { folder ->
            val manifest = File(folder, "manifest.json")
            if (!manifest.exists()) return@forEach
            runCatching {
                val json = JSONObject(manifest.readText())
                arr.put(
                    JSONObject()
                        .put("id", json.optString("id"))
                        .put("ts", json.optLong("ts"))
                        .put("reason", json.optString("reason"))
                        .put("files", json.optJSONArray("files")?.length() ?: 0)
                )
            }
        }
        return JSONObject().put("ok", true).put("items", arr)
    }

    fun restore(context: Context, chatId: String, id: String): JSONObject {
        val root = Tools.chatRoot(context, chatId)
        val target = File(dir(root), id)
        if (!target.isDirectory) return JSONObject().put("ok", false).put("error", "чекпоинт не найден")
        val manifestFile = File(target, "manifest.json")
        if (!manifestFile.exists()) return JSONObject().put("ok", false).put("error", "манифест повреждён")
        return runCatching {
            val manifest = JSONObject(manifestFile.readText())
            val files = manifest.optJSONArray("files") ?: JSONArray()
            val expected = HashSet<String>()
            for (i in 0 until files.length()) {
                val item = files.getJSONObject(i)
                val rel = item.optString("path")
                expected.add(rel)
                val source = File(target, rel)
                if (!source.isFile) continue
                val dest = File(root, rel)
                dest.parentFile?.mkdirs()
                val tmp = File(dest.parentFile, ".${dest.name}.restore")
                source.copyTo(tmp, overwrite = true)
                Files.move(tmp.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            root.walkTopDown()
                .onEnter { it.name != DIR }
                .filter { it.isFile }
                .forEach { f ->
                    val rel = f.relativeTo(root).path
                    if (!expected.contains(rel) && !rel.startsWith(DIR)) f.delete()
                }
            JSONObject().put("ok", true).put("restored", expected.size)
        }.getOrElse {
            JSONObject().put("ok", false).put("error", it.message ?: "restore failed")
        }
    }

    fun latest(root: File): JSONObject? {
        val base = dir(root)
        val folder = base.listFiles()?.filter { it.isDirectory }?.maxByOrNull { it.name } ?: return null
        return runCatching { JSONObject(File(folder, "manifest.json").readText()) }.getOrNull()
    }

    private fun prune(base: File) {
        val folders = base.listFiles()?.filter { it.isDirectory }?.sortedByDescending { it.name } ?: return
        folders.drop(MAX_SNAPSHOTS).forEach { it.deleteRecursively() }
    }
}