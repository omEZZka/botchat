package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Исполнитель инструментов. Файловые операции — только внутри песочницы чата,
 * bash — через proot, grep/glob — нативно на Kotlin.
 */
object Tools {

    private const val MAX_READ = 512 * 1024
    private const val MAX_OUTPUT = 256 * 1024

    fun schemaOpenAI(): JSONArray {
        val arr = JSONArray()
        defs().forEach { (name, def) -> arr.put(openAiTool(name, def)) }
        return arr
    }

    fun schemaAnthropic(): JSONArray {
        val arr = JSONArray()
        defs().forEach { (name, def) ->
            arr.put(
                JSONObject()
                    .put("name", name)
                    .put("description", def.description)
                    .put("input_schema", def.schema)
            )
        }
        return arr
    }

    fun schemaGemini(): JSONArray {
        val arr = JSONArray()
        defs().forEach { (name, def) ->
            arr.put(
                JSONObject()
                    .put("name", name)
                    .put("description", def.description)
                    .put("parameters", def.schema)
            )
        }
        return arr
    }

    private fun openAiTool(name: String, def: ToolDef): JSONObject {
        return JSONObject()
            .put("type", "function")
            .put(
                "function",
                JSONObject()
                    .put("name", name)
                    .put("description", def.description)
                    .put("parameters", def.schema)
            )
    }

    class ToolDef(val description: String, val schema: JSONObject)

    private fun obj(vararg pairs: Pair<String, String>): JSONObject {
        val props = JSONObject()
        val required = JSONArray()
        pairs.forEach { (key, type) ->
            props.put(key, JSONObject().put("type", type))
            required.put(key)
        }
        return JSONObject()
            .put("type", "object")
            .put("properties", props)
            .put("required", required)
    }

    private fun defs(): Map<String, ToolDef> {
        val map = LinkedHashMap<String, ToolDef>()
        map["read"] = ToolDef(
            "Прочитать файл проекта. Возвращает текст и число строк.",
            obj("path" to "string")
        )
        map["write"] = ToolDef(
            "Записать файл целиком. Требует разрешения.",
            obj("path" to "string", "content" to "string")
        )
        map["edit"] = ToolDef(
            "Заменить фрагмент файла: oldString на newString. Требует разрешения.",
            obj("path" to "string", "oldString" to "string", "newString" to "string")
        )
        map["bash"] = ToolDef(
            "Выполнить команду в rootfs через proot. Требует разрешения.",
            obj("command" to "string")
        )
        map["grep"] = ToolDef(
            "Поиск по содержимому файлов проекта.",
            obj("pattern" to "string")
        )
        map["glob"] = ToolDef(
            "Поиск файлов по шаблону, например **/*.kt.",
            obj("pattern" to "string")
        )
        map["list"] = ToolDef(
            "Список файлов в папке проекта.",
            obj("path" to "string")
        )
        map["webfetch"] = ToolDef(
            "Загрузить URL и вернуть текст. Требует разрешения (сеть).",
            obj("url" to "string")
        )
        map["todo"] = ToolDef(
            "Обновить план задачи: массив пунктов с полями text и status.",
            JSONObject()
                .put("type", "object")
                .put("properties", JSONObject().put("items", JSONObject().put("type", "array")))
                .put("required", JSONArray().put("items"))
        )
        map["task"] = ToolDef(
            "Запустить субагента с отдельной моделью и промптом.",
            obj("description" to "string", "prompt" to "string")
        )
        return map
    }

    fun run(context: Context, chatId: String, name: String, args: JSONObject): JSONObject {
        val root = chatRoot(context, chatId)
        return try {
            when (name) {
                "read" -> read(root, args)
                "write" -> write(root, args)
                "edit" -> edit(root, args)
                "bash" -> bash(context, root, args)
                "grep" -> grep(root, args)
                "glob" -> glob(root, args)
                "list" -> list(root, args)
                "webfetch" -> webfetch(args)
                "todo" -> todo(args)
                "task" -> task(context, args)
                else -> err("неизвестный инструмент: $name")
            }
        } catch (t: Throwable) {
            err(t.message ?: t.javaClass.simpleName)
        }
    }

    fun chatRoot(context: Context, chatId: String): File {
        val safe = chatId.replace(Regex("[^A-Za-z0-9_-]"), "_").ifBlank { "default" }
        return File(context.filesDir, "workspace/$safe").apply { mkdirs() }
    }

    private fun resolve(root: File, path: String): File? {
        val raw = if (path.isBlank() || path == "." || path == "/") root.absolutePath else path
        val candidate = if (raw.startsWith("/")) File(raw) else File(root, raw)
        val canonical = runCatching { candidate.canonicalFile }.getOrNull() ?: return null
        val base = runCatching { root.canonicalFile }.getOrNull() ?: return null
        if (canonical == base) return canonical
        return if (canonical.path.startsWith(base.path + File.separator)) canonical else null
    }

    private fun read(root: File, args: JSONObject): JSONObject {
        val f = resolve(root, args.optString("path")) ?: return err("путь вне проекта")
        if (!f.isFile) return err("файл не найден")
        val bytes = ByteArray(minOf(f.length(), MAX_READ.toLong()).toInt())
        f.inputStream().use { input ->
            var offset = 0
            while (offset < bytes.size) {
                val read = input.read(bytes, offset, bytes.size - offset)
                if (read <= 0) break
                offset += read
            }
        }
        val text = String(bytes, Charsets.UTF_8)
        val lines = text.count { it == '\n' } + 1
        return JSONObject()
            .put("ok", true)
            .put("output", text)
            .put("metadata", JSONObject().put("lines", lines).put("path", f.absolutePath))
    }

    private fun write(root: File, args: JSONObject): JSONObject {
        val f = resolve(root, args.optString("path")) ?: return err("путь вне проекта")
        Checkpoints.snapshot(root, "write: " + f.name)
        f.parentFile?.mkdirs()
        val content = args.optString("content")
        val tmp = File(f.parentFile, ".${f.name}.tmp")
        tmp.writeText(content)
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING)
        return JSONObject()
            .put("ok", true)
            .put("output", "Записано ${content.length} байт")
            .put("metadata", JSONObject().put("bytes", content.length))
    }

    private fun edit(root: File, args: JSONObject): JSONObject {
        val f = resolve(root, args.optString("path")) ?: return err("путь вне проекта")
        if (!f.isFile) return err("файл не найден")
        val old = args.optString("oldString")
        val new = args.optString("newString")
        if (old.isEmpty()) return err("пустой oldString")
        val text = f.readText()
        if (!text.contains(old)) return err("фрагмент не найден")
        Checkpoints.snapshot(root, "edit: " + f.name)
        val replaced = text.replaceFirst(old, new)
        val tmp = File(f.parentFile, ".${f.name}.tmp")
        tmp.writeText(replaced)
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING)
        val beforeLines = text.lines().size
        val afterLines = replaced.lines().size
        val added = countAdded(old, new)
        val removed = countRemoved(old, new)
        return JSONObject()
            .put("ok", true)
            .put("output", "Изменено: +${added}/-${removed}")
            .put(
                "metadata",
                JSONObject()
                    .put("added", added)
                    .put("removed", removed)
                    .put("diff", makeDiff(old, new))
                    .put("linesBefore", beforeLines)
                    .put("linesAfter", afterLines)
            )
    }

    private fun countAdded(old: String, new: String): Int {
        val newLines = new.lines()
        val oldLines = old.lines()
        return newLines.size - oldLines.size + removedCount(oldLines, newLines)
    }

    private fun countRemoved(old: String, new: String): Int =
        removedCount(old.lines(), new.lines())

    private fun removedCount(oldLines: List<String>, newLines: List<String>): Int {
        val pool = HashMap<String, Int>()
        newLines.forEach { line -> pool[line] = (pool[line] ?: 0) + 1 }
        var removed = 0
        oldLines.forEach { line ->
            val left = pool[line] ?: 0
            if (left > 0) pool[line] = left - 1 else removed += 1
        }
        return removed
    }

    private fun makeDiff(old: String, new: String): String {
        val oldLines = old.lines()
        val newLines = new.lines()
        val sb = StringBuilder()
        sb.append("@@ строки: было ${oldLines.size}, стало ${newLines.size} @@\n")
        oldLines.forEach { sb.append("-").append(it).append("\n") }
        newLines.forEach { sb.append("+").append(it).append("\n") }
        return sb.toString()
    }

    private fun bash(context: Context, root: File, args: JSONObject): JSONObject {
        val command = args.optString("command")
        if (command.isBlank()) return err("пустая команда")
        if (!Runtime.bashAvailable()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "bash недоступен: rootfs не установлен")
                .put("output", "rootfs не установлен. Доступны остальные инструменты.")
        }
        val result = Runtime.exec(context, root, command, 60_000, MAX_OUTPUT)
        return JSONObject()
            .put("ok", result.exit == 0)
            .put("output", result.output)
            .put(
                "metadata",
                JSONObject()
                    .put("exit", result.exit)
                    .put("ms", result.ms)
                    .put("truncated", result.truncated)
            )
    }

    private fun grep(root: File, args: JSONObject): JSONObject {
        val pattern = args.optString("pattern")
        if (pattern.isBlank()) return err("пустой pattern")
        val regex = runCatching { Regex(pattern, RegexOption.IGNORE_CASE) }.getOrNull()
            ?: return err("некорректное выражение")
        val hits = ArrayList<String>()
        var count = 0
        root.walkTopDown().onEnter { !it.name.startsWith(".") }.forEach { f ->
            if (!f.isFile || f.length() > 512 * 1024 || hits.size >= 200) return@forEach
            val name = f.name.lowercase()
            if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".zip") || name.endsWith(".apk")) return@forEach
            runCatching {
                f.reader().useLines { seq ->
                    seq.forEachIndexed { idx, line ->
                        if (regex.containsMatchIn(line)) {
                            count++
                            if (hits.size < 200) {
                                val rel = f.relativeTo(root).path
                                hits.add("$rel:${idx + 1}: ${line.take(200)}")
                            }
                        }
                    }
                }
            }
        }
        return JSONObject()
            .put("ok", true)
            .put("output", if (hits.isEmpty()) "Совпадений нет" else hits.joinToString("\n"))
            .put("metadata", JSONObject().put("matches", count))
    }

    private fun glob(root: File, args: JSONObject): JSONObject {
        val pattern = args.optString("pattern").ifBlank { "**/*" }
        val regex = globToRegex(pattern)
        val files = ArrayList<String>()
        root.walkTopDown().onEnter { !it.name.startsWith(".") }.forEach { f ->
            if (!f.isFile) return@forEach
            val rel = f.relativeTo(root).path
            if (regex.matches(rel)) files.add(rel)
        }
        val top = files.sorted().take(300)
        return JSONObject()
            .put("ok", true)
            .put("output", if (top.isEmpty()) "Файлов нет" else top.joinToString("\n"))
            .put("metadata", JSONObject().put("files", files.size))
    }

    private fun globToRegex(pattern: String): Regex {
        val sb = StringBuilder()
        var i = 0
        while (i < pattern.length) {
            val c = pattern[i]
            when {
                c == '*' && i + 1 < pattern.length && pattern[i + 1] == '*' -> {
                    sb.append(".*")
                    i += 2
                    if (i < pattern.length && pattern[i] == '/') i += 1
                }
                c == '*' -> { sb.append("[^/]*"); i += 1 }
                c == '?' -> { sb.append("[^/]"); i += 1 }
                c == '.' || c == '(' || c == ')' || c == '+' || c == '|' || c == '^' || c == '$' -> {
                    sb.append('\\').append(c); i += 1
                }
                else -> { sb.append(c); i += 1 }
            }
        }
        return Regex(sb.toString())
    }

    private fun list(root: File, args: JSONObject): JSONObject {
        val dir = resolve(root, args.optString("path")) ?: return err("путь вне проекта")
        if (!dir.isDirectory) return err("не папка")
        val items = dir.listFiles()?.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() })) ?: emptyList()
        val lines = items.map { (if (it.isDirectory) "d " else "f ") + it.name + if (it.isDirectory) "/" else " (${it.length()} Б)" }
        return JSONObject()
            .put("ok", true)
            .put("output", lines.joinToString("\n").ifBlank { "Папка пуста" })
            .put("metadata", JSONObject().put("entries", items.size))
    }

    private fun webfetch(args: JSONObject): JSONObject {
        val url = args.optString("url")
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return err("разрешены только http/https")
        }
        val res = Net.json(url, "GET", mapOf("User-Agent" to Net.userAgent()), null)
        val body = res.getOrElse { return err(it.message ?: "ошибка сети") }
        val text = body.toString().take(MAX_OUTPUT)
        return JSONObject()
            .put("ok", true)
            .put("output", text)
            .put("metadata", JSONObject().put("bytes", text.length))
    }

    private fun todo(args: JSONObject): JSONObject {
        val items = args.optJSONArray("items") ?: JSONArray()
        val clean = JSONArray()
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            clean.put(
                JSONObject()
                    .put("text", item.optString("text"))
                    .put("status", item.optString("status", "pending"))
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("todos", clean)
            .put("output", "План обновлён: ${clean.length()} пунктов")
            .put("metadata", JSONObject().put("items", clean.length()))
    }

    private fun task(context: Context, args: JSONObject): JSONObject {
        val description = args.optString("description").ifBlank { "подзадача" }
        val prompt = args.optString("prompt").ifBlank { description }
        val id = "task_" + System.currentTimeMillis().toString(36)
        val item = JSONObject()
            .put("id", id)
            .put("role", "subagent")
            .put("description", description)
            .put("prompt", prompt)
            .put("status", "queued")
            .put("ts", System.currentTimeMillis())
        item.put("chatId", args.optString("chatId"))
        item.put("provider", args.optString("provider", "opencode"))
        item.put("model", args.optString("model", "zen-free"))
        SubAgents.enqueue(context, item)
        return JSONObject()
            .put("ok", true)
            .put("output", "Субагент запущен: $description")
            .put("task", item)
    }

    private fun err(message: String): JSONObject =
        JSONObject().put("ok", false).put("error", message)
}