package dev.botchat

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Минимальный tar-распаковщик (ustar + pax/gnu long names).
 * Достаточен для rootfs-архивов и не тянет внешних зависимостей.
 */
object Tar {

    fun extract(input: InputStream, target: File): Int {
        target.mkdirs()
        val header = ByteArray(512)
        var count = 0
        var pendingLongName: String? = null
        while (true) {
            if (!readFully(input, header)) break
            if (header.all { it == 0.toByte() }) break
            val name = pendingLongName ?: readString(header, 0, 100)
            pendingLongName = null
            val size = readOctal(header, 124, 12)
            val type = header[156].toInt().toChar()
            val prefix = readString(header, 345, 155)
            val fullName = if (prefix.isNotBlank()) "$prefix/$name" else name
            val linkName = readString(header, 157, 100)

            if (type == 'L') {
                val data = ByteArray(size.toInt())
                readFully(input, data)
                pendingLongName = String(data, Charsets.UTF_8).trimEnd('\u0000', '\n')
                skipPadding(input, size)
                continue
            }

            val safe = sanitize(fullName)
            val out = File(target, safe)
            if (safe.isEmpty()) {
                skipPadding(input, size)
                continue
            }
            when (type) {
                '5' -> out.mkdirs()
                '2' -> {
                    out.parentFile?.mkdirs()
                    runCatching {
                        if (out.exists()) out.delete()
                        Files.createSymbolicLink(out.toPath(), File(linkName).toPath())
                    }
                    skipPadding(input, size)
                }
                '0', '\u0000', '7' -> {
                    out.parentFile?.mkdirs()
                    writeEntry(input, out, size)
                    count++
                }
                else -> skipPadding(input, size)
            }
        }
        return count
    }

    private fun writeEntry(input: InputStream, out: File, size: Long) {
        val tmp = File(out.parentFile, ".${out.name}.untar")
        tmp.outputStream().use { sink ->
            var left = size
            val buf = ByteArray(64 * 1024)
            while (left > 0) {
                val want = minOf(buf.size.toLong(), left).toInt()
                val read = input.read(buf, 0, want)
                if (read <= 0) break
                sink.write(buf, 0, read)
                left -= read
            }
            sink.flush()
        }
        runCatching {
            Files.move(tmp.toPath(), out.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }.onFailure {
            tmp.copyTo(out, overwrite = true)
            tmp.delete()
        }
        skipPadding(input, size)
        runCatching { out.setExecutable(true, false) }
    }

    private fun skipPadding(input: InputStream, size: Long) {
        val pad = (512 - (size % 512)) % 512
        if (pad > 0) readFully(input, ByteArray(pad.toInt()))
    }

    private fun sanitize(path: String): String {
        val parts = path.replace('\\', '/').split('/').filter { it.isNotBlank() && it != "." }
        if (parts.any { it == ".." }) return ""
        return parts.joinToString("/")
    }

    private fun readString(buf: ByteArray, offset: Int, length: Int): String {
        val end = (offset until minOf(offset + length, buf.size)).firstOrNull { buf[it] == 0.toByte() }
            ?: minOf(offset + length, buf.size)
        return String(buf, offset, end - offset, Charsets.UTF_8)
    }

    private fun readOctal(buf: ByteArray, offset: Int, length: Int): Long {
        val text = String(buf, offset, length, Charsets.US_ASCII).trim('\u0000', ' ', '\n')
        if (text.isEmpty()) return 0
        return text.toLongOrNull(8) ?: 0
    }

    private fun readFully(input: InputStream, buf: ByteArray): Boolean {
        var offset = 0
        while (offset < buf.size) {
            val read = input.read(buf, offset, buf.size - offset)
            if (read <= 0) return offset > 0 && offset == buf.size
            offset += read
        }
        return true
    }
}
