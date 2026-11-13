package dev.botchat

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Запись голоса и распознавание речи.
 *
 * Распознавание идёт напрямую к провайдеру по тому же ключу, что и чат
 * (`POST /audio/transcriptions`, multipart) — без Google Ассистента.
 * Если ключа/провайдера нет, UI может использовать системный распознаватель.
 */
object Voice {

    private const val SAMPLE_RATE = 16_000
    private const val CHANNELS = AudioFormat.CHANNEL_IN_MONO
    private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    private const val MAX_SECONDS = 120

    private var recorder: AudioRecord? = null
    private var recordThread: Thread? = null
    private val recording = AtomicBoolean(false)
    private var outputFile: File? = null
    private var startedAt = 0L
    @Volatile
    private var lastLevel = 0

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    fun isRecording(): Boolean = recording.get()

    fun level(): Int = lastLevel

    fun elapsedMs(): Long = if (recording.get()) System.currentTimeMillis() - startedAt else 0L

    /** Начинает запись в WAV внутри папки чата. */
    fun start(context: Context, chatId: String): JSONObject {
        if (recording.get()) {
            return JSONObject().put("ok", false).put("error", "Запись уже идёт")
        }
        if (!hasPermission(context)) {
            return JSONObject().put("ok", false).put("error", "Нет разрешения на микрофон").put("permission", true)
        }
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNELS, ENCODING)
        if (minBuf <= 0) {
            return JSONObject().put("ok", false).put("error", "Микрофон недоступен")
        }
        val bufferSize = maxOf(minBuf * 2, SAMPLE_RATE / 2)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, CHANNELS, ENCODING, bufferSize)
        } catch (t: Throwable) {
            return JSONObject().put("ok", false).put("error", "Не удалось открыть микрофон")
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return JSONObject().put("ok", false).put("error", "Микрофон занят")
        }

        val dir = File(Tools.chatRoot(context, chatId), "voice").apply { mkdirs() }
        val target = File(dir, "rec-" + System.currentTimeMillis() + ".wav")
        val pcm = File(dir, ".rec-${System.currentTimeMillis()}.pcm")
        outputFile = target
        startedAt = System.currentTimeMillis()
        lastLevel = 0
        recording.set(true)
        recorder = rec

        recordThread = Thread {
            val buf = ByteArray(4096)
            try {
                rec.startRecording()
                pcm.outputStream().use { out ->
                    while (recording.get() && elapsedMs() < MAX_SECONDS * 1000L) {
                        val n = rec.read(buf, 0, buf.size)
                        if (n > 0) {
                            out.write(buf, 0, n)
                            var peak = 0
                            var i = 0
                            while (i + 1 < n) {
                                val sample = (buf[i].toInt() and 0xFF) or (buf[i + 1].toInt() shl 8)
                                val abs = kotlin.math.abs(sample.toShort().toInt())
                                if (abs > peak) peak = abs
                                i += 2
                            }
                            lastLevel = (peak * 100 / 32768).coerceIn(0, 100)
                        }
                    }
                }
            } catch (_: Throwable) {
            } finally {
                runCatching { rec.stop() }
                runCatching { rec.release() }
                recorder = null
                recording.set(false)
                lastLevel = 0
                runCatching { writeWav(pcm, target) }
                runCatching { pcm.delete() }
            }
        }.apply { name = "VoiceRec"; isDaemon = true }
        recordThread?.start()
        return JSONObject().put("ok", true).put("path", target.absolutePath)
    }

    /** Останавливает запись и возвращает WAV-файл. */
    fun stop(): JSONObject {
        if (!recording.get()) {
            val file = outputFile
            return JSONObject()
                .put("ok", file != null && file.exists())
                .put("path", file?.absolutePath ?: "")
                .put("durationMs", 0)
        }
        recording.set(false)
        val duration = elapsedMs()
        runCatching { recordThread?.join(1500) }
        val file = outputFile
        return JSONObject()
            .put("ok", file != null && file.exists() && file.length() > 44)
            .put("path", file?.absolutePath ?: "")
            .put("durationMs", duration)
    }

    fun cancel() {
        recording.set(false)
        runCatching { recordThread?.join(1000) }
        runCatching { outputFile?.delete() }
        outputFile = null
    }

    /** PCM 16-bit mono → WAV (заголовок 44 байта). */
    private fun writeWav(pcm: File, target: File) {
        if (!pcm.exists() || pcm.length() == 0L) return
        val dataLen = pcm.length().toInt()
        RandomAccessFile(target, "rw").use { wav ->
            wav.setLength(0)
            val header = ByteArray(44)
            fun putStr(offset: Int, text: String) {
                text.toByteArray(Charsets.US_ASCII).copyInto(header, offset)
            }
            fun putInt(offset: Int, value: Int) {
                header[offset] = (value and 0xFF).toByte()
                header[offset + 1] = ((value shr 8) and 0xFF).toByte()
                header[offset + 2] = ((value shr 16) and 0xFF).toByte()
                header[offset + 3] = ((value shr 24) and 0xFF).toByte()
            }
            fun putShort(offset: Int, value: Int) {
                header[offset] = (value and 0xFF).toByte()
                header[offset + 1] = ((value shr 8) and 0xFF).toByte()
            }
            putStr(0, "RIFF")
            putInt(4, 36 + dataLen)
            putStr(8, "WAVE")
            putStr(12, "fmt ")
            putInt(16, 16)
            putShort(20, 1)
            putShort(22, 1)
            putInt(24, SAMPLE_RATE)
            putInt(28, SAMPLE_RATE * 2)
            putShort(32, 2)
            putShort(34, 16)
            putStr(36, "data")
            putInt(40, dataLen)
            wav.write(header)
            pcm.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    wav.write(buf, 0, n)
                }
            }
        }
    }

    /**
     * Распознаёт WAV. Провайдер и ключ — те же, что для чата.
     * Поддерживается OpenAI-совместимый `/audio/transcriptions`.
     */
    fun transcribe(context: Context, path: String, model: String = ""): JSONObject {
        val file = File(path)
        if (!file.exists()) return JSONObject().put("ok", false).put("error", "Файл записи не найден")
        val provider = sttProvider(context)
            ?: return JSONObject()
                .put("ok", false)
                .put("error", "Нет провайдера для распознавания. Добавьте ключ OpenAI или Groq.")
                .put("needProvider", true)
        val key = Secrets.activeKey(context, provider.id)
        if (provider.needsKey && key == null) {
            return JSONObject()
                .put("ok", false)
                .put("error", "Нужен ключ провайдера " + provider.name)
                .put("needProvider", true)
        }
        val sttModel = model.ifBlank {
            Settings.sttModel() ?: defaultSttModel(provider.id)
        }
        val url = provider.baseUrl.trimEnd('/') + "/audio/transcriptions"
        val headers = LinkedHashMap<String, String>()
        key?.let { headers["Authorization"] = "Bearer $it" }
        headers["User-Agent"] = Net.userAgent()
        Providers.customHeaders(context, provider.id).forEach { (k, v) -> headers[k] = v }
        val result = Net.multipart(url, headers, file, "file", "audio.wav", sttModel)
        return result.getOrElse {
            JSONObject()
                .put("ok", false)
                .put("error", it.message ?: "Не удалось распознать речь")
        }.let { body ->
            val text = body.optString("text").ifBlank { body.optString("transcript") }
            if (text.isBlank()) {
                JSONObject().put("ok", false).put("error", "Пустой ответ распознавания")
            } else {
                JSONObject().put("ok", true).put("text", text.trim()).put("model", sttModel)
            }
        }
    }

    /** Провайдер для STT: выбранный пользователем или первый, где есть ключ. */
    private fun sttProvider(context: Context): Providers.Provider? {
        val preferred = Settings.sttProviderId()
        if (!preferred.isNullOrBlank()) {
            Providers.byId(context, preferred)?.let { if (Secrets.hasKey(context, it.id)) return it }
        }
        val order = listOf("openai", "groq", "openrouter", "deepseek", "mistral")
        for (id in order) {
            val provider = Providers.byId(context, id) ?: continue
            if (Secrets.hasKey(context, id)) return provider
        }
        return Providers.all(context).firstOrNull {
            it.needsKey && Secrets.hasKey(context, it.id) &&
                (it.apiType == "openai" || it.apiType == "openai-compatible")
        }
    }

    fun defaultSttModel(providerId: String): String = when (providerId) {
        "groq" -> "whisper-large-v3-turbo"
        "mistral" -> "voxtral-mini-latest"
        else -> "whisper-1"
    }

    /** Доступные модели распознавания для провайдера (без сетевых запросов). */
    fun sttModels(providerId: String): JSONArray {
        val arr = JSONArray()
        val list = when (providerId) {
            "openai" -> listOf("whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe")
            "groq" -> listOf("whisper-large-v3-turbo", "whisper-large-v3")
            "mistral" -> listOf("voxtral-mini-latest")
            else -> listOf("whisper-1")
        }
        list.forEach { arr.put(it) }
        return arr
    }

}

/** Тонкая обёртка над SharedPreferences, чтобы не тянуть UI-слой в Voice. */
object Settings {
    private const val PREFS = "bc_native_settings"

    fun sttProviderId(): String? =
        App.instance.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("sttProviderId", null)

    fun setSttProviderId(id: String) {
        App.instance.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString("sttProviderId", id).apply()
    }

    fun sttModel(): String? =
        App.instance.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("sttModel", null)

    fun setSttModel(model: String) {
        App.instance.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString("sttModel", model).apply()
    }
}
