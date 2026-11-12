package dev.botchat

import android.content.Context
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Единственная точка выхода в сеть. UI не знает ни URL, ни ключей:
 * наружу отдаются только нормализованные события.
 */
object Net {

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(45, TimeUnit.SECONDS)
            .callTimeout(180, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .followRedirects(true)
            .build()
    }

    private val streamClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(0, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS)
            .build()
    }

    interface Callback {
        fun onDelta(text: String) {}
        fun onToolDelta(index: Int, id: String?, name: String?, argsDelta: String?) {}
        fun onFinish(reason: String?) {}
        fun onError(message: String, retryable: Boolean, status: Int) {}
    }

    class Handle internal constructor(private val stop: () -> Unit) {
        private val closed = AtomicBoolean(false)

        fun cancel() {
            if (closed.compareAndSet(false, true)) stop()
        }
    }

    /**
     * JSON-запрос с таймаутом и отменой. Ретраи только для идемпотентных GET.
     */
    fun json(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
        idempotent: Boolean = method == "GET"
    ): Result<JSONObject> {
        var attempt = 0
        var lastError: Exception? = null
        while (attempt < if (idempotent) 3 else 1) {
            attempt++
            try {
                val builder = Request.Builder().url(url)
                headers.forEach { (k, v) -> builder.header(k, v) }
                val payload = body?.toRequestBody(JSON)
                when (method) {
                    "GET" -> builder.get()
                    "DELETE" -> builder.delete()
                    else -> builder.method(method, payload ?: EMPTY)
                }
                client.newCall(builder.build()).execute().use { res ->
                    val text = res.body?.string() ?: ""
                    if (!res.isSuccessful) {
                        return Result.failure(
                            NetException(res.code, friendly(res.code, text), res.code)
                        )
                    }
                    return Result.success(if (text.isBlank()) JSONObject() else JSONObject(text))
                }
            } catch (e: Exception) {
                lastError = e
                if (!idempotent || attempt >= 3) break
                Thread.sleep(400L * (1 shl (attempt - 1)))
            }
        }
        return Result.failure(lastError ?: IOException("network error"))
    }

    /**
     * Потоковый POST. Читает построчно (SSE `data:` или чистый JSON-lines)
     * и передаёт каждую непустую строку парсеру. Handle отменяет чтение.
     */
    fun stream(
        url: String,
        headers: Map<String, String>,
        body: String,
        onLine: (String) -> Boolean,
        cb: Callback
    ): Handle {
        val cancelled = AtomicBoolean(false)
        val thread = Thread {
            try {
                val request = Request.Builder().url(url)
                    .post(body.toRequestBody(JSON))
                    .apply { headers.forEach { (k, v) -> header(k, v) } }
                    .build()
                val call = streamClient.newCall(request)
                call.execute().use { res ->
                    if (!res.isSuccessful) {
                        val err = res.body?.string() ?: ""
                        cb.onError(friendly(res.code, err), res.code == 429 || res.code >= 500, res.code)
                        return@use
                    }
                    val source = res.body?.source() ?: return@use
                    while (!cancelled.get() && !source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (line.isBlank()) continue
                        if (!onLine(line)) {
                            cancelled.set(true)
                            break
                        }
                    }
                    if (!cancelled.get()) cb.onFinish(null)
                }
            } catch (e: Exception) {
                if (!cancelled.get()) cb.onError(e.message ?: "Ошибка соединения", true, 0)
            }
        }.apply {
            name = "NetStream"
            isDaemon = true
        }
        thread.start()
        return Handle { cancelled.set(true); thread.interrupt() }
    }

    fun friendly(code: Int, body: String): String {
        val detail = body.take(300).replace(Regex("\\s+"), " ").trim()
        return when (code) {
            401, 403 -> "Ключ отклонён или нет доступа (HTTP $code)"
            404 -> "Модель или endpoint не найдены (HTTP 404)"
            413 -> "Слишком большой контекст (HTTP 413)"
            429 -> "Квота исчерпана или лимит запросов (HTTP 429)"
            in 500..599 -> "Провайдер недоступен (HTTP $code)"
            else -> if (detail.isNotBlank()) "HTTP $code: $detail" else "HTTP $code"
        }
    }

    class NetException(val code: Int, override val message: String, val retryable: Boolean) : IOException(message)

    fun isOnline(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
                as? android.net.ConnectivityManager ?: return true
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun userAgent(): String {
        return "botCHAT/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MODEL})"
    }

    private val JSON = "application/json".toMediaType()
    private val EMPTY = "".toRequestBody(JSON)
}