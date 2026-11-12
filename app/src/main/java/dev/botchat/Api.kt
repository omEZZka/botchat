package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Единая точка API-операций, которые нужны UI через мост.
 * Сеть, ключи и агентская машина скрыты: наружу — только нормализованный JSON.
 */
object Api {

    fun dispatch(context: Context, payload: JSONObject): JSONObject {
        val op = payload.optString("op")
        return when (op) {
            "providers.list" -> providersList(context)
            "providers.catalog" -> JSONObject().put("ok", true).put("providers", Providers.cards(context))
            "providers.health" -> Providers.health(context, payload.optString("providerId"))
            "providers.probe" -> Providers.probe(context, payload)
            "providers.add" -> Providers.addCustom(context, payload)
            "keys.list" -> Secrets.list(context, payload.optString("providerId"))
            "keys.add" -> Secrets.add(
                context,
                payload.optString("providerId"),
                payload.optString("key"),
                payload.optString("label")
            )
            "keys.remove" -> Secrets.remove(
                context,
                payload.optString("providerId"),
                payload.optString("keyId")
            )
            "keys.active" -> Secrets.setActive(
                context,
                payload.optString("providerId"),
                payload.optString("keyId")
            )
            "keys.wipe" -> {
                Secrets.wipe(context, payload.optString("providerId"))
                JSONObject().put("ok", true)
            }
            "models.refresh" -> Models.refresh(context)
            "chat.start" -> {
                val chatId = payload.optString("chatId")
                val step = payload.optInt("step", 0)
                if (step <= 1) Agent.begin(context, chatId, payload.optInt("maxSteps", 30))
                ChatEngine.start(context, payload)
            }
            "agent.state" -> Agent.restore(context, payload.optString("chatId"))
            "agent.report" -> Steps.report(context, payload.optString("chatId"))
            "agent.pause" -> Agent.pause(payload.optString("chatId"))
            "agent.resume" -> Agent.resume(context, payload.optString("chatId"))
            "chat.cancel" -> ChatEngine.cancel(payload.optString("chatId"))
            "chat.compact" -> ChatEngine.compact(context, payload.optString("chatId"))
            "agent.start" -> {
                AgentService.start(context)
                JSONObject().put("ok", true)
            }
            "agent.stop" -> {
                Agent.stop(payload.optString("chatId"), "stopped via api")
                AgentService.stop(context)
                JSONObject().put("ok", true)
            }
            "runtime.info" -> Runtime.envInfo(context).put("ok", true)
            "runtime.install" -> Runtime.installRootfs(context, null, payload.optString("url").ifBlank { null })
            "runtime.remove" -> Runtime.removeRootfs(context)
            "runtime.attach" -> TermSession.attach(context, payload.optString("chatId"))
            "runtime.input" -> TermSession.input(
                payload.optString("chatId"),
                payload.optString("data")
            )
            "runtime.close" -> {
                TermSession.close(payload.optString("chatId"))
                JSONObject().put("ok", true)
            }
            "checkpoints.list" -> Checkpoints.list(context, payload.optString("chatId"))
            "checkpoints.restore" -> Checkpoints.restore(
                context,
                payload.optString("chatId"),
                payload.optString("id")
            )
            "export.data" -> Export.data(context, payload.optString("kind"))
            else -> JSONObject().put("ok", false).put("error", "unknown op: $op")
        }
    }

    private fun providersList(context: Context): JSONObject {
        val cards = Providers.cards(context)
        val models = Models.cached(context)
        val counts = ConcurrentHashMap<String, Int>()
        for (i in 0 until models.length()) {
            val pid = models.getJSONObject(i).optString("provider")
            counts[pid] = (counts[pid] ?: 0) + 1
        }
        for (i in 0 until cards.length()) {
            val card = cards.getJSONObject(i)
            card.put("modelCount", counts[card.optString("id")] ?: 0)
        }
        val custom = Providers.customList(context)
        for (i in 0 until custom.length()) {
            val item = custom.getJSONObject(i)
            cards.put(
                JSONObject()
                    .put("id", item.optString("id"))
                    .put("name", item.optString("name"))
                    .put("baseUrl", item.optString("baseUrl"))
                    .put("apiType", item.optString("apiType"))
                    .put("needsKey", true)
                    .put("hasKey", Secrets.hasKey(context, item.optString("id")))
                    .put("modelCount", counts[item.optString("id")] ?: 0)
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("providers", cards)
            .put("custom", custom)
            .put("models", models)
    }
}

/**
 * Каталог моделей: кеш в files, обновление по /models у провайдеров с ключом.
 */
object Models {

    private const val FILE = "models.json"

    private fun file(context: Context) = java.io.File(context.filesDir, FILE)

    fun cached(context: Context): JSONArray {
        val f = file(context)
        if (!f.exists()) return JSONArray()
        return runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
    }

    fun save(context: Context, models: JSONArray) {
        val f = file(context)
        val tmp = java.io.File(context.filesDir, ".$FILE.tmp")
        tmp.writeText(models.toString())
        if (!tmp.renameTo(f)) {
            tmp.copyTo(f, overwrite = true)
            tmp.delete()
        }
    }

    fun refresh(context: Context): JSONObject {
        val result = JSONArray()
        val errors = JSONObject()
        val providers = Providers.all(context)
        for (provider in providers) {
            if (provider.needsKey && !Secrets.hasKey(context, provider.id)) {
                if (provider.id != "opencode") continue
            }
            val models = runCatching { Providers.fetchModels(context, provider) }.getOrElse { emptyList() }
            if (models.isEmpty()) {
                errors.put(provider.id, "нет моделей")
                continue
            }
            models.forEach { m ->
                result.put(
                    JSONObject()
                        .put("id", m.id)
                        .put("name", m.name)
                        .put("provider", provider.id)
                        .put("context", m.context)
                        .put("reasoning", m.reasoning)
                        .put("vision", m.vision)
                        .put("priceIn", m.priceIn)
                        .put("priceOut", m.priceOut)
                )
            }
        }
        if (result.length() > 0) save(context, result)
        return JSONObject()
            .put("ok", true)
            .put("models", if (result.length() > 0) result else cached(context))
            .put("errors", errors)
    }
}