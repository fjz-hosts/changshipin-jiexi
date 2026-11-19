package com.fjzhosts.changshipin.nativebridge

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import org.json.JSONTokener

@CapacitorPlugin(name = "ChangshipinNative")
class ChangshipinNativePlugin : Plugin() {
    private var proxy: StreamProxy? = null
    private val webviews = ConcurrentHashMap<String, WebviewHost>()
    private val sniffers = ConcurrentHashMap<String, WebviewHost>()
    private val snifferSeen = ConcurrentHashMap<String, MutableSet<String>>()

    override fun load() {
        try {
            proxy = StreamProxy().also { it.start() }
        } catch (_: Exception) {
        }
    }

    override fun handleOnDestroy() {
        for (host in webviews.values) host.destroy()
        webviews.clear()
        for (host in sniffers.values) host.destroy()
        sniffers.clear()
        proxy?.stop()
        proxy = null
    }

    override fun handleOnPause() {
        for (host in webviews.values) host.setMuted(true)
    }

    override fun handleOnResume() {
        // 不自动恢复：渲染层在切换标签时会显式调用 setWebviewMuted(false)
    }

    @PluginMethod
    fun startProxy(call: PluginCall) {
        try {
            val service = proxy ?: StreamProxy().also { proxy = it; it.start() }
            call.resolve(JSObject().put("port", service.port).put("token", service.token))
        } catch (error: Exception) {
            call.reject("取流代理启动失败：${error.message}")
        }
    }

    @PluginMethod
    fun createWebview(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val src = call.getString("src") ?: ""
        getActivity().runOnUiThread {
            try {
                val existing = webviews[id]
                if (existing != null) {
                    if (src.isNotEmpty()) existing.load(src)
                    call.resolve()
                    return@runOnUiThread
                }
                val host = WebviewHost(this, id, false) { _, _ -> }
                webviews[id] = host
                host.create(src)
                call.resolve()
            } catch (error: Exception) {
                call.reject("创建 WebView 失败：${error.message}")
            }
        }
    }

    @PluginMethod
    fun setWebviewFrame(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val host = webviews[id] ?: return call.resolve()
        host.setFrame(
            call.getFloat("x") ?: 0f,
            call.getFloat("y") ?: 0f,
            call.getFloat("width") ?: 1f,
            call.getFloat("height") ?: 1f,
            call.getBoolean("visible", false) ?: false
        )
        call.resolve()
    }

    @PluginMethod
    fun destroyWebview(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val host = webviews.remove(id)
        host?.destroy()
        call.resolve()
    }

    @PluginMethod
    fun loadWebview(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val url = call.getString("url") ?: return call.reject("缺少 url")
        webviews[id]?.load(url)
        call.resolve()
    }

    @PluginMethod
    fun reloadWebview(call: PluginCall) {
        webviews[call.getString("id") ?: ""]?.reload()
        call.resolve()
    }

    @PluginMethod
    fun stopWebview(call: PluginCall) {
        webviews[call.getString("id") ?: ""]?.stop()
        call.resolve()
    }

    @PluginMethod
    fun webviewBack(call: PluginCall) {
        webviews[call.getString("id") ?: ""]?.goBack()
        call.resolve()
    }

    @PluginMethod
    fun webviewForward(call: PluginCall) {
        webviews[call.getString("id") ?: ""]?.goForward()
        call.resolve()
    }

    @PluginMethod
    fun webviewEval(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val script = call.getString("script") ?: ""
        val host = webviews[id]
        if (host == null) {
            call.resolve(JSObject())
            return
        }
        host.eval(script) { value ->
            val result = JSObject()
            if (value != null) result.put("value", value)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun setWebviewMuted(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        webviews[id]?.setMuted(call.getBoolean("muted", false) ?: false)
        call.resolve()
    }

    @PluginMethod
    fun webviewState(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val host = webviews[id]
        if (host == null) {
            call.resolve(JSObject())
            return
        }
        getActivity().runOnUiThread {
            val state = host.state()
            call.resolve(state)
        }
    }

    @PluginMethod
    fun getCookies(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("缺少 url")
        try {
            val cookie = CookieManager.getInstance().getCookie(url) ?: ""
            call.resolve(JSObject().put("cookie", cookie))
        } catch (error: Exception) {
            call.resolve(JSObject().put("cookie", ""))
        }
    }

    @PluginMethod
    fun pageEval(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("缺少 url")
        val script = call.getString("script") ?: "document.title"
        val timeout = call.getInt("timeoutMs") ?: 18000
        getActivity().runOnUiThread {
            HiddenPage(this, url, script, timeout.toLong()) { value ->
                val result = JSObject()
                if (value != null) result.put("value", value)
                call.resolve(result)
            }.start()
        }
    }

    @PluginMethod
    fun createSniffer(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val url = call.getString("url") ?: return call.reject("缺少 url")
        getActivity().runOnUiThread {
            try {
                serverHost(id)?.destroy()
                snifferSeen[id] = java.util.Collections.synchronizedSet(LinkedHashSet())
                val host = WebviewHost(this, id, true) { _, _ -> }
                sniffers[id] = host
                host.create(url)
                call.resolve()
            } catch (error: Exception) {
                call.reject("创建嗅探页失败：${error.message}")
            }
        }
    }

    @PluginMethod
    fun snifferState(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        val host = sniffers[id]
        call.resolve(JSObject().put("title", host?.currentTitle() ?: ""))
    }

    @PluginMethod
    fun destroySniffer(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("缺少 id")
        sniffers.remove(id)?.destroy()
        snifferSeen.remove(id)
        call.resolve()
    }

    @PluginMethod
    fun publishDownload(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("缺少 path")
        val name = sanitizeName(call.getString("name") ?: "视频.ts")
        val mime = call.getString("mime") ?: "application/octet-stream"
        try {
            val source = File(Uri.parse(path).path ?: return call.reject("路径无效"))
            if (!source.exists()) return call.reject("文件不存在")
            val result = publishToDownloads(source, name, mime)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject("保存到下载目录失败：${error.message}")
        }
    }

    @PluginMethod
    fun openDownload(call: PluginCall) {
        val raw = call.getString("uri") ?: return call.reject("缺少 uri")
        getActivity().runOnUiThread {
            try {
                openUriString(raw)
                call.resolve(JSObject().put("ok", true))
            } catch (error: Exception) {
                call.reject("打开文件失败：${error.message}")
            }
        }
    }

    @PluginMethod
    fun shareDownload(call: PluginCall) {
        val raw = call.getString("uri") ?: return call.reject("缺少 uri")
        getActivity().runOnUiThread {
            try {
                val uri = toContentUri(raw)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = getActivity().contentResolver.getType(uri) ?: mimeOf(raw)
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                getActivity().startActivity(Intent.createChooser(intent, call.getString("name") ?: "分享文件").apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
                call.resolve(JSObject().put("ok", true))
            } catch (error: Exception) {
                call.reject("分享失败：${error.message}")
            }
        }
    }

    @PluginMethod
    fun openDownloadsFolder(call: PluginCall) {
        getActivity().runOnUiThread {
            try {
                getActivity().startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
                call.resolve(JSObject().put("ok", true))
            } catch (error: Exception) {
                call.reject("打开下载目录失败：${error.message}")
            }
        }
    }

    @PluginMethod
    fun installApk(call: PluginCall) {
        val raw = call.getString("path") ?: return call.reject("缺少 path")
        getActivity().runOnUiThread {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    !getActivity().packageManager.canRequestPackageInstalls()
                ) {
                    val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                        data = Uri.parse("package:${getActivity().packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    getActivity().startActivity(settings)
                    call.resolve(JSObject().put("ok", false).put("error", "请在系统设置里允许本应用安装未知来源应用，然后再次点击安装"))
                    return@runOnUiThread
                }
                val uri = toContentUri(raw)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                getActivity().startActivity(intent)
                call.resolve(JSObject().put("ok", true))
            } catch (error: Exception) {
                call.reject("打开安装器失败：${error.message}")
            }
        }
    }

    @PluginMethod
    fun getInfo(call: PluginCall) {
        try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                getActivity().packageManager.getPackageInfo(getActivity().packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                getActivity().packageManager.getPackageInfo(getActivity().packageName, 0)
            }
            val version = info.versionName ?: ""
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
            call.resolve(JSObject().put("version", version).put("build", code.toString()).put("platform", "android"))
        } catch (error: Exception) {
            call.resolve(JSObject().put("version", "").put("build", "").put("platform", "android"))
        }
    }

    fun notifyWebview(data: JSObject) {
        try {
            notifyListeners("webviewEvent", data)
        } catch (_: Exception) {
        }
    }

    fun notifySniffer(id: String, url: String) {
        val seen = snifferSeen[id] ?: return
        if (!seen.add(url)) return
        getActivity().runOnUiThread {
            try {
                notifyListeners("snifferMedia", JSObject().put("id", id).put("url", url))
            } catch (_: Exception) {
            }
        }
    }

    private fun serverHost(id: String): WebviewHost? = sniffers[id]

    private fun sanitizeName(raw: String): String =
        raw.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), " ").replace(Regex("\\s+"), " ").trim().ifEmpty { "视频.ts" }

    private fun publishToDownloads(source: File, name: String, mime: String): JSObject {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = getActivity().contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/长视频解析")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return publishToAppDownloads(source, name, mime)
            try {
                resolver.openOutputStream(target)?.use { out ->
                    source.inputStream().use { it.copyTo(out) }
                }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(target, values, null, null)
                return JSObject()
                    .put("ok", true)
                    .put("uri", target.toString())
                    .put("displayPath", "下载/长视频解析/$name")
            } catch (error: Exception) {
                try {
                    resolver.delete(target, null, null)
                } catch (_: Exception) {
                }
                return publishToAppDownloads(source, name, mime)
            }
        }
        return publishToAppDownloads(source, name, mime)
    }

    private fun publishToAppDownloads(source: File, name: String, mime: String): JSObject {
        val dir = File(getActivity().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "长视频解析")
        dir.mkdirs()
        val target = File(dir, name)
        source.copyTo(target, overwrite = true)
        val uri = FileProvider.getUriForFile(getActivity(), "${getActivity().packageName}.fileprovider", target)
        return JSObject()
            .put("ok", true)
            .put("uri", uri.toString())
            .put("displayPath", "Android/data/${getActivity().packageName}/files/Download/长视频解析/$name")
    }

    private fun toContentUri(raw: String): Uri {
        if (raw.startsWith("content://")) return Uri.parse(raw)
        val file = File(Uri.parse(raw).path ?: return Uri.parse(raw))
        return FileProvider.getUriForFile(getActivity(), "${getActivity().packageName}.fileprovider", file)
    }

    private fun openUriString(raw: String) {
        val uri = toContentUri(raw)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, getActivity().contentResolver.getType(uri) ?: mimeOf(raw))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        getActivity().startActivity(intent)
    }

    private fun mimeOf(raw: String): String = when {
        raw.contains(".ts") -> "video/mp2t"
        raw.contains(".mp4") -> "video/mp4"
        raw.contains(".apk") -> "application/vnd.android.package-archive"
        else -> "*/*"
    }

    /**
     * 隐藏 WebView 打开页面、执行一段 JS 并返回结果（爱奇艺 tvid 等场景）。
     */
    private class HiddenPage(
        private val plugin: ChangshipinNativePlugin,
        private val url: String,
        private val script: String,
        private val timeoutMs: Long,
        private val callback: (Any?) -> Unit,
    ) {
        private val activity = plugin.getActivity()
        private var webView: WebView? = null
        private var finished = false
        private var startedAt = 0L
        private val handler = Handler(Looper.getMainLooper())
        private val timeoutRunnable = Runnable { finish(null) }

        fun start() {
            try {
                val view = WebView(activity)
                view.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    databaseEnabled = true
                    userAgentString = WebviewHost.UA
                    mediaPlaybackRequiresUserGesture = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                }
                view.setBackgroundColor(android.graphics.Color.BLACK)
                view.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        handler.postDelayed({
                            if (finished) return@postDelayed
                            try {
                                view?.evaluateJavascript(script) { raw ->
                                    finish(parseJsValue(raw))
                                }
                            } catch (_: Exception) {
                                finish(null)
                            }
                        }, 2500)
                    }

                    override fun onReceivedError(view: WebView?, request: android.webkit.WebResourceRequest?, error: android.webkit.WebResourceError?) {
                        if (request?.isForMainFrame == true) finish(null)
                    }
                }
                val container = activity.findViewById<android.view.ViewGroup>(android.R.id.content)
                val metrics = activity.resources.displayMetrics
                container.addView(view, android.widget.FrameLayout.LayoutParams(metrics.widthPixels, metrics.heightPixels).apply {
                    leftMargin = -14000
                    topMargin = 0
                })
                webView = view
                startedAt = System.currentTimeMillis()
                handler.postDelayed(timeoutRunnable, timeoutMs)
                view.loadUrl(url)
            } catch (_: Exception) {
                finish(null)
            }
        }

        private fun finish(value: Any?) {
            if (finished) return
            finished = true
            handler.removeCallbacks(timeoutRunnable)
            try {
                val view = webView
                webView = null
                view?.stopLoading()
                view?.loadUrl("about:blank")
                (view?.parent as? android.view.ViewGroup)?.removeView(view)
                view?.destroy()
            } catch (_: Exception) {
            }
            callback(value)
        }

        private fun parseJsValue(raw: String?): Any? {
            if (raw == null) return null
            return try {
                val value = JSONTokener(raw).nextValue()
                if (value == JSONObject.NULL) null else value
            } catch (_: Exception) {
                raw
            }
        }
    }
}
