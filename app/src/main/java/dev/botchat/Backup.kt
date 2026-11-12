package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec
import android.util.Base64

/**
 * Экспорт/импорт настроек и шифрованный бэкап.
 * Ключи API исключены всегда; повреждённый архив не меняет профиль.
 */
object Backup {

    private const val FORMAT = "botchat.backup"
    private const val VERSION = 1
    private const val ITERATIONS = 120_000

    fun exportSettings(context: Context): JSONObject {
        val prefs = context.getSharedPreferences("bc_settings", Context.MODE_PRIVATE)
        val out = JSONObject()
        prefs.all.forEach { (k, v) -> if (v != null) out.put(k, v.toString()) }
        return JSONObject()
            .put("format", FORMAT)
            .put("version", VERSION)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("exportedAt", System.currentTimeMillis())
            .put("settings", out)
    }

    /** Собирает бэкап: настройки (без ключей) + чаты + метаданные. */
    fun exportAll(context: Context, chats: JSONArray): JSONObject = JSONObject()
        .put("format", FORMAT)
        .put("version", VERSION)
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put("exportedAt", System.currentTimeMillis())
        .put("settings", sanitizeSettings(exportSettings(context).optJSONObject("settings")))
        .put("chats", chats)

    private fun sanitizeSettings(settings: JSONObject?): JSONObject {
        val clean = JSONObject()
        val source = settings ?: return clean
        source.keys().forEach { key ->
            val lower = key.lowercase()
            if (lower.contains("secret") || lower.contains("apikey") || lower.contains("token")) return@forEach
            clean.put(key, source.optString(key))
        }
        return clean
    }

    fun importSettings(context: Context, json: String): JSONObject {
        val root = runCatching { JSONObject(json) }.getOrNull()
            ?: return err("Файл повреждён или это не бэкап botCHAT")
        val format = root.optString("format")
        if (format != FORMAT) return err("Неизвестный формат архива")
        val version = root.optInt("version", 0)
        if (version > VERSION) return err("Архив создан более новой версией")
        val settings = root.optJSONObject("settings") ?: return err("В архиве нет настроек")
        // Проверка целостности: сначала читаем целиком, потом применяем.
        val prepared = LinkedHashMap<String, String>()
        settings.keys().forEach { key ->
            val lower = key.lowercase()
            if (lower.contains("secret") || lower.contains("apikey") || lower.contains("token")) return@forEach
            prepared[key] = settings.optString(key)
        }
        val prefs = context.getSharedPreferences("bc_settings", Context.MODE_PRIVATE)
        prefs.edit().apply {
            prepared.forEach { (key, value) -> putString(key, value) }
        }.apply()
        return JSONObject().put("ok", true).put("keys", prepared.size)
    }

    fun encrypt(context: Context, plain: String, password: String): JSONObject {
        if (password.length < 6) return err("Пароль минимум 6 символов")
        return runCatching {
            val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val key = deriveKey(password, salt)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            val ciphertext = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            val blob = ByteArray(salt.size + iv.size + ciphertext.size)
            System.arraycopy(salt, 0, blob, 0, salt.size)
            System.arraycopy(iv, 0, blob, salt.size, iv.size)
            System.arraycopy(ciphertext, 0, blob, salt.size + iv.size, ciphertext.size)
            JSONObject()
                .put("ok", true)
                .put("format", "botchat.encrypted")
                .put("version", VERSION)
                .put("checksum", checksum(plain))
                .put("data", Base64.encodeToString(blob, Base64.NO_WRAP))
        }.getOrElse { err(it.message ?: "Ошибка шифрования") }
    }

    fun decrypt(context: Context, archive: JSONObject, password: String): String? {
        val encoded = archive.optString("data")
        if (encoded.isBlank()) return null
        return runCatching {
            val blob = Base64.decode(encoded, Base64.NO_WRAP)
            val salt = blob.copyOfRange(0, 16)
            val iv = blob.copyOfRange(16, 28)
            val ciphertext = blob.copyOfRange(28, blob.size)
            val key = deriveKey(password, salt)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            val plain = String(cipher.doFinal(ciphertext), Charsets.UTF_8)
            if (archive.optString("checksum").isNotBlank() &&
                archive.optString("checksum") != checksum(plain)
            ) {
                null
            } else {
                plain
            }
        }.getOrNull()
    }

    private fun deriveKey(password: String, salt: ByteArray): SecretKeySpec {
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(password.toCharArray(), salt, ITERATIONS, 256)
        val bytes = factory.generateSecret(spec).encoded
        return SecretKeySpec(bytes, "AES")
    }

    private fun checksum(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(digest, Base64.NO_WRAP).take(16)
    }

    fun writeFile(context: Context, name: String, text: String): JSONObject {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "backup.json" }
        val dir = File(context.getExternalFilesDir(null), "exports").apply { mkdirs() }
        val file = File(dir, safe)
        val tmp = File(dir, ".$safe.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            tmp.copyTo(file, overwrite = true)
            tmp.delete()
        }
        return JSONObject().put("ok", true).put("path", file.absolutePath)
    }

    fun pruneBackups(context: Context, keep: Int = 10) {
        val dir = File(context.filesDir, "backups")
        dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(keep)?.forEach { it.delete() }
    }

    private fun err(message: String) = JSONObject().put("ok", false).put("error", message)
}
