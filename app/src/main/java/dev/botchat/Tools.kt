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
                "read" -> read(context, chatId, args)
                "write" -> write(context, chatId, args)
                "edit" -> edit(context, chatId, args)
                "bash" -> bash(context, chatId, root, args)
                "grep" -> grep(context, chatId, args)
                "glob" -> glob(context, chatId, args)
                "list" -> list(context, chatId, args)
                "webfetch" -> webfetch(args)
                "todo" -> todo(args)
                "task" -> task(context, args)
                else -> err("неизвестный инструмент: $name")
            }
        } catch (t: Throwable) {
            err(t.message ?: t.javaClass.simpleName)
        }
    }

    /**
     * Путь в терминах пользователя: «Downloads», «~/Downloads», «/sdcard/Download».
     * Все варианты приводятся к /storage/emulated/0/Download.
     */
    fun normalizeUserPath(context: Context, chatId: String, path: String): String {
        val p = path.trim()
        if (p.isEmpty()) return p
        val lower = p.lowercase()
        val downloads = listOf(
            "downloads", "download", "загрузки", "~/downloads", "~/download",
            "/sdcard/downloads", "/sdcard/download", "/storage/emulated/0/downloads",
            "/storage/emulated/0/download"
        )
        if (downloads.contains(lower)) {
            val target = java.io.File(Storage.deviceRoot(), "Download")
            return target.absolutePath
        }
        if (lower.startsWith("~/")) {
            return java.io.File(Storage.deviceRoot(), p.removePrefix("~/")).absolutePath
        }
        return p
    }

    /** Единый ответ об ошибке: причина + что сделать. */
    private fun fail(reason: String, hint: String, scope: String = ""): JSONObject {
        return JSONObject()
            .put("ok", false)
            .put("status", "not_done")
            .put("error", reason)
            .put("hint", hint)
            .put("scope", scope)
            .put("output", reason + (if (hint.isNotBlank()) "\nЧто нужно: " + hint else ""))
    }

    fun chatRoot(context: Context, chatId: String): File {
        val safe = chatId.replace(Regex("[^A-Za-z0-9_-]"), "_").ifBlank { "default" }
        return File(Profiles.root(context), safe).apply { mkdirs() }
    }

    private fun read(context: Context, chatId: String, args: JSONObject): JSONObject {
        val rawPath = normalizeUserPath(context, chatId, args.optString("path"))
        val f = Storage.resolve(context, chatId, rawPath)
            ?: return fail(
                "Путь «" + args.optString("path") + "» вне доступных папок.",
                "Выберите рабочую папку в карточке чата или дайте доступ ко всем файлам."
            )
        if (!f.exists()) {
            val parent = f.parentFile
            val near = parent?.listFiles()?.take(8)?.joinToString(", ") { it.name } ?: ""
            return fail(
                "Файл не найден: " + f.absolutePath,
                if (near.isNotBlank()) "В папке есть: " + near else "Проверьте путь через list."
            )
        }
        if (!f.isFile) return fail("Это папка, а не файл: " + f.absolutePath, "Используйте list.")
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
            .put("status", "done")
            .put("output", text)
            .put(
                "metadata",
                JSONObject()
                    .put("lines", lines)
                    .put("path", f.absolutePath)
                    .put("bytes", f.length())
            )
    }

    private fun write(context: Context, chatId: String, args: JSONObject): JSONObject {
        val rawPath = normalizeUserPath(context, chatId, args.optString("path"))
        val f = Storage.resolve(context, chatId, rawPath)
            ?: return fail(
                "Нельзя писать в «" + args.optString("path") + "»: путь вне доступных папок.",
                "Откройте карточку чата и выберите папку (или разрешите доступ ко всем файлам)."
            )
        val content = args.optString("content")
        f.parentFile?.mkdirs()
        Checkpoints.snapshot(chatRoot(context, chatId), "write: " + f.name)
        val tmp = File(f.parentFile, ".${f.name}.tmp")
        return try {
            tmp.writeText(content)
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING)
            // Верификация: перечитываем файл, а не верим на слово.
            val size = f.length()
            val head = f.inputStream().use { input ->
                val buf = ByteArray(minOf(size, 256L).toInt())
                input.read(buf)
                String(buf, Charsets.UTF_8)
            }
            val expected = content.toByteArray(Charsets.UTF_8).size.toLong()
            val verified = f.isFile && size == expected
            JSONObject()
                .put("ok", verified)
                .put("status", if (verified) "done" else "unverified")
                .put("output", if (verified)
                    "Записано: " + f.absolutePath + " (" + size + " байт, проверено чтением)"
                else
                    "Файл записан, но размер не совпал: " + f.absolutePath)
                .put(
                    "metadata",
                    JSONObject()
                        .put("path", f.absolutePath)
                        .put("bytes", size)
                        .put("verified", verified)
                        .put("preview", head.take(80))
                )
        } catch (t: Throwable) {
            fail(
                "Не удалось записать " + f.absolutePath + ": " + (t.message ?: "ошибка доступа"),
                "Проверьте, что папка доступна для записи, или выберите другую в карточке чата."
            )
        } finally {
            runCatching { tmp.delete() }
        }
    }

    private fun edit(context: Context, chatId: String, args: JSONObject): JSONObject {
        val rawPath = normalizeUserPath(context, chatId, args.optString("path"))
        val f = Storage.resolve(context, chatId, rawPath)
            ?: return fail(
                "Нельзя править «" + args.optString("path") + "»: путь вне доступных папок.",
                "Выберите рабочую папку в карточке чата."
            )
        if (!f.isFile) return fail("Файл не найден: " + f.absolutePath, "Сначала прочитайте файл через read.")
        val old = args.optString("oldString")
        val new = args.optString("newString")
        if (old.isEmpty()) return fail("Пустой oldString.", "Передайте точный фрагмент для замены.")
        val text = f.readText()
        if (!text.contains(old)) {
            return fail(
                "Фрагмент не найден в " + f.name + ".",
                "Прочитайте файл заново: содержимое могло измениться."
            )
        }
        Checkpoints.snapshot(chatRoot(context, chatId), "edit: " + f.name)
        val replaced = text.replaceFirst(old, new)
        val tmp = File(f.parentFile, ".${f.name}.tmp")
        return try {
            tmp.writeText(replaced)
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING)
            val after = f.readText()
            val applied = after.contains(new) && after != text
            val added = countAdded(old, new)
            val removed = countRemoved(old, new)
            JSONObject()
                .put("ok", applied)
                .put("status", if (applied) "done" else "unverified")
                .put("output", if (applied)
                    "Изменено: +" + added + "/-" + removed + " в " + f.absolutePath
                else
                    "Файл изменён, но новая строка не найдена при проверке.")
                .put(
                    "metadata",
                    JSONObject()
                        .put("added", added)
                        .put("removed", removed)
                        .put("diff", makeDiff(old, new))
                        .put("path", f.absolutePath)
                        .put("verified", applied)
                        .put("linesBefore", text.lines().size)
                        .put("linesAfter", after.lines().size)
                )
        } catch (t: Throwable) {
            fail(
                "Не удалось изменить " + f.absolutePath + ": " + (t.message ?: "ошибка"),
                "Проверьте права на папку."
            )
        } finally {
            runCatching { tmp.delete() }
        }
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

    private fun bash(context: Context, chatId: String, root: File, args: JSONObject): JSONObject {
        val command = args.optString("command")
        if (command.isBlank()) return fail("Пустая команда.", "Передайте команду для bash.")
        if (!Runtime.bashAvailable()) {
            return fail(
                "bash недоступен: rootfs не установлен.",
                "Установите rootfs в Файлы → Терминал. Остальные инструменты работают."
            )
        }
        // В контейнер монтируется активная рабочая папка: она видна как /workspace.
        val dir = Storage.activeRoot(context, chatId)
        val result = Runtime.exec(context, root, command, 60_000, MAX_OUTPUT, workingRoot = dir)
        val ok = result.exit == 0
        return JSONObject()
            .put("ok", ok)
            .put("status", if (ok) "done" else "not_done")
            .put("output", result.output)
            .put("error", if (ok) "" else "команда завершилась с кодом " + result.exit)
            .put(
                "metadata",
                JSONObject()
                    .put("exit", result.exit)
                    .put("ms", result.ms)
                    .put("truncated", result.truncated)
            )
    }

    private fun grep(context: Context, chatId: String, args: JSONObject): JSONObject {
        val pattern = args.optString("pattern")
        if (pattern.isBlank()) return fail("Пустой pattern.", "Передайте регулярное выражение.")
        val regex = runCatching { Regex(pattern, RegexOption.IGNORE_CASE) }.getOrNull()
            ?: return fail("Некорректное выражение.", "Проверьте синтаксис регулярного выражения.")
        val root = Storage.resolve(context, chatId, normalizeUserPath(context, chatId, args.optString("path")))
            ?: Storage.activeRoot(context, chatId)
        if (!root.isDirectory) return fail("Нет папки для поиска.", "Укажите существующий путь.")
        val hits = ArrayList<String>()
        var count = 0
        root.walkTopDown().onEnter { !it.name.startsWith(".") && it.length() < 20_000_000 }.forEach { f ->
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
            .put("status", "done")
            .put("output", if (hits.isEmpty()) "Совпадений нет" else hits.joinToString("\n"))
            .put("metadata", JSONObject().put("matches", count).put("root", root.absolutePath))
    }

    private fun glob(context: Context, chatId: String, args: JSONObject): JSONObject {
        val pattern = args.optString("pattern").ifBlank { "**/*" }
        val regex = globToRegex(pattern)
        val root = Storage.resolve(context, chatId, normalizeUserPath(context, chatId, args.optString("path")))
            ?: Storage.activeRoot(context, chatId)
        val files = ArrayList<String>()
        root.walkTopDown().onEnter { !it.name.startsWith(".") }.forEach { f ->
            if (!f.isFile) return@forEach
            val rel = f.relativeTo(root).path
            if (regex.matches(rel)) files.add(rel)
        }
        val top = files.sorted().take(300)
        return JSONObject()
            .put("ok", true)
            .put("status", "done")
            .put("output", if (top.isEmpty()) "Файлов нет" else top.joinToString("\n"))
            .put("metadata", JSONObject().put("files", files.size).put("root", root.absolutePath))
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

    private fun list(context: Context, chatId: String, args: JSONObject): JSONObject {
        val rawPath = normalizeUserPath(context, chatId, args.optString("path"))
        val dir = Storage.resolve(context, chatId, rawPath)
            ?: return fail(
                "Папка «" + args.optString("path").ifBlank { "." } + "» вне доступных.",
                "Откройте карточку чата и выберите рабочую папку."
            )
        if (!dir.isDirectory) {
            return fail("Это файл, а не папка: " + dir.absolutePath, "Для чтения используйте read.")
        }
        val all = dir.listFiles()
        if (all == null) {
            return fail(
                "Нет доступа к папке " + dir.absolutePath,
                "Разрешите доступ ко всем файлам в карточке чата."
            )
        }
        val items = all.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))
        val lines = items.take(120).map {
            (if (it.isDirectory) "d " else "f ") + it.name +
                if (it.isDirectory) "/" else " (" + it.length() + " Б)"
        }
        return JSONObject()
            .put("ok", true)
            .put("status", "done")
            .put("output", lines.joinToString("\n").ifBlank { "Папка пуста" })
            .put(
                "metadata",
                JSONObject()
                    .put("entries", items.size)
                    .put("path", dir.absolutePath)
                    .put("truncated", items.size > 120)
            )
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
        item.put("provider", args.optString("provider", ""))
        item.put("model", args.optString("model", ""))
        SubAgents.enqueue(context, item)
        return JSONObject()
            .put("ok", true)
            .put("output", "Субагент запущен: $description")
            .put("task", item)
    }

    private fun err(message: String): JSONObject = JSONObject()
        .put("ok", false)
        .put("status", "not_done")
        .put("error", message)
        .put("output", message)
}