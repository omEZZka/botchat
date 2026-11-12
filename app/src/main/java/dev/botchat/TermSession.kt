package dev.botchat

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Интерактивная сессия shell внутри rootfs: постоянный процесс bash,
 * stdin/stdout через pipe. Полноценный PTY недоступен без нативного слоя,
 * поэтому строки эха и управляющие последовательности ограничены.
 */
object TermSession {

    class Session(val chatId: String) {
        var process: Process? = null
        var writer: java.io.OutputStream? = null
        val alive = AtomicBoolean(false)
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    fun attach(context: Context, chatId: String): JSONObject {
        val session = sessions.getOrPut(chatId) { Session(chatId) }
        if (session.alive.get()) return JSONObject().put("ok", true).put("reused", true)
        if (!Runtime.bashAvailable()) {
            return JSONObject().put("ok", false).put("error", "rootfs не установлен")
        }
        val root = Tools.chatRoot(context, chatId)
        val cmd = Runtime.shellCommand(context, root, "exec /bin/bash -i")
            ?: return JSONObject().put("ok", false).put("error", "rootfs не установлен")
        return try {
            val pb = ProcessBuilder(cmd)
            pb.directory(root)
            pb.redirectErrorStream(true)
            pb.environment().clear()
            pb.environment()["PROOT_LOADER"] =
                Runtime.prootLoader(context).takeIf { it.exists() }?.absolutePath ?: ""
            pb.environment()["PROOT_TMP_DIR"] =
                File(context.filesDir, "proot-tmp").apply { mkdirs() }.absolutePath
            pb.environment()["PROOT_NO_SECCOMP"] = "1"
            pb.environment()["TERM"] = "xterm-256color"
            val process = pb.start()
            session.process = process
            session.writer = process.outputStream
            session.alive.set(true)
            Thread {
                try {
                    val buf = ByteArray(4096)
                    while (session.alive.get()) {
                        val n = process.inputStream.read(buf)
                        if (n < 0) break
                        val text = String(buf, 0, n, Charsets.UTF_8)
                        Notifier.emitToUi(
                            App.instance,
                            "term.output",
                            JSONObject().put("chatId", chatId).put("data", text)
                        )
                    }
                } catch (_: Exception) {
                } finally {
                    session.alive.set(false)
                    Notifier.emitToUi(
                        App.instance,
                        "term.output",
                        JSONObject().put("chatId", chatId).put("data", "\r\n[процесс завершён]")
                    )
                }
            }.apply { isDaemon = true; name = "Term-$chatId"; start() }
            JSONObject().put("ok", true)
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "не удалось запустить")
        }
    }

    fun input(chatId: String, data: String): JSONObject {
        val session = sessions[chatId] ?: return JSONObject().put("ok", false)
        val writer = session.writer ?: return JSONObject().put("ok", false)
        return try {
            writer.write(data.toByteArray(Charsets.UTF_8))
            writer.flush()
            JSONObject().put("ok", true)
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message)
        }
    }

    fun close(chatId: String) {
        val session = sessions.remove(chatId) ?: return
        session.alive.set(false)
        runCatching { session.process?.destroy() }
    }

    fun closeAll() {
        sessions.keys.toList().forEach { close(it) }
    }
}
