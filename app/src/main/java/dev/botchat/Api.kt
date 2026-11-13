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

    /** Операции с сетью: выполняются вне JS-потока, чтобы WebView не подвисал. */
    private val NETWORK_OPS = setOf(
        "providers.probe",
        "providers.health",
        "models.refresh",
        "models.probe",
        "providers.verify",
        "chat.start",
        "providers.add"
    )

    fun isNetworkOp(op: String): Boolean = NETWORK_OPS.contains(op)

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
            "providers.verify" -> {
                Models.verify(context, payload.optString("providerId"), payload.optJSONArray("models"))
            }
            "models.hide" -> Models.hide(
                context,
                payload.optString("providerId"),
                payload.optString("modelId")
            )
            "models.unhide" -> Models.unhide(
                context,
                payload.optString("providerId"),
                payload.optString("modelId")
            )
            "models.removeProvider" -> Models.removeProvider(context, payload.optString("providerId"))
            "providers.remove" -> Providers.removeCustom(context, payload.optString("providerId"))
            "quota.info" -> Quota.snapshot(context)
            "quota.clear" -> {
                val providerId = payload.optString("providerId")
                val modelId = payload.optString("modelId")
                if (modelId == "@account" || modelId.isBlank()) {
                    Quota.clearAccount(context, providerId)
                }
                if (modelId.isNotBlank() && modelId != "@account") {
                    Quota.clear(context, providerId, modelId)
                }
                JSONObject().put("ok", true)
            }
            "chat.start" -> {
                val chatId = payload.optString("chatId")
                val step = payload.optInt("step", 0)
                if (step <= 1) Agent.begin(context, chatId, payload.optInt("maxSteps", 30))
                ChatEngine.start(context, payload)
            }
            "agent.state" -> Agent.restore(context, payload.optString("chatId"))
            "agent.report" -> Steps.report(context, payload.optString("chatId"))
            "tasks.list" -> SubAgents.all(context)
            "profiles.list" -> JSONObject()
                .put("ok", true)
                .put("active", Profiles.active(context))
                .put("profiles", Profiles.list(context))
            "profiles.add" -> Profiles.add(
                context,
                payload.optString("id"),
                payload.optString("name")
            )
            "profiles.active" -> Profiles.setActive(context, payload.optString("id"))
            "overlay.show" -> {
                if (android.provider.Settings.canDrawOverlays(context)) {
                    OverlayService.start(context)
                    JSONObject().put("ok", true)
                } else {
                    JSONObject()
                        .put("ok", false)
                        .put("error", "Нужно разрешение на наложение поверх других приложений")
                        .put("settings", android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                }
            }
            "overlay.hide" -> {
                OverlayService.hide(context)
                JSONObject().put("ok", true)
            }
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
            "checkpoints.create" -> {
                val root = Tools.chatRoot(context, payload.optString("chatId"))
                val snap = Checkpoints.snapshot(root, payload.optString("reason", "ручной снимок"))
                JSONObject().put("ok", snap != null).put("id", snap?.optString("id") ?: "")
            }
            "checkpoints.restore" -> Checkpoints.restore(
                context,
                payload.optString("chatId"),
                payload.optString("id")
            )
            "export.data" -> Export.data(context, payload.optString("kind"))
            "backup.export" -> {
                val chats = payload.optJSONArray("chats") ?: org.json.JSONArray()
                val archive = Backup.exportAll(context, chats)
                val text = if (payload.optString("password").isNotBlank()) {
                    val enc = Backup.encrypt(context, archive.toString(), payload.optString("password"))
                    if (!enc.optBoolean("ok")) enc else enc
                } else {
                    archive
                }
                Backup.writeFile(
                    context,
                    if (payload.optString("password").isNotBlank()) "botchat-backup.enc.json" else "botchat-backup.json",
                    text.toString()
                )
            }
            "backup.import" -> {
                val raw = payload.optString("text")
                val password = payload.optString("password")
                val parsed = runCatching { JSONObject(raw) }.getOrNull()
                    ?: JSONObject().put("ok", false).put("error", "Архив повреждён")
                if (parsed.optString("format") == "botchat.encrypted") {
                    val plain = Backup.decrypt(context, parsed, password)
                    if (plain == null) {
                        JSONObject().put("ok", false).put("error", "Неверный пароль или архив повреждён")
                    } else {
                        Backup.importSettings(context, plain)
                    }
                } else {
                    Backup.importSettings(context, raw)
                }
            }
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

    /** Как сохранено, без фильтрации — для записи. */
    fun cachedRaw(context: Context): JSONArray {
        val f = file(context)
        if (!f.exists()) return JSONArray()
        return runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
    }

    /** Для UI: без скрытых пользователем моделей. */
    fun cached(context: Context): JSONArray {
        val all = cachedRaw(context)
        val hidden = hiddenSet(context)
        if (hidden.isEmpty()) return all
        val out = JSONArray()
        for (i in 0 until all.length()) {
            val item = all.getJSONObject(i)
            if (!hidden.contains(item.optString("provider") + "|" + item.optString("id"))) {
                out.put(item)
            }
        }
        return out
    }

    private const val HIDDEN_FILE = "models_hidden.json"

    fun hiddenSet(context: Context): MutableSet<String> {
        val f = java.io.File(context.filesDir, HIDDEN_FILE)
        if (!f.exists()) return HashSet()
        val arr = runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
        val out = HashSet<String>()
        for (i in 0 until arr.length()) out.add(arr.optString(i))
        return out
    }

    private fun saveHidden(context: Context, set: Set<String>) {
        val f = java.io.File(context.filesDir, HIDDEN_FILE)
        val tmp = java.io.File(context.filesDir, ".$HIDDEN_FILE.tmp")
        tmp.writeText(JSONArray(set.toList()).toString())
        if (!tmp.renameTo(f)) {
            tmp.copyTo(f, overwrite = true)
            tmp.delete()
        }
    }

    fun hide(context: Context, providerId: String, modelId: String): JSONObject {
        val set = hiddenSet(context)
        set.add(providerId + "|" + modelId)
        saveHidden(context, set)
        return JSONObject().put("ok", true)
    }

    fun unhide(context: Context, providerId: String, modelId: String): JSONObject {
        val set = hiddenSet(context)
        set.remove(providerId + "|" + modelId)
        saveHidden(context, set)
        return JSONObject().put("ok", true)
    }

    fun removeProvider(context: Context, providerId: String): JSONObject {
        val all = cachedRaw(context)
        val next = JSONArray()
        for (i in 0 until all.length()) {
            val item = all.getJSONObject(i)
            if (item.optString("provider") != providerId) next.put(item)
        }
        save(context, next)
        return JSONObject().put("ok", true)
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

    /**
     * Полная проверка: список моделей провайдера + короткий запрос к каждой.
     * Возвращает только рабочие модели и отчёт по остальным.
     */
    fun verify(context: Context, providerId: String, requested: JSONArray?): JSONObject {
        val provider = Providers.byId(context, providerId)
            ?: return JSONObject().put("ok", false).put("error", "Провайдер не найден")

        val candidates = LinkedHashSet<String>()
        if (requested != null) {
            for (i in 0 until requested.length()) {
                val id = requested.optString(i)
                if (id.isNotBlank()) candidates.add(id)
            }
        }
        if (candidates.isEmpty()) {
            val fetched = runCatching { Providers.fetchModels(context, provider) }
                .getOrElse { emptyList() }
            fetched.forEach { candidates.add(it.id) }
        }
        if (candidates.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "Провайдер не вернул список моделей")
        }

        val report = ModelCheck.checkProvider(context, provider, candidates.toList()) { _, _ -> }
        val results = report.optJSONArray("results") ?: JSONArray()

        val working = JSONArray()
        val rejected = JSONArray()

        // Сначала сохраняем рабочие модели в кеш.
        val cached = cachedRaw(context)
        var added = 0
        for (i in 0 until results.length()) {
            val item = results.getJSONObject(i)
            val id = item.optString("id")
            if (item.optBoolean("ok")) {
                working.put(id)
                var present = false
                for (j in 0 until cached.length()) {
                    val entry = cached.getJSONObject(j)
                    if (entry.optString("provider") == providerId && entry.optString("id") == id) present = true
                }
                if (!present) {
                    cached.put(
                        JSONObject().put("id", id).put("name", id).put("provider", providerId)
                    )
                    added += 1
                }
                // Ранее скрытая пользователем модель остаётся скрытой.
            } else {
                rejected.put(
                    JSONObject()
                        .put("id", id)
                        .put("reason", item.optString("reason"))
                        .put("code", item.optInt("code"))
                )
            }
        }
        if (added > 0) save(context, cached)
        return JSONObject()
            .put("ok", true)
            .put("providerId", providerId)
            .put("total", results.length())
            .put("working", working)
            .put("rejected", rejected)
            .put("models", cached(context))
    }

    fun refresh(context: Context): JSONObject {
        val result = JSONArray()
        val errors = JSONObject()
        val providers = Providers.all(context)
        for (provider in providers) {
            if (provider.needsKey && !Secrets.hasKey(context, provider.id)) continue
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
            .put("models", if (result.length() > 0) cached(context) else cached(context))
            .put("errors", errors)
    }
}