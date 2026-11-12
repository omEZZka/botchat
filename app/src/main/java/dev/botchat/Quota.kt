package dev.botchat

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Память о квотах и лимитах бесплатных моделей.
 *
 * Задача не «обойти» лимит, а не терять диалог: помнить, до какого времени
 * конкретная модель/провайдер ограничены, и в это окно сразу предлагать
 * следующую доступную бесплатную модель вместо ожидания впустую.
 */
object Quota {

    private const val FILE = "quota.json"
    private const val MAX_ENTRIES = 120

    private fun file(context: Context) = File(context.filesDir, FILE)

    private fun load(context: Context): JSONObject {
        val f = file(context)
        if (!f.exists()) return JSONObject()
        return runCatching { JSONObject(f.readText()) }.getOrDefault(JSONObject())
    }

    @Synchronized
    private fun save(context: Context, data: JSONObject) {
        runCatching {
            val f = file(context)
            val tmp = File(context.filesDir, ".$FILE.tmp")
            tmp.writeText(data.toString())
            if (!tmp.renameTo(f)) {
                tmp.copyTo(f, overwrite = true)
                tmp.delete()
            }
        }
    }

    private fun key(providerId: String, modelId: String) = "$providerId|$modelId"

    /** Запоминает, когда модель снова станет доступной. */
    @Synchronized
    fun markLimited(context: Context, providerId: String, modelId: String, retryAfterMs: Long) {
        val data = load(context)
        val wait = if (retryAfterMs > 0) retryAfterMs else 60_000L
        val until = System.currentTimeMillis() + wait.coerceIn(1_000, 900_000)
        data.put(key(providerId, modelId), until)
        if (data.length() > MAX_ENTRIES) {
            val entries = data.keys().asSequence()
                .map { it to data.optLong(it) }
                .sortedBy { it.second }
                .drop(data.length() - MAX_ENTRIES)
            val pruned = JSONObject()
            entries.forEach { (k, v) -> pruned.put(k, v) }
            save(context, pruned)
            return
        }
        save(context, data)
    }

    /** Сколько ещё ждать (0 — модель доступна). */
    fun remaining(context: Context, providerId: String, modelId: String): Long {
        val data = load(context)
        val until = data.optLong(key(providerId, modelId), 0L)
        val delta = until - System.currentTimeMillis()
        return if (delta > 0) delta else 0L
    }

    @Synchronized
    fun clear(context: Context, providerId: String, modelId: String) {
        val data = load(context)
        data.remove(key(providerId, modelId))
        save(context, data)
    }

    fun snapshot(context: Context): JSONObject {
        val data = load(context)
        val now = System.currentTimeMillis()
        val out = JSONObject()
        data.keys().forEach { k ->
            val until = data.optLong(k)
            if (until > now) out.put(k, until - now)
        }
        return JSONObject().put("ok", true).put("limited", out).put("ts", now)
    }

    /**
     * Порядок кандидатов: сначала доступные модели, затем ограниченные —
     * по возрастанию оставшегося ожидания. Так бесплатные модели
     * используются по кругу, а не ждут одну и ту же.
     */
    fun order(
        context: Context,
        candidates: List<Pair<String, String>>
    ): List<Pair<String, String>> {
        val data = load(context)
        val now = System.currentTimeMillis()
        return candidates.sortedWith(
            compareBy(
                { candidate ->
                    val until = data.optLong(key(candidate.first, candidate.second), 0L)
                    if (until > now) 1 else 0
                },
                { candidate ->
                    val until = data.optLong(key(candidate.first, candidate.second), 0L)
                    (until - now).coerceAtLeast(0)
                }
            )
        )
    }
}
