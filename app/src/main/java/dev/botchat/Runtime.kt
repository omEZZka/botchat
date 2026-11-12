package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * rootfs + proot. Без rootfs инструмент bash недоступен, остальное работает.
 * Пути чата маппятся в /workspace внутри контейнера.
 */
object Runtime {

    const val GUEST_ROOT = "/root/.botchat/rootfs"
    const val GUEST_WORKSPACE = "/workspace"

    fun rootfsDir(context: Context): File = File(context.filesDir, "rootfs")

    fun prootBinary(context: Context): File = File(context.applicationInfo.nativeLibraryDir, "libproot.so")

    fun prootLoader(context: Context): File =
        File(context.applicationInfo.nativeLibraryDir, "libproot-loader.so")

    fun rootfsReady(): Boolean = rootfsDir(App.instance).resolve("bin/sh").exists()

    fun bashAvailable(): Boolean = rootfsReady() && prootBinary(App.instance).exists()

    /**
     * Команда для запуска shell внутри rootfs. Возвращает null, если rootfs отсутствует.
     */
    fun shellCommand(context: Context, cwd: File, command: String): List<String>? {
        if (!bashAvailable()) return null
        val rootfs = rootfsDir(context)
        val proot = prootBinary(context)
        val bind = "$GUEST_WORKSPACE=${cwd.absolutePath}"
        return listOf(
            proot.absolutePath,
            "--link2symlink",
            "-0",
            "-r", rootfs.absolutePath,
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", bind,
            "-w", GUEST_WORKSPACE,
            "/usr/bin/env", "-i",
            "HOME=/root",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TERM=xterm-256color",
            "LANG=C.UTF-8",
            "/bin/bash", "-lc", command
        )
    }

    data class ExecResult(val output: String, val exit: Int, val truncated: Boolean, val ms: Long)

    /**
     * Выполняет команду с лимитом времени и объёма. Сохраняет хвост вывода.
     */
    fun exec(
        context: Context,
        cwd: File,
        command: String,
        timeoutMs: Long = 60_000,
        maxBytes: Int = 256 * 1024
    ): ExecResult {
        val cmd = shellCommand(context, cwd, command)
            ?: return ExecResult("bash недоступен: rootfs не установлен", 127, false, 0)
        val started = System.currentTimeMillis()
        val pb = ProcessBuilder(cmd)
        pb.directory(cwd)
        pb.redirectErrorStream(true)
        pb.environment().clear()
        prootLoader(context).takeIf { it.exists() }?.let { loader ->
            pb.environment()["PROOT_LOADER"] = loader.absolutePath
        }
        val tmp = File(context.filesDir, "proot-tmp").apply { mkdirs() }
        pb.environment()["PROOT_TMP_DIR"] = tmp.absolutePath
        pb.environment()["PROOT_NO_SECCOMP"] = "1"
        val process = pb.start()
        val buffer = RingBuffer(maxBytes)
        val done = AtomicFlag()
        val reader = Thread {
            try {
                process.inputStream.use { input ->
                    val chunk = ByteArray(8192)
                    while (true) {
                        val n = input.read(chunk)
                        if (n < 0) break
                        buffer.write(chunk, n)
                    }
                }
            } catch (_: Exception) {
            } finally {
                done.set()
            }
        }.apply { isDaemon = true; start() }
        val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) {
            process.destroyForcibly()
            Thread.sleep(120)
            reader.interrupt()
            return ExecResult(
                buffer.text() + "\n[превышен лимит времени ${timeoutMs / 1000} с]",
                -1,
                buffer.truncated,
                System.currentTimeMillis() - started
            )
        }
        reader.join(1500)
        return ExecResult(buffer.text(), process.exitValue(), buffer.truncated, System.currentTimeMillis() - started)
    }

    fun envInfo(context: Context): JSONObject {
        return JSONObject()
            .put("rootfs", rootfsReady())
            .put("bash", bashAvailable())
            .put("proot", prootBinary(context).exists())
            .put("size", dirSize(rootfsDir(context)))
    }

    fun ensureDirs(context: Context) {
        File(context.filesDir, "workspace").mkdirs()
        File(context.filesDir, "attachments").mkdirs()
        File(context.filesDir, "settings").mkdirs()
    }

    private fun dirSize(f: File): Long {
        if (!f.exists()) return 0
        var total = 0L
        f.walkTopDown().forEach { if (it.isFile) total += it.length() }
        return total
    }

    private class AtomicFlag {
        @Volatile
        private var value = false
        fun set() { value = true }
        fun get() = value
    }

    /** Хранит последние N байт вывода, помечая усечение. */
    class RingBuffer(private val limit: Int) {
        private val data = StringBuilder()
        var truncated = false
            private set

        @Synchronized
        fun write(chunk: ByteArray, len: Int) {
            data.append(String(chunk, 0, len, Charsets.UTF_8))
            if (data.length > limit) {
                data.delete(0, data.length - limit)
                truncated = true
            }
        }

        @Synchronized
        fun text(): String = data.toString()
    }

    /**
     * Установка rootfs из локального архива или URL.
     * Распаковка идёт в staging, затем атомарное переименование.
     */
    fun installRootfs(context: Context, source: File? = null, url: String? = null): JSONObject {
        val target = rootfsDir(context)
        if (target.resolve("bin/sh").exists()) {
            return JSONObject().put("ok", true).put("already", true).put("path", target.absolutePath)
        }
        val staging = File(context.filesDir, "rootfs-staging").apply {
            if (exists()) deleteRecursively()
            mkdirs()
        }
        return try {
            val archive = when {
                source != null && source.isFile -> source
                !url.isNullOrBlank() -> {
                    val tmp = File(context.cacheDir, "rootfs.tar.gz")
                    val res = Net.download(url, tmp)
                    if (res.isFailure) {
                        return JSONObject()
                            .put("ok", false)
                            .put("error", res.exceptionOrNull()?.message ?: "Не удалось скачать rootfs")
                    }
                    tmp
                }
                else -> return JSONObject().put("ok", false).put("error", "Нет источника rootfs")
            }
            val stream = if (archive.name.endsWith(".gz")) {
                java.util.zip.GZIPInputStream(archive.inputStream())
            } else {
                archive.inputStream()
            }
            stream.use { Tar.extract(it, staging) }
            if (!File(staging, "bin/sh").exists()) {
                staging.deleteRecursively()
                return JSONObject().put("ok", false).put("error", "Архив не содержит bin/sh")
            }
            File(staging, "workspace").mkdirs()
            File(staging, "etc").mkdirs()
            File(staging, "etc/resolv.conf").writeText("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
            if (target.exists()) target.deleteRecursively()
            if (!staging.renameTo(target)) {
                staging.copyRecursively(target, overwrite = true)
                staging.deleteRecursively()
            }
            JSONObject().put("ok", true).put("path", target.absolutePath)
        } catch (t: Throwable) {
            staging.deleteRecursively()
            JSONObject().put("ok", false).put("error", t.message ?: "Ошибка установки rootfs")
        }
    }

    fun removeRootfs(context: Context): JSONObject {
        val dir = rootfsDir(context)
        return JSONObject().put("ok", dir.deleteRecursively())
    }

    fun listRootfsCandidates(): JSONArray = JSONArray()
}