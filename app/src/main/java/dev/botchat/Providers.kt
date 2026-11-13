package dev.botchat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Каталог провайдеров, адаптеры API, health, кольцо ключей.
 * Нормализует разные API в формат «сообщение + tool_calls + streaming-дельты».
 */
object Providers {

    data class ModelInfo(
        val id: String,
        val name: String,
        val context: Long = 0,
        val reasoning: Boolean = false,
        val vision: Boolean = false,
        val priceIn: Double = 0.0,
        val priceOut: Double = 0.0
    )

    data class Provider(
        val id: String,
        val name: String,
        val baseUrl: String,
        val apiType: String = "openai",
        val needsKey: Boolean = true
    )

    private val catalog: List<Provider> = listOf(
        Provider("opencode", "OpenCode Zen", "https://opencode.ai/zen/v1", needsKey = false),
        Provider("openai", "OpenAI", "https://api.openai.com/v1"),
        Provider("anthropic", "Anthropic", "https://api.anthropic.com/v1", "anthropic"),
        Provider("google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini"),
        Provider("xai", "xAI Grok", "https://api.x.ai/v1"),
        Provider("deepseek", "DeepSeek", "https://api.deepseek.com/v1"),
        Provider("mistral", "Mistral", "https://api.mistral.ai/v1"),
        Provider("groq", "Groq", "https://api.groq.com/openai/v1"),
        Provider("openrouter", "OpenRouter", "https://openrouter.ai/api/v1"),
        Provider("together", "Together AI", "https://api.together.xyz/v1"),
        Provider("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1"),
        Provider("cerebras", "Cerebras", "https://api.cerebras.ai/v1"),
        Provider("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1"),
        Provider("perplexity", "Perplexity", "https://api.perplexity.ai"),
        Provider("moonshot", "Moonshot (Kimi)", "https://api.moonshot.ai/v1"),
        Provider("zhipu", "Z.ai (GLM)", "https://open.bigmodel.cn/api/paas/v4"),
        Provider("alibaba", "Alibaba Qwen (DashScope)", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        Provider("baidu", "Baidu ERNIE", "https://qianfan.baidubce.com/v2"),
        Provider("minimax", "MiniMax", "https://api.minimax.chat/v1"),
        Provider("01ai", "01.AI Yi", "https://api.lingyiwanwu.com/v1"),
        Provider("github-copilot", "GitHub Copilot", "https://api.githubcopilot.com"),
        Provider("azure-openai", "Azure OpenAI", "https://YOUR_RESOURCE.openai.azure.com/openai"),
        Provider("aws-bedrock", "AWS Bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com", "custom"),
        Provider("vertex", "Google Vertex AI", "https://us-central1-aiplatform.googleapis.com", "custom"),
        Provider("groq-cloud", "GroqCloud", "https://api.groq.com/openai/v1"),
        Provider("cohere", "Cohere", "https://api.cohere.ai/v1", "custom"),
        Provider("ai21", "AI21", "https://api.ai21.com/studio/v1", "custom"),
        Provider("voyage", "Voyage AI (эмбеддинги)", "https://api.voyageai.com/v1", "custom"),
        Provider("huggingface", "Hugging Face Inference", "https://api-inference.huggingface.co/v1"),
        Provider("pollinations", "Pollinations (free)", "https://text.pollinations.ai/openai", needsKey = false),
        Provider("llm7", "LLM7 (free)", "https://api.llm7.io/v1", needsKey = false),
        Provider("ollama", "Ollama", "http://127.0.0.1:11434/v1", needsKey = false),
        Provider("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1", needsKey = false),
        Provider("llamacpp", "llama.cpp server", "http://127.0.0.1:8080/v1", needsKey = false)
    )

    private const val CUSTOM_FILE = "custom_providers.json"

    fun customFile(context: Context) = File(context.filesDir, CUSTOM_FILE)

    fun customList(context: Context): JSONArray {
        val f = customFile(context)
        if (!f.exists()) return JSONArray()
        return runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
    }

    private fun saveCustom(context: Context, arr: JSONArray): Boolean {
        val f = customFile(context)
        val tmp = File(context.filesDir, ".$CUSTOM_FILE.tmp")
        tmp.writeText(arr.toString())
        if (!tmp.renameTo(f)) {
            tmp.copyTo(f, overwrite = true)
            tmp.delete()
        }
        return true
    }

    fun all(context: Context): List<Provider> {
        val list = ArrayList(catalog)
        val custom = customList(context)
        for (i in 0 until custom.length()) {
            val item = custom.getJSONObject(i)
            list.add(
                Provider(
                    item.optString("id"),
                    item.optString("name"),
                    item.optString("baseUrl"),
                    item.optString("apiType", "openai"),
                    needsKey = true
                )
            )
        }
        return list
    }

    fun byId(context: Context, id: String): Provider? = all(context).firstOrNull { it.id == id }

    fun customHeaders(context: Context, id: String): Map<String, String> {
        val custom = customList(context)
        for (i in 0 until custom.length()) {
            val item = custom.getJSONObject(i)
            if (item.optString("id") == id) {
                val headers = item.optJSONObject("headers") ?: return emptyMap()
                val out = LinkedHashMap<String, String>()
                headers.keys().forEach { key -> out[key] = headers.optString(key) }
                return out
            }
        }
        return emptyMap()
    }

    fun cards(context: Context): JSONArray {
        val arr = JSONArray()
        catalog.forEach { p ->
            arr.put(
                JSONObject()
                    .put("id", p.id)
                    .put("name", p.name)
                    .put("baseUrl", p.baseUrl)
                    .put("apiType", p.apiType)
                    .put("needsKey", p.needsKey)
                    .put("hasKey", Secrets.hasKey(context, p.id))
            )
        }
        return arr
    }

    fun addCustom(context: Context, payload: JSONObject): JSONObject {
        val id = payload.optString("id").trim().lowercase().replace(Regex("[^a-z0-9_-]"), "")
        if (id.isBlank()) return JSONObject().put("ok", false).put("error", "Некорректный id")
        val baseUrl = payload.optString("baseUrl").trim()
        if (baseUrl.isBlank()) return JSONObject().put("ok", false).put("error", "Пустой Base URL")
        val arr = customList(context)
        val entry = JSONObject()
            .put("id", id)
            .put("name", payload.optString("name", id))
            .put("baseUrl", baseUrl.trimEnd('/'))
            .put("apiType", payload.optString("apiType", "openai-compatible"))
            .put("headers", payload.optJSONObject("headers") ?: JSONObject())
        var replaced = false
        for (i in 0 until arr.length()) {
            if (arr.getJSONObject(i).optString("id") == id) {
                arr.put(i, entry)
                replaced = true
            }
        }
        if (!replaced) arr.put(entry)
        saveCustom(context, arr)
        val key = payload.optString("key").trim()
        if (key.isNotBlank()) Secrets.add(context, id, key, "custom")
        val models = payload.optJSONArray("models")
        if (models != null && models.length() > 0) {
            val cached = Models.cached(context)
            for (i in 0 until models.length()) {
                cached.put(
                    JSONObject()
                        .put("id", models.optString(i))
                        .put("name", models.optString(i))
                        .put("provider", id)
                )
            }
            Models.save(context, cached)
        }
        return JSONObject().put("ok", true).put("id", id)
    }

    fun headers(provider: Provider, key: String?): Map<String, String> {
        val map = LinkedHashMap<String, String>()
        map["Content-Type"] = "application/json"
        map["Accept"] = "text/event-stream"
        map["User-Agent"] = Net.userAgent()
        when (provider.apiType) {
            "anthropic" -> {
                key?.let { map["x-api-key"] = it }
                map["anthropic-version"] = "2023-06-01"
            }
            "gemini" -> {
                key?.let { map["x-goog-api-key"] = it }
            }
            else -> {
                key?.let { map["Authorization"] = "Bearer $it" }
            }
        }
        if (provider.id == "openrouter") {
            map["HTTP-Referer"] = "https://botchat.app"
            map["X-Title"] = "botCHAT"
        }
        return map
    }

    fun health(context: Context, id: String): JSONObject {
        val provider = byId(context, id)
            ?: return JSONObject().put("ok", false).put("error", "unknown provider")
        val key = Secrets.activeKey(context, id)
        if (provider.needsKey && key == null) {
            return JSONObject()
                .put("ok", true)
                .put("healthy", false)
                .put("id", id)
                .put("hasKey", false)
                .put("error", "ключа нет")
        }
        val models = runCatching { fetchModels(context, provider) }.getOrElse { emptyList() }
        return JSONObject()
            .put("ok", true)
            .put("healthy", models.isNotEmpty())
            .put("id", id)
            .put("hasKey", key != null)
            .put("modelCount", models.size)
            .put("baseUrl", provider.baseUrl)
    }

    fun probe(context: Context, payload: JSONObject): JSONObject {
        val baseUrl = payload.optString("baseUrl").trim().trimEnd('/')
        val apiType = payload.optString("apiType", "openai-compatible")
        val key = payload.optString("key").trim().ifBlank { null }
        if (baseUrl.isBlank()) return JSONObject().put("ok", false).put("error", "Пустой Base URL")
        val temp = Provider("custom", "custom", baseUrl, normalizeType(apiType), needsKey = key != null)
        val models = runCatching { fetchModels(context, temp, key) }.getOrElse { emptyList() }
        val arr = JSONArray()
        models.forEach { arr.put(JSONObject().put("id", it.id).put("name", it.name)) }
        return JSONObject()
            .put("ok", true)
            .put("models", arr)
    }

    private fun normalizeType(type: String): String = when (type) {
        "anthropic" -> "anthropic"
        "gemini" -> "gemini"
        else -> "openai"
    }

    fun fetchModels(context: Context, provider: Provider, explicitKey: String? = null): List<ModelInfo> {
        val keys = if (explicitKey != null) listOf(explicitKey) else Secrets.keyRing(context, provider.id)
        val attemptKeys: List<String?> = if (keys.isEmpty()) listOf(null) else keys
        for (key in attemptKeys) {
            val result = fetchModelsOnce(context, provider, key)
            if (result.isNotEmpty()) return result
        }
        // Бесплатные провайдеры должны давать список даже без сети.
        val fallback = defaultModels(provider.id)
        if (fallback.isNotEmpty()) return fallback
        return emptyList()
    }

    private fun fetchModelsOnce(context: Context, provider: Provider, key: String?): List<ModelInfo> {
        val url = when (provider.apiType) {
            "anthropic" -> provider.baseUrl + "/models"
            "gemini" -> provider.baseUrl + "/models"
            else -> provider.baseUrl + "/models"
        }
        val hdrs = headers(provider, key).toMutableMap()
        hdrs.remove("Accept")
        hdrs["Accept"] = "application/json"
        customHeaders(context, provider.id).forEach { (k, v) -> hdrs[k] = v }
        val res = Net.json(url, "GET", hdrs, null)
        val body = res.getOrElse { return emptyList() }
        val out = ArrayList<ModelInfo>()
        when (provider.apiType) {
            "gemini" -> {
                val data = body.optJSONArray("models") ?: return emptyList()
                for (i in 0 until data.length()) {
                    val item = data.getJSONObject(i)
                    val id = item.optString("name").removePrefix("models/")
                    val methods = item.optJSONArray("supportedGenerationMethods")
                    var generate = methods == null
                    if (methods != null) {
                        for (j in 0 until methods.length()) {
                            if (methods.optString(j) == "generateContent") generate = true
                        }
                    }
                    if (!generate || id.isBlank()) continue
                    out.add(
                        ModelInfo(
                            id = id,
                            name = id,
                            context = item.optInt("inputTokenLimit").toLong(),
                            vision = true
                        )
                    )
                }
            }
            else -> {
                val data = body.optJSONArray("data") ?: body.optJSONArray("models") ?: return emptyList()
                for (i in 0 until data.length()) {
                    val item = data.getJSONObject(i)
                    val id = item.optString("id").ifBlank { item.optString("name") }
                    if (id.isBlank()) continue
                    val ctx = item.optInt("context_length")
                        .takeIf { it > 0 }
                        ?: item.optInt("context_window").takeIf { it > 0 }
                        ?: item.optJSONObject("top_provider")?.optInt("context_length") ?: 0
                    out.add(
                        ModelInfo(
                            id = id,
                            name = item.optString("name", id),
                            context = ctx.toLong(),
                            reasoning = item.optBoolean("reasoning"),
                            vision = item.optJSONArray("input_modalities")?.let { arr2 ->
                                (0 until arr2.length()).any { arr2.optString(it) == "image" }
                            } ?: item.optBoolean("vision")
                        )
                    )
                }
            }
        }
        return out.sortedBy { it.id }.distinctBy { it.id }
    }

    fun defaultModels(providerId: String): List<ModelInfo> {
        return when (providerId) {
            "opencode" -> listOf(
                ModelInfo("big-pickle", "Big Pickle", 200000, reasoning = true),
                ModelInfo("mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free", 128000, vision = true),
                ModelInfo("deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free", 1000000, reasoning = true),
                ModelInfo("glm-5.3-flash-free", "GLM-5.3-Flash Free", 1000000, vision = true),
                ModelInfo("minimax-m3.1-flash-free", "MiniMax M3.1 Flash Free", 200000),
                ModelInfo("longcat-2.5-free", "LongCat 2.5 Free", 128000),
                ModelInfo("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", 128000, reasoning = true)
            )
            "pollinations" -> listOf(
                ModelInfo("openai", "Pollinations OpenAI", 128000, reasoning = true),
                ModelInfo("openai-fast", "Pollinations OpenAI Fast", 128000, reasoning = true),
                ModelInfo("mistral", "Pollinations Mistral", 128000)
            )
            "llm7" -> listOf(
                ModelInfo("codestral-latest", "LLM7 Codestral", 256000),
                ModelInfo("mistral-Nemo-Instruct-2407", "LLM7 Mistral Nemo", 128000)
            )
            else -> emptyList()
        }
    }
}