package com.fjzhosts.changshipin.nativebridge

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import com.getcapacitor.JSObject
import org.json.JSONObject
import org.json.JSONTokener

/**
 * 一个原生 WebView 覆盖层，对应渲染层里的一个 <webview> 元素。
 * 由 JS 传入 CSS 像素的矩形，这里换算成物理像素后覆盖在 Capacitor WebView 上方。
 */
@SuppressLint("SetJavaScriptEnabled")
class WebviewHost(
    private val plugin: ChangshipinNativePlugin,
    val id: String,
    private val sniffMode: Boolean,
    private val onEvent: (String, JSObject) -> Unit,
) {
    companion object {
        const val UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
        private const val PAGE_SCRIPT = """
        (function(){
          if (window.__cspBridgeInstalled) return;
          window.__cspBridgeInstalled = true;
          var last = '';
          function report(){
            var u = location.href;
            if (u === last) return;
            last = u;
            try { ChangshipinPage.navigate(u, document.title || ''); } catch(e) {}
          }
          try {
            var push = history.pushState, replace = history.replaceState;
            history.pushState = function(){ var r = push.apply(this, arguments); setTimeout(report, 0); return r; };
            history.replaceState = function(){ var r = replace.apply(this, arguments); setTimeout(report, 0); return r; };
          } catch(e) {}
          addEventListener('popstate', report);
          addEventListener('hashchange', report);
          addEventListener('DOMContentLoaded', report);
          setInterval(report, 700);
          try {
            var t = document.querySelector('title');
            if (t) new MutationObserver(function(){ try { ChangshipinPage.title(document.title || ''); } catch(e) {} }).observe(t, { childList: true, subtree: true });
          } catch(e) {}
        })();
        """
        private const val SNIFF_SCRIPT = """
        (function(){
          if (window.__cspSnifferInstalled) return;
          window.__cspSnifferInstalled = true;
          var seen = {};
          function report(raw){
            try {
              if (!raw) return;
              var u = new URL(raw, location.href).href;
              if (!/^https?:/i.test(u)) return;
              if (!/\.(m3u8|mp4|flv)(\?|#|$)/i.test(u) && !/\/m3u8\//i.test(u)) return;
              if (/\.(ts|m4s|jpg|jpeg|png|webp|avif)(\?|#|$)/i.test(u)) return;
              if (seen[u]) return;
              seen[u] = 1;
              ChangshipinPage.media(u);
            } catch(e) {}
          }
          try {
            var open = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(m, u){ report(u); return open.apply(this, arguments); };
          } catch(e) {}
          try {
            var f = window.fetch;
            if (f) window.fetch = function(input){ try { report(typeof input === 'string' ? input : (input && input.url)); } catch(e) {} return f.apply(this, arguments); };
          } catch(e) {}
          try {
            var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            if (d && d.set) Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get: d.get, set: function(v){ report(v); return d.set.call(this, v); } });
          } catch(e) {}
          setInterval(function(){
            try {
              var vs = document.querySelectorAll('video');
              for (var i = 0; i < vs.length; i++) if (vs[i].currentSrc) report(vs[i].currentSrc);
            } catch(e) {}
          }, 800);
          setTimeout(function(){
            try {
              var v = document.querySelector('video');
              if (v) { v.muted = true; v.play().catch(function(){}); }
              var b = document.querySelector('[class*=play],[aria-label*=播放]');
              if (b && b.click) b.click();
            } catch(e) {}
          }, 1200);
        })();
        """
    }

    private val activity: AppCompatActivity = plugin.getActivity()
    private var webView: WebView? = null
    private var root: ViewGroup? = null
    private var fullscreenView: View? = null
    private var fullscreenContainer: FrameLayout? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var currentUrl = ""
    private var currentTitle = ""
    private var loading = false
    private var muted = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mediaSeen = LinkedHashSet<String>()

    fun create(src: String) {
        activity.runOnUiThread {
            if (webView != null) {
                if (src.isNotEmpty()) webView?.loadUrl(src)
                return@runOnUiThread
            }
            val view = WebView(activity)
            configure(view)
            val container = activity.findViewById<ViewGroup>(android.R.id.content)
            root = container
            val metrics = activity.resources.displayMetrics
            val params = FrameLayout.LayoutParams(metrics.widthPixels, metrics.heightPixels).apply {
                leftMargin = -14000
                topMargin = 0
            }
            view.alpha = 0.01f
            container.addView(view, params)
            webView = view
            if (src.isNotEmpty()) {
                currentUrl = src
                view.loadUrl(src)
            }
        }
    }

    private fun configure(view: WebView) {
        view.setBackgroundColor(Color.BLACK)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = UA
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        }
        view.addJavascriptInterface(PageBridge(), "ChangshipinPage")
        view.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                currentUrl = url ?: currentUrl
                loading = true
                inject(view, PAGE_SCRIPT)
                if (sniffMode) inject(view, SNIFF_SCRIPT)
                emit("did-start-loading")
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                currentUrl = url ?: currentUrl
                loading = false
                if (!sniffMode) inject(view, PAGE_SCRIPT)
                if (sniffMode) {
                    inject(view, PAGE_SCRIPT)
                    inject(view, SNIFF_SCRIPT)
                }
                currentTitle = view?.title ?: currentTitle
                emit("did-finish-load")
                emit("did-stop-loading")
            }

            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                if (!url.isNullOrEmpty()) {
                    currentUrl = url
                    emit("did-navigate-in-page")
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("about:")) return false
                try {
                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(intent)
                } catch (_: Exception) {
                }
                return true
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) error?.errorCode ?: 0 else 0
                    val description = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) error?.description?.toString() ?: "" else ""
                    if (code != -3) {
                        emit("did-fail-load", extra = mapOf("errorCode" to code, "errorDescription" to description, "isMainFrame" to true))
                    }
                }
            }

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                if (sniffMode) collectMedia(request?.url?.toString() ?: "")
                return null
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress >= 100) loading = false
            }

            override fun onReceivedTitle(view: WebView?, title: String?) {
                currentTitle = title ?: ""
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.deny()
            }

            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean {
                return false
            }

            override fun onShowCustomView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
                if (view == null || fullscreenView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                val container = activity.findViewById<ViewGroup>(android.R.id.content)
                val wrapper = FrameLayout(activity)
                wrapper.setBackgroundColor(Color.BLACK)
                wrapper.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                container.addView(wrapper, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                fullscreenView = view
                fullscreenContainer = wrapper
                fullscreenCallback = callback
                hideSystemBars()
            }

            override fun onHideCustomView() {
                val view = fullscreenView ?: return
                val wrapper = fullscreenContainer
                val callback = fullscreenCallback
                try {
                    wrapper?.removeView(view)
                    (wrapper?.parent as? ViewGroup)?.removeView(wrapper)
                } catch (_: Exception) {
                }
                fullscreenView = null
                fullscreenContainer = null
                fullscreenCallback = null
                showSystemBars()
                try {
                    callback?.onCustomViewHidden()
                } catch (_: Exception) {
                }
            }
        }
        view.setDownloadListener { url, _, _, _, _ ->
            try {
                activity.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Exception) {
            }
        }
    }

    private fun inject(view: WebView?, script: String) {
        if (view == null) return
        try {
            view.evaluateJavascript(script, null)
        } catch (_: Exception) {
        }
    }

    private fun collectMedia(url: String) {
        if (url.isEmpty()) return
        val lower = url.lowercase()
        if (!lower.startsWith("http")) return
        if (!lower.contains(".m3u8") && !lower.contains(".mp4") && !lower.contains(".flv") && !lower.contains("/m3u8/")) return
        if (lower.contains(".ts") || lower.contains(".m4s")) return
        if (mediaSeen.add(url)) {
            plugin.notifySniffer(id, url)
        }
    }

    fun load(url: String) {
        if (url.isEmpty()) return
        currentUrl = url
        activity.runOnUiThread {
            webView?.loadUrl(url)
        }
    }

    fun reload() {
        activity.runOnUiThread { webView?.reload() }
    }

    fun stop() {
        activity.runOnUiThread { webView?.stopLoading() }
    }

    fun goBack() {
        activity.runOnUiThread { if (webView?.canGoBack() == true) webView?.goBack() }
    }

    fun goForward() {
        activity.runOnUiThread { if (webView?.canGoForward() == true) webView?.goForward() }
    }

    fun setFrame(x: Float, y: Float, width: Float, height: Float, visible: Boolean) {
        activity.runOnUiThread {
            val view = webView ?: return@runOnUiThread
            val density = activity.resources.displayMetrics.density
            val params = view.layoutParams as? FrameLayout.LayoutParams ?: return@runOnUiThread
            if (!visible || width <= 1f || height <= 1f) {
                // 隐藏时不要缩成 1x1：搜索页/嗅探页需要一个正常的视口才能把结果渲染出来。
                // 移到屏幕外 + 近乎透明，既不挡 UI，也让页面继续跑 JS。
                params.width = activity.resources.displayMetrics.widthPixels
                params.height = activity.resources.displayMetrics.heightPixels
                params.leftMargin = -14000
                params.topMargin = 0
                view.visibility = View.VISIBLE
                view.alpha = 0.01f
                view.clearFocus()
            } else {
                params.width = (width * density).toInt()
                params.height = (height * density).toInt()
                params.leftMargin = (x * density).toInt()
                params.topMargin = (y * density).toInt()
                view.visibility = View.VISIBLE
                view.alpha = 1f
                view.bringToFront()
            }
            view.layoutParams = params
            view.requestLayout()
        }
    }

    fun eval(script: String, callback: (Any?) -> Unit) {
        activity.runOnUiThread {
            val view = webView
            if (view == null) {
                callback(null)
                return@runOnUiThread
            }
            try {
                view.evaluateJavascript(script) { raw -> callback(parseJsValue(raw)) }
            } catch (error: Exception) {
                callback(null)
            }
        }
    }

    fun setMuted(value: Boolean) {
        muted = value
        activity.runOnUiThread {
            val view = webView ?: return@runOnUiThread
            val script = if (value) {
                "(function(){try{var vs=document.querySelectorAll('video,audio');for(var i=0;i<vs.length;i++){vs[i].muted=true;try{vs[i].pause()}catch(e){}}}catch(e){}})()"
            } else {
                "(function(){try{var vs=document.querySelectorAll('video,audio');for(var i=0;i<vs.length;i++){vs[i].muted=false}}catch(e){}})()"
            }
            try {
                view.evaluateJavascript(script, null)
            } catch (_: Exception) {
            }
            if (value) view.onPause() else view.onResume()
        }
    }

    fun state(): JSObject {
        val view = webView
        return JSObject().apply {
            put("url", currentUrl)
            put("title", currentTitle)
            put("canGoBack", view?.canGoBack() == true)
            put("canGoForward", view?.canGoForward() == true)
            put("loading", loading)
        }
    }

    fun currentTitle(): String = currentTitle

    fun destroy() {
        activity.runOnUiThread {
            val view = webView ?: return@runOnUiThread
            webView = null
            try {
                view.stopLoading()
                view.loadUrl("about:blank")
                (view.parent as? ViewGroup)?.removeView(view)
                view.removeAllViews()
                view.destroy()
            } catch (_: Exception) {
            }
            fullscreenView?.let { custom ->
                try {
                    (custom.parent as? ViewGroup)?.removeView(custom)
                    (fullscreenContainer?.parent as? ViewGroup)?.removeView(fullscreenContainer)
                } catch (_: Exception) {
                }
            }
            fullscreenView = null
            fullscreenContainer = null
        }
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            activity.window.insetsController?.apply {
                hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            activity.window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
    }

    private fun showSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            activity.window.insetsController?.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
        } else {
            @Suppress("DEPRECATION")
            activity.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun emit(type: String, extra: Map<String, Any?> = emptyMap()) {
        val data = JSObject().apply {
            put("id", id)
            put("type", type)
            put("url", currentUrl)
            put("title", currentTitle)
            put("canGoBack", webView?.canGoBack() == true)
            put("canGoForward", webView?.canGoForward() == true)
            put("loading", loading)
            for ((key, value) in extra) put(key, value)
        }
        plugin.notifyWebview(data)
    }

    inner class PageBridge {
        @JavascriptInterface
        fun navigate(url: String?, title: String?) {
            if (!url.isNullOrEmpty()) currentUrl = url
            if (title != null) currentTitle = title
            emit("did-navigate")
        }

        @JavascriptInterface
        fun title(title: String?) {
            currentTitle = title ?: ""
            emit("page-title-updated")
        }

        @JavascriptInterface
        fun media(url: String?) {
            if (url != null) collectMedia(url)
        }
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
