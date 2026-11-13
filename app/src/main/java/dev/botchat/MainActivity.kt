package dev.botchat

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.app.Activity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : Activity(), BridgeHost {

    private lateinit var web: WebView
    private var pendingPick: ((List<Uri>) -> Unit)? = null
    private var receiver: BroadcastReceiver? = null

    private lateinit var root: FrameLayout
    private var splash: View? = null
    private var splashStage: TextView? = null
    private var splashDetail: TextView? = null
    private var splashProgress: ProgressBar? = null
    private var splashRetry: Button? = null
    private var ready = false
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var watchdog: Runnable? = null
    private var assetLoader: WebViewAssetLoader? = null
    private var renderCrashed = false
    private val bridgePool = java.util.concurrent.Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "BCBridge").apply { isDaemon = true }
    }
    private val bridgeSeq = java.util.concurrent.atomic.AtomicLong(0)

    private val REQ_FILES = 1001
    private val REQ_IMAGE = 1002
    private val REQ_NOTIFY = 1003

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
        current = this
        Runtime.ensureDirs(this)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        web.setBackgroundColor(0xFF0F1216.toInt())
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100
            setSupportZoom(false)
        }
        if (Build.VERSION.SDK_INT >= 29) {
            web.settings.forceDark = WebSettings.FORCE_DARK_ON
        }
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.addJavascriptInterface(Bridge(), "BCBridge")
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (ready) return
                runOnUiThread {
                    splashProgress?.isIndeterminate = false
                    splashProgress?.progress = (newProgress.coerceIn(0, 100) * 0.6).toInt() + 4
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") {
                    val loader = assetLoader
                    if (loader != null) {
                        val response = loader.shouldInterceptRequest(url)
                        if (response != null) return response
                    }
                    var path = url.path?.removePrefix("/")?.trimStart('/')?.ifBlank { "ui/index.html" }
                        ?: "ui/index.html"
                    if (!path.startsWith("ui/")) path = "ui/$path"
                    return assetResponse(path)
                }
                return null
            }

            override fun onRenderProcessGone(
                view: WebView,
                detail: android.webkit.RenderProcessGoneDetail
            ): Boolean {
                if (renderCrashed) return true
                renderCrashed = true
                runOnUiThread {
                    android.widget.Toast
                        .makeText(this@MainActivity, "Перезапуск интерфейса", Toast.LENGTH_SHORT)
                        .show()
                    recreate()
                }
                return true
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame) {
                    if (loadAttempts < 2) {
                        setStage("Повтор загрузки", 6)
                        handler.postDelayed({ loadApp() }, 250)
                    } else {
                        showError(
                            "Не удалось загрузить интерфейс: " +
                                (error.description ?: "ошибка") +
                                ". Нажмите «Повторить»."
                        )
                    }
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                setStage("Запуск интерфейса", 62)
                handler.postDelayed({
                    if (ready) return@postDelayed
                    view.evaluateJavascript(
                        "(window.S && window.S.booted) ? '1' : '0'"
                    ) { value ->
                        if (value == "\"1\"" || value == "1") markReady()
                    }
                }, 1500)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                if (url.scheme == "https" || url.scheme == "http") {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                }
                return true
            }
        }
        root = FrameLayout(this)
        root.setBackgroundColor(0xFF0F1216.toInt())
        root.addView(
            web,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        splash = buildSplash()
        splash?.let {
            root.addView(
                it,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(root)
        registerEvents()
        startWatchdog()
        handler.postDelayed({ loadApp() }, 60)
        handleIntent(intent)
    }

    private var loadAttempts = 0

    private fun loadApp() {
        ready = false
        loadAttempts += 1
        setStage(if (loadAttempts > 1) "Повторная загрузка интерфейса" else "Загрузка интерфейса", 4)
        if (loadAttempts > 1) {
            web.clearCache(true)
        }
        web.loadUrl("https://appassets.androidplatform.net/assets/ui/index.html")
    }

    /**
     * Экран загрузки: рисуется нативно, поэтому виден даже если WebView ещё не готов.
     */
    private fun buildSplash(): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
            setBackgroundColor(0xFF0F1216.toInt())
        }

        val logo = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(0xFF5B8CFF.toInt())
            }
        }
        wrap.addView(logo, LinearLayout.LayoutParams(dp(64), dp(64)))

        val title = TextView(this).apply {
            text = "botCHAT"
            setTextColor(0xFFE7EBF0.toInt())
            textSize = 24f
            gravity = Gravity.CENTER
        }
        wrap.addView(title, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(18) })

        splashStage = TextView(this).apply {
            text = "Запуск"
            setTextColor(0xFF8B95A3.toInt())
            textSize = 13f
            gravity = Gravity.CENTER
        }
        wrap.addView(splashStage, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) })

        splashProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 5
            progressTintList = android.content.res.ColorStateList.valueOf(0xFF5B8CFF.toInt())
            progressBackgroundTintList = android.content.res.ColorStateList.valueOf(0xFF232A33.toInt())
        }
        wrap.addView(splashProgress, LinearLayout.LayoutParams(dp(220), dp(4)).apply { topMargin = dp(18) })

        splashDetail = TextView(this).apply {
            text = ""
            setTextColor(0xFF6B7684.toInt())
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, 0)
        }
        wrap.addView(splashDetail, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        splashRetry = Button(this).apply {
            text = "Повторить"
            visibility = View.GONE
            setTextColor(0xFF0B0E13.toInt())
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF5B8CFF.toInt())
            }
            setOnClickListener {
                hideError()
                loadAttempts = 0
                loadApp()
                startWatchdog()
            }
        }
        wrap.addView(splashRetry, LinearLayout.LayoutParams(dp(180), dp(42)).apply { topMargin = dp(16) })

        return wrap
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun setStage(text: String, percent: Int) {
        runOnUiThread {
            splashStage?.text = text
            splashProgress?.progress = percent.coerceIn(0, 100)
        }
    }

    private fun showError(detail: String) {
        runOnUiThread {
            splashDetail?.text = detail
            splashRetry?.visibility = View.VISIBLE
            splashProgress?.isIndeterminate = false
        }
    }

    private fun hideError() {
        runOnUiThread {
            splashDetail?.text = ""
            splashRetry?.visibility = View.GONE
        }
    }

    override fun onResume() {
        super.onResume()
        if (!ready && splash == null) {
            splash = buildSplash()
            root.addView(
                splash,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            startWatchdog()
        }
    }

    private fun markReady() {
        if (ready) return
        ready = true
        stopWatchdog()
        runOnUiThread {
            splashProgress?.progress = 100
            splashStage?.text = "Готово"
            val view = splash ?: return@runOnUiThread
            view.animate().alpha(0f).setDuration(180).withEndAction {
                root.removeView(view)
                splash = null
            }.start()
        }
    }

    private fun startWatchdog() {
        stopWatchdog()
        val task = Runnable {
            if (ready) return@Runnable
            if (splashDetail?.text.isNullOrBlank()) {
                splashDetail?.text = "Загрузка занимает больше времени, чем обычно"
            }
            val slow = Runnable {
                if (!ready) {
                    showError("Интерфейс не ответил. Проверьте свободное место и повторите загрузку.")
                }
            }
            handler.postDelayed(slow, 12_000)
        }
        watchdog = task
        handler.postDelayed(task, 6_000)
    }

    private fun stopWatchdog() {
        watchdog?.let { handler.removeCallbacks(it) }
        watchdog = null
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) {
            pendingPick = null
            return
        }
        if (requestCode != REQ_FILES && requestCode != REQ_IMAGE) return
        val uris = ArrayList<Uri>()
        val clip = data?.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
        } else if (data?.data != null) {
            uris.add(data.data!!)
        }
        pendingPick?.invoke(uris)
        pendingPick = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun registerEvents() {
        val filter = IntentFilter(Notifier.EVENT)
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val name = intent.getStringExtra("event") ?: return
                val raw = intent.getStringExtra("payload") ?: "{}"
                val payload = runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
                emit(name, payload)
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
    }

    private fun assetResponse(path: String): WebResourceResponse? {
        val clean = path.substringBefore('?').trimStart('/').ifBlank { "index.html" }
        return try {
            val stream = assets.open("ui/$clean")
            val mime = when {
                clean.endsWith(".js") -> "application/javascript"
                clean.endsWith(".css") -> "text/css"
                clean.endsWith(".html") -> "text/html"
                clean.endsWith(".json") -> "application/json"
                clean.endsWith(".svg") -> "image/svg+xml"
                clean.endsWith(".png") -> "image/png"
                else -> "application/octet-stream"
            }
            WebResourceResponse(mime, "utf-8", stream)
        } catch (_: Exception) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    private fun handleIntent(intent: Intent?) {
        val chatId = intent?.getStringExtra("chat_id") ?: return
        val action = intent.getStringExtra("action") ?: "open"
        runCatching {
            web.evaluateJavascript(
                "window.BCNative && window.BCNative.onIntent(${JSONObject.quote(action)}, ${JSONObject.quote(chatId)})",
                null
            )
        }
    }

    override fun emit(event: String, payload: JSONObject) {
        val js = "window.BCEmit && window.BCEmit(${JSONObject.quote(event)}, $payload);"
        runOnUiThread {
            if (::web.isInitialized) web.evaluateJavascript(js, null)
        }
    }

    /**
     * Системная кнопка «Назад» идёт в web-навигацию: сначала закрываются шторки,
     * затем возврат из чата/раздела. Выход — только когда стек пуст.
     */
    private fun handleBackPressed() {
        if (!::web.isInitialized) {
            finish()
            return
        }
        web.evaluateJavascript(
            "window.BCNative && window.BCNative.onBack ? " +
                "(window.BCNative.onBack() ? '1' : '0') : '0'"
        ) { handled ->
            if (handled != "\"1\"" && handled != "1") {
                runOnUiThread { finish() }
            }
        }
    }

    override fun onBackPressed() {
        handleBackPressed()
    }

    override fun onDestroy() {
        receiver?.let { runCatching { unregisterReceiver(it) } }
        receiver = null
        current = null
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    inner class Bridge {

        /**
         * Асинхронная точка входа: сетевые операции не блокируют JS-поток,
         * результат приходит событием "bridge.result" с тем же id.
         */
        @JavascriptInterface
        fun async(method: String, arg: String, requestId: String): Boolean {
            val payload = runCatching { if (arg.isBlank()) JSONObject() else JSONObject(arg) }
                .getOrElse {
                    reply(requestId, err("bad payload"))
                    return true
                }
            val op = payload.optString("op")
            if (method == "api" && !Api.isNetworkOp(op)) {
                reply(requestId, runCatching { Api.dispatch(this@MainActivity, payload) }
                    .getOrElse { err(it.message ?: "api failed") })
                return true
            }
            bridgePool.execute {
                val result = runCatching {
                    when (method) {
                        "api" -> Api.dispatch(this@MainActivity, payload)
                        "tool" -> Tools.run(
                            this@MainActivity,
                            payload.optString("chatId"),
                            payload.optString("name"),
                            payload.optJSONObject("args") ?: JSONObject()
                        )
                        else -> err("unknown async method: $method")
                    }
                }.getOrElse { err(it.message ?: "bridge failed") }
                reply(requestId, result)
            }
            return true
        }

        private fun reply(requestId: String, result: JSONObject) {
            if (requestId.isBlank()) return
            runOnUiThread {
                if (!::web.isInitialized) return@runOnUiThread
                web.evaluateJavascript(
                    "window.BCEmit && window.BCEmit('bridge.result', {id:" +
                        JSONObject.quote(requestId) + ",data:" + result + "})",
                    null
                )
            }
        }

        @JavascriptInterface
        fun call(method: String, arg: String): String {
            return try {
                val payload = if (arg.isBlank()) JSONObject() else JSONObject(arg)
                when (method) {
                    "log" -> {
                        val level = payload.optString("level", "info")
                        val message = payload.optString("message")
                        android.util.Log.println(
                            if (level == "error") android.util.Log.ERROR else android.util.Log.INFO,
                            "botCHAT/JS",
                            message + " " + payload.optString("source") + ":" + payload.optInt("line")
                        )
                        ok()
                    }
                    "boot" -> {
                        setStage(
                            payload.optString("stage", "Загрузка"),
                            payload.optInt("progress", 10)
                        )
                        ok()
                    }
                    "ready" -> {
                        markReady()
                        ok()
                    }
                    "state" -> {
                        AppState.publish(payload.toString())
                        runOnUiThread {
                            TileService.requestRefresh(this@MainActivity)
                            dev.botchat.widget.StatusWidget.refresh(this@MainActivity)
                            val color = when {
                                payload.optBoolean("pendingPermission") -> 0xFFFFB020.toInt()
                                payload.optBoolean("agentRunning") -> 0xFF3FBF6F.toInt()
                                else -> 0x00000000
                            }
                            if (OverlayService.isVisible) OverlayService.setColor(color)
                        }
                        ok()
                    }
                    "fs" -> Fs.info(payload.optString("path"), payload.optString("chatId"))
                    "ls" -> Fs.list(payload.optString("path"), payload.optString("chatId"))
                    "readText" -> Fs.readText(
                        payload.optString("path"),
                        payload.optInt("maxBytes", 512 * 1024),
                        payload.optString("chatId")
                    )
                    "readBase64" -> Fs.readBase64(
                        payload.optString("path"),
                        payload.optInt("maxBytes", 4 * 1024 * 1024),
                        payload.optString("chatId")
                    )
                    "writeText" -> Fs.writeText(
                        payload.optString("path"),
                        payload.optString("text"),
                        payload.optString("chatId")
                    )
                    "mkdir" -> Fs.mkdir(payload.optString("path"), payload.optString("chatId"))
                    "delete" -> Fs.delete(payload.optString("path"), payload.optString("chatId"))
                    "copy" -> clip(payload.optString("text"))
                    "share" -> share(payload.optString("text"), payload.optString("title"))
                    "openLink" -> openLink(payload.optString("url"))
                    "notify" -> Notifier.post(this@MainActivity, payload)
                    "toast" -> toast(payload.optString("text"))
                    "pick" -> pick(payload.optString("kind"))
                    "env" -> env()
                    "export.text" -> exportText(payload.optString("name"), payload.optString("text"))
                    "settings.overlay" -> {
                        runOnUiThread {
                            runCatching {
                                startActivity(
                                    Intent(
                                        android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                        Uri.parse("package:$packageName")
                                    )
                                )
                            }
                        }
                        ok()
                    }
                    "api" -> Api.dispatch(this@MainActivity, payload)
                    "tool" -> Tools.run(
                        this@MainActivity,
                        payload.optString("chatId"),
                        payload.optString("name"),
                        payload.optJSONObject("args") ?: JSONObject()
                    )
                    else -> err("unknown method: $method")
                }.toString()
            } catch (t: Throwable) {
                err(t.message ?: t.javaClass.simpleName).toString()
            }
        }

        private fun toast(text: String): JSONObject {
            runOnUiThread { Toast.makeText(this@MainActivity, text, Toast.LENGTH_SHORT).show() }
            return ok()
        }

        private fun clip(text: String): JSONObject {
            val cm = getSystemService(ClipboardManager::class.java)
            cm.setPrimaryClip(ClipData.newPlainText("botCHAT", text))
            return ok()
        }

        private fun share(text: String, title: String): JSONObject {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
                putExtra(Intent.EXTRA_TITLE, title)
            }
            startActivity(Intent.createChooser(send, title))
            return ok()
        }

        private fun openLink(url: String): JSONObject {
            if (!url.startsWith("https://") && !url.startsWith("http://")) return err("scheme")
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            return ok()
        }

        private fun exportText(name: String, text: String): JSONObject {
            val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "export.txt" }
            val dir = File(getExternalFilesDir(null), "exports").apply { mkdirs() }
            val file = File(dir, safe)
            val tmp = File(dir, ".$safe.tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
            return ok().put("path", file.absolutePath).put("uri", Uri.fromFile(file).toString())
        }

        private fun pick(kind: String): JSONObject {
            pendingPick = { uris -> emitPicked(uris) }
            runOnUiThread {
                val intent = Intent(if (kind == "image") Intent.ACTION_GET_CONTENT else Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (kind == "image") "image/*" else "*/*"
                    if (kind != "image") putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                startActivityForResult(intent, if (kind == "image") REQ_IMAGE else REQ_FILES)
            }
            return ok()
        }

        private fun emitPicked(uris: List<Uri>) {
            val arr = JSONArray()
            uris.forEach { uri ->
                val name = queryName(uri)
                val size = querySize(uri)
                val stored = runCatching { Fs.importAttachment(uri, name) }.getOrNull()
                arr.put(
                    JSONObject()
                        .put("name", name)
                        .put("size", size)
                        .put("mime", contentResolver.getType(uri) ?: "application/octet-stream")
                        .put("path", stored?.absolutePath ?: "")
                )
            }
            emit("picked", JSONObject().put("items", arr))
        }

        private fun queryName(uri: Uri): String {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0 && !c.isNull(idx)) return c.getString(idx)
                }
            }
            return uri.lastPathSegment ?: "file"
        }

        private fun querySize(uri: Uri): Long {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.SIZE)
                    if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx)
                }
            }
            return 0
        }

        private fun env(): JSONObject {
            val p = packageManager.getPackageInfo(packageName, 0)
            val runtime = Runtime.envInfo(this@MainActivity)
            return ok()
                .put("versionName", p.versionName ?: "0")
                .put("versionCode", if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong())
                .put("sdk", Build.VERSION.SDK_INT)
                .put("abi", Build.SUPPORTED_ABIS.joinToString(","))
                .put("rootfs", runtime.optBoolean("rootfs"))
                .put("bash", runtime.optBoolean("bash"))
                .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
        }
    }

    companion object {
        @Volatile
        private var current: MainActivity? = null

        fun host(): BridgeHost? = current

        fun ok(): JSONObject = JSONObject().put("ok", true)
        fun err(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)
    }
}

interface BridgeHost {
    fun emit(event: String, payload: JSONObject)
}