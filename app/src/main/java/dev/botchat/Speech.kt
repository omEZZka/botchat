package dev.botchat

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Озвучка ответов системным TTS (офлайн, без внешних сервисов).
 * Используется в режиме «звонка»: ответ модели читается вслух.
 */
object Speech : TextToSpeech.OnInitListener {

    private var tts: TextToSpeech? = null
    private val ready = AtomicBoolean(false)
    private val speaking = AtomicBoolean(false)
    private var pendingText: String? = null
    private var lastUtterance = ""

    fun init(context: Context) {
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext, this)
    }

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            ready.set(false)
            return
        }
        val engine = tts ?: return
        val lang = engine.setLanguage(Locale.getDefault())
        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
            engine.setLanguage(Locale.ENGLISH)
        }
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                speaking.set(true)
                emitState("speaking")
            }

            override fun onDone(utteranceId: String?) {
                speaking.set(false)
                emitState("idle")
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                speaking.set(false)
                emitState("idle")
            }
        })
        ready.set(true)
        pendingText?.let { text ->
            pendingText = null
            speak(text)
        }
    }

    private fun emitState(state: String) {
        runCatching {
            Notifier.emitToUi(
                App.instance,
                "speech.state",
                JSONObject().put("state", state).put("text", lastUtterance)
            )
        }
    }

    fun isSpeaking(): Boolean = speaking.get()

    fun speak(text: String): JSONObject {
        val clean = cleanForSpeech(text)
        if (clean.isBlank()) return JSONObject().put("ok", false).put("error", "Пустой текст")
        lastUtterance = clean
        if (!ready.get()) {
            pendingText = clean
            init(App.instance)
            return JSONObject().put("ok", true).put("queued", true)
        }
        val engine = tts ?: return JSONObject().put("ok", false).put("error", "TTS недоступен")
        engine.stop()
        engine.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "bc-" + System.currentTimeMillis())
        return JSONObject().put("ok", true)
    }

    fun stop(): JSONObject {
        speaking.set(false)
        runCatching { tts?.stop() }
        emitState("idle")
        return JSONObject().put("ok", true)
    }

    fun shutdown() {
        runCatching { tts?.shutdown() }
        tts = null
        ready.set(false)
    }

    /** Убираем markdown-разметку, чтобы не читать «звёздочки» и «решётки». */
    private fun cleanForSpeech(text: String): String {
        var t = text
        t = t.replace(Regex("```[\\s\\S]*?```"), " блок кода ")
        t = t.replace(Regex("`([^`]*)`"), "$1")
        t = t.replace(Regex("!\\[[^\\]]*\\]\\([^)]*\\)"), " ")
        t = t.replace(Regex("\\[([^\\]]*)\\]\\([^)]*\\)"), "$1")
        t = t.replace(Regex("^#{1,6}\\s*", RegexOption.MULTILINE), "")
        t = t.replace(Regex("[*_~]{1,3}"), "")
        t = t.replace(Regex("^\\s*[-+*]\\s+", RegexOption.MULTILINE), "")
        t = t.replace(Regex("^\\s*\\d+[.)]\\s+", RegexOption.MULTILINE), "")
        t = t.replace(Regex("\\s+"), " ")
        return t.trim().take(1200)
    }
}
