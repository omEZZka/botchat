package dev.botchat

import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Ограничитель частоты запросов на провайдера.
 *
 * Гейтвеи считают лимит по ключу за короткое окно. Проверка списка моделей
 * десятками запросов подряд выбирает это окно целиком, и потом даже обычный
 * чат получает 429. Поэтому все исходящие запросы к провайдеру проходят
 * через общий шлюз с минимальным интервалом.
 */
object Throttle {

    private const val DEFAULT_INTERVAL_MS = 1_100L
    private val nextSlot = ConcurrentHashMap<String, AtomicLong>()
    private val lastHint = ConcurrentHashMap<String, Long>()

    fun interval(providerId: String): Long {
        val hinted = lastHint[providerId]?.get() ?: 0L
        return maxOf(DEFAULT_INTERVAL_MS, hinted)
    }

    /** Ждёт свободное окно. Возвращает false, если отменили. */
    fun acquire(providerId: String, cancelled: () -> Boolean = { false }): Boolean {
        val slot = nextSlot.getOrPut(providerId) { AtomicLong(0) }
        while (true) {
            if (cancelled()) return false
            val now = System.currentTimeMillis()
            val next = slot.get()
            if (now >= next) {
                val interval = interval(providerId)
                if (slot.compareAndSet(next, now + interval)) return true
                continue
            }
            Thread.sleep((next - now).coerceAtMost(400L))
        }
    }

    /**
     * Провайдер попросил подождать: следующий слот отодвигается для всех,
     * а базовый интервал временно растёт, чтобы не снова попасть в лимит.
     */
    fun pause(providerId: String, ms: Long) {
        val wait = ms.coerceIn(500L, 60_000L)
        nextSlot.getOrPut(providerId) { AtomicLong(0) }.set(System.currentTimeMillis() + wait)
        lastHint[providerId] = (wait / 3).coerceIn(DEFAULT_INTERVAL_MS, 6_000L)
    }

    /** Успешный ответ: постепенно возвращаемся к базовому интервалу. */
    fun relax(providerId: String) {
        val current = lastHint[providerId] ?: return
        if (current <= DEFAULT_INTERVAL_MS) {
            lastHint.remove(providerId)
            return
        }
        lastHint[providerId] = (current * 2 / 3).coerceAtLeast(DEFAULT_INTERVAL_MS)
    }

    fun reset(providerId: String) {
        nextSlot.remove(providerId)
        lastHint.remove(providerId)
    }

    fun snapshot(): JSONObject {
        val out = JSONObject()
        nextSlot.forEach { (id, slot) ->
            val wait = slot.get() - System.currentTimeMillis()
            if (wait > 0) out.put(id, wait)
        }
        return out
    }
}
