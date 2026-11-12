package dev.botchat

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Хранилище API-ключей: AES-GCM, ключ в Android Keystore.
 * Ключи никогда не покидают устройство, не логируются и не попадают в бэкап.
 */
object Secrets {

    private const val ALIAS = "botchat_secrets_v1"
    private const val PREFS = "bc_secrets"
    private const val KEY_STORE = "AndroidKeyStore"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEY_STORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val out = ByteArray(iv.size + ct.size)
        System.arraycopy(iv, 0, out, 0, iv.size)
        System.arraycopy(ct, 0, out, iv.size, ct.size)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String? = runCatching {
        val raw = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = raw.copyOfRange(0, 12)
        val ct = raw.copyOfRange(12, raw.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(ct), Charsets.UTF_8)
    }.getOrNull()

    private fun load(context: Context): JSONObject {
        val blob = prefs(context).getString("vault", null) ?: return JSONObject()
        val text = decrypt(blob) ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrDefault(JSONObject())
    }

    private fun save(context: Context, data: JSONObject) {
        prefs(context).edit().putString("vault", encrypt(data.toString())).apply()
    }

    @Synchronized
    fun list(context: Context, providerId: String): JSONObject {
        val vault = load(context)
        val arr = vault.optJSONArray(providerId) ?: JSONArray()
        val visible = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val key = item.optString("key")
            visible.put(
                JSONObject()
                    .put("id", item.optString("id"))
                    .put("mask", mask(key))
                    .put("active", item.optBoolean("active"))
                    .put("addedAt", item.optLong("addedAt"))
                    .put("label", item.optString("label"))
            )
        }
        return JSONObject().put("ok", true).put("keys", visible)
    }

    @Synchronized
    fun add(context: Context, providerId: String, key: String, label: String): JSONObject {
        if (key.isBlank()) return err("Пустой ключ")
        val vault = load(context)
        val arr = vault.optJSONArray(providerId) ?: JSONArray()
        var exists = false
        for (i in 0 until arr.length()) {
            if (arr.getJSONObject(i).optString("key") == key) exists = true
        }
        if (!exists) {
            val first = arr.length() == 0
            arr.put(
                JSONObject()
                    .put("id", "k" + System.currentTimeMillis())
                    .put("key", key)
                    .put("active", first)
                    .put("addedAt", System.currentTimeMillis())
                    .put("label", label)
            )
            vault.put(providerId, arr)
            save(context, vault)
        }
        return list(context, providerId)
    }

    @Synchronized
    fun remove(context: Context, providerId: String, keyId: String): JSONObject {
        val vault = load(context)
        val arr = vault.optJSONArray(providerId) ?: JSONArray()
        val next = JSONArray()
        var removedWasActive = false
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            if (item.optString("id") == keyId) {
                removedWasActive = item.optBoolean("active")
            } else {
                next.put(item)
            }
        }
        if (removedWasActive && next.length() > 0) {
            next.getJSONObject(0).put("active", true)
        }
        vault.put(providerId, next)
        save(context, vault)
        return list(context, providerId)
    }

    @Synchronized
    fun setActive(context: Context, providerId: String, keyId: String): JSONObject {
        val vault = load(context)
        val arr = vault.optJSONArray(providerId) ?: JSONArray()
        for (i in 0 until arr.length()) {
            arr.getJSONObject(i).put("active", arr.getJSONObject(i).optString("id") == keyId)
        }
        vault.put(providerId, arr)
        save(context, vault)
        return list(context, providerId)
    }

    /**
     * Кольцо ключей: активный первым, затем остальные в порядке добавления.
     */
    @Synchronized
    fun keyRing(context: Context, providerId: String): List<String> {
        val vault = load(context)
        val arr = vault.optJSONArray(providerId) ?: return emptyList()
        val active = ArrayList<String>()
        val rest = ArrayList<String>()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val key = item.optString("key")
            if (key.isBlank()) continue
            if (item.optBoolean("active")) active.add(key) else rest.add(key)
        }
        return active + rest
    }

    @Synchronized
    fun rotate(context: Context, providerId: String, failed: String): String? {
        val vault = load(context)
        val arr = vault.optJSONArray(providerId) ?: return null
        val ring = keyRing(context, providerId)
        val idx = ring.indexOf(failed)
        if (idx < 0 || ring.size < 2) return null
        val next = ring[(idx + 1) % ring.size]
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            item.put("active", item.optString("key") == next)
        }
        vault.put(providerId, arr)
        save(context, vault)
        return next
    }

    @Synchronized
    fun hasKey(context: Context, providerId: String): Boolean = keyRing(context, providerId).isNotEmpty()

    @Synchronized
    fun activeKey(context: Context, providerId: String): String? = keyRing(context, providerId).firstOrNull()

    fun mask(key: String): String {
        if (key.length <= 8) return "…"
        return key.take(3) + "…" + key.takeLast(4)
    }

    fun wipe(context: Context) {
        prefs(context).edit().remove("vault").apply()
        runCatching {
            val ks = KeyStore.getInstance(KEY_STORE).apply { load(null) }
            ks.deleteEntry(ALIAS)
        }
    }

    private fun err(message: String) = JSONObject().put("ok", false).put("error", message)
}