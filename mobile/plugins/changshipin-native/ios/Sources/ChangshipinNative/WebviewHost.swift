import Foundation
import UIKit
import WebKit
import Capacitor

/// 一个原生 WKWebView 覆盖层，对应渲染层里的一个 <webview> 元素。
/// JS 传入 CSS 像素矩形（iOS 上 1pt = 1 CSS px），这里直接按 pt 布局。
final class WebviewHost: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"

    private static let pageScript = """
    (function(){
      if (window.__cspBridgeInstalled) return;
      window.__cspBridgeInstalled = true;
      function post(type, data) {
        try {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ChangshipinPage) {
            var payload = data || {};
            payload.type = type;
            window.webkit.messageHandlers.ChangshipinPage.postMessage(payload);
          } else if (window.ChangshipinPage) {
            if (type === 'navigate') window.ChangshipinPage.navigate(data.url, data.title);
            else if (type === 'title') window.ChangshipinPage.title(data.title);
            else if (type === 'media') window.ChangshipinPage.media(data.url);
          }
        } catch (e) {}
      }
      var last = '';
      function report(){
        var u = location.href;
        if (u === last) return;
        last = u;
        post('navigate', { url: u, title: document.title || '' });
      }
      try {
        var push = history.pushState, replace = history.replaceState;
        history.pushState = function(){ var r = push.apply(this, arguments); setTimeout(report, 0); return r; };
        history.replaceState = function(){ var r = replace.apply(this, arguments); setTimeout(report, 0); return r; };
      } catch (e) {}
      addEventListener('popstate', report);
      addEventListener('hashchange', report);
      addEventListener('DOMContentLoaded', report);
      setInterval(report, 700);
      try {
        var t = document.querySelector('title');
        if (t) new MutationObserver(function(){ post('title', { title: document.title || '' }); }).observe(t, { childList: true, subtree: true });
      } catch (e) {}
    })();
    """

    private static let sniffScript = """
    (function(){
      if (window.__cspSnifferInstalled) return;
      window.__cspSnifferInstalled = true;
      var seen = {};
      function report(raw){
        try {
          if (!raw) return;
          var u = new URL(raw, location.href).href;
          if (!/^https?:/i.test(u)) return;
          if (!/\\.(m3u8|mp4|flv)(\\?|#|$)/i.test(u) && !/\\/m3u8\\//i.test(u)) return;
          if (/\\.(ts|m4s|jpg|jpeg|png|webp|avif)(\\?|#|$)/i.test(u)) return;
          if (seen[u]) return;
          seen[u] = 1;
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ChangshipinPage) {
            window.webkit.messageHandlers.ChangshipinPage.postMessage({ type: 'media', url: u });
          } else if (window.ChangshipinPage) {
            window.ChangshipinPage.media(u);
          }
        } catch (e) {}
      }
      try {
        var open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, u){ report(u); return open.apply(this, arguments); };
      } catch (e) {}
      try {
        var f = window.fetch;
        if (f) window.fetch = function(input){ try { report(typeof input === 'string' ? input : (input && input.url)); } catch (e) {} return f.apply(this, arguments); };
      } catch (e) {}
      try {
        var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (d && d.set) Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get: d.get, set: function(v){ report(v); return d.set.call(this, v); } });
      } catch (e) {}
      setInterval(function(){
        try {
          var vs = document.querySelectorAll('video');
          for (var i = 0; i < vs.length; i++) if (vs[i].currentSrc) report(vs[i].currentSrc);
        } catch (e) {}
      }, 800);
      setTimeout(function(){
        try {
          var v = document.querySelector('video');
          if (v) { v.muted = true; v.play().catch(function(){}); }
          var b = document.querySelector('[class*=play],[aria-label*=播放]');
          if (b && b.click) b.click();
        } catch (e) {}
      }, 1200);
    })();
    """

    private weak var plugin: ChangshipinNativePlugin?
    private let id: String
    private let sniffMode: Bool
    private var webView: WKWebView?
    private var container: UIView?
    private var currentUrl = ""
    private var currentTitle = ""
    private var loading = false
    private var muted = false
    var onFinish: (() -> Void)?

    init(plugin: ChangshipinNativePlugin, id: String, sniffMode: Bool) {
        self.plugin = plugin
        self.id = id
        self.sniffMode = sniffMode
        super.init()
    }

    func create(src: String) {
        DispatchQueue.main.async {
            if self.webView != nil {
                if !src.isEmpty, let url = URL(string: src) {
                    self.webView?.load(URLRequest(url: url))
                }
                return
            }
            // Capacitor 的 CAPBridgeViewController 把 view 直接设成了 WKWebView。
            // 加到 viewController.view（也就是 WKWebView 自己）上会被内部滚动层盖住；
            // 加到 window 最稳，window 还没挂上时再退到 superview。
            guard let bridge = self.plugin?.bridge,
                  let capacitorWebView = bridge.webView else { return }
            let hostView = capacitorWebView.window ?? capacitorWebView.superview ?? bridge.viewController?.view
            guard let hostView = hostView else { return }
            let config = WKWebViewConfiguration()
            config.allowsInlineMediaPlayback = true
            config.mediaTypesRequiringUserActionForPlayback = []
            config.allowsPictureInPictureMediaPlayback = true
            config.websiteDataStore = .default()
            config.preferences.javaScriptCanOpenWindowsAutomatically = false
            let controller = WKUserContentController()
            controller.add(self, name: "ChangshipinPage")
            controller.addUserScript(WKUserScript(source: Self.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            if self.sniffMode {
                controller.addUserScript(WKUserScript(source: Self.sniffScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            }
            config.userContentController = controller
            let metrics = UIScreen.main.bounds
            let view = WKWebView(frame: CGRect(x: -14000, y: 0, width: max(320, metrics.width), height: max(480, metrics.height)), configuration: config)
            view.navigationDelegate = self
            view.uiDelegate = self
            view.customUserAgent = Self.ua
            view.allowsBackForwardNavigationGestures = false
            view.scrollView.bounces = false
            view.scrollView.contentInsetAdjustmentBehavior = .never
            view.isOpaque = true
            view.backgroundColor = .black
            view.scrollView.backgroundColor = .black
            view.alpha = 0.01
            view.isUserInteractionEnabled = false
            hostView.addSubview(view)
            self.webView = view
            self.container = hostView
            if !src.isEmpty {
                self.currentUrl = src
                if let url = URL(string: src) {
                    view.load(URLRequest(url: url))
                }
            }
        }
    }

    func load(_ url: String) {
        guard !url.isEmpty else { return }
        currentUrl = url
        DispatchQueue.main.async {
            guard let view = self.webView, let target = URL(string: url) else { return }
            view.load(URLRequest(url: target))
        }
    }

    func reload() {
        DispatchQueue.main.async { self.webView?.reload() }
    }

    func stop() {
        DispatchQueue.main.async { self.webView?.stopLoading() }
    }

    func goBack() {
        DispatchQueue.main.async {
            if self.webView?.canGoBack == true { self.webView?.goBack() }
        }
    }

    func goForward() {
        DispatchQueue.main.async {
            if self.webView?.canGoForward == true { self.webView?.goForward() }
        }
    }

    func setFrame(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, visible: Bool) {
        DispatchQueue.main.async {
            guard let view = self.webView else { return }
            if !visible || width <= 1 || height <= 1 {
                let screen = UIScreen.main.bounds
                view.frame = CGRect(x: -14000, y: 0, width: max(320, screen.width), height: max(480, screen.height))
                view.alpha = 0.01
                view.isUserInteractionEnabled = false
                view.endEditing(true)
                return
            }
            var origin = CGPoint.zero
            if let host = self.plugin?.bridge?.webView, let container = self.container {
                origin = host.convert(CGPoint.zero, to: container)
            }
            view.frame = CGRect(x: origin.x + x, y: origin.y + y, width: width, height: height)
            view.alpha = 1
            view.isUserInteractionEnabled = true
            self.container?.bringSubviewToFront(view)
        }
    }

    func eval(_ script: String, completion: @escaping (Any?) -> Void) {
        DispatchQueue.main.async {
            guard let view = self.webView else {
                completion(nil)
                return
            }
            view.evaluateJavaScript(script) { result, error in
                if error != nil {
                    completion(nil)
                } else {
                    completion(result)
                }
            }
        }
    }

    func setMuted(_ value: Bool) {
        muted = value
        DispatchQueue.main.async {
            guard let view = self.webView else { return }
            let script = value
                ? "(function(){try{var vs=document.querySelectorAll('video,audio');for(var i=0;i<vs.length;i++){vs[i].muted=true;try{vs[i].pause()}catch(e){}}}catch(e){}})()"
                : "(function(){try{var vs=document.querySelectorAll('video,audio');for(var i=0;i<vs.length;i++){vs[i].muted=false}}catch(e){}})()"
            view.evaluateJavaScript(script, completionHandler: nil)
            if #available(iOS 15.0, *) {
                view.setAllMediaPlaybackSuspended(value, completionHandler: nil)
            }
        }
    }

    func state() -> [String: Any] {
        return [
            "url": currentUrl,
            "title": currentTitle,
            "canGoBack": webView?.canGoBack ?? false,
            "canGoForward": webView?.canGoForward ?? false,
            "loading": loading
        ]
    }

    func currentTitleValue() -> String { currentTitle }

    /// 用于 pageEval：不显示、但保留一个正常视口，加载完页面再执行脚本。
    func prepareHiddenForEval() {
        DispatchQueue.main.async {
            guard let view = self.webView else { return }
            let screen = UIScreen.main.bounds
            view.frame = CGRect(x: -14000, y: 0, width: max(320, screen.width), height: max(480, screen.height))
            view.alpha = 0.01
            view.isUserInteractionEnabled = false
        }
    }

    func destroy() {
        DispatchQueue.main.async {
            guard let view = self.webView else { return }
            self.webView = nil
            view.configuration.userContentController.removeScriptMessageHandler(forName: "ChangshipinPage")
            view.stopLoading()
            view.loadHTMLString("", baseURL: nil)
            view.removeFromSuperview()
            self.container = nil
        }
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "navigate" {
            if let url = body["url"] as? String, !url.isEmpty { currentUrl = url }
            if let title = body["title"] as? String { currentTitle = title }
            emit("did-navigate")
        } else if type == "title" {
            if let title = body["title"] as? String { currentTitle = title }
            emit("page-title-updated")
        } else if type == "media" {
            if let url = body["url"] as? String { collectMedia(url) }
        }
    }

    private func collectMedia(_ url: String) {
        let lower = url.lowercased()
        guard lower.hasPrefix("http") else { return }
        guard lower.contains(".m3u8") || lower.contains(".mp4") || lower.contains(".flv") || lower.contains("/m3u8/") else { return }
        guard !lower.contains(".ts") && !lower.contains(".m4s") else { return }
        plugin?.notifySniffer(id: id, url: url)
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading = true
        emit("did-start-loading")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if let url = webView.url?.absoluteString, !url.isEmpty { currentUrl = url }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        if let url = webView.url?.absoluteString, !url.isEmpty { currentUrl = url }
        currentTitle = webView.title ?? currentTitle
        emit("did-finish-load")
        emit("did-stop-loading")
        onFinish?()
        onFinish = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        loading = false
        emit("did-fail-load", extra: [
            "errorCode": nsError.code,
            "errorDescription": nsError.localizedDescription,
            "isMainFrame": true
        ])
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" || scheme == "about" {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if ["tel", "mailto", "mqq", "weixin", "alipays", "intent"].contains(scheme) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        if let url = webView.url?.absoluteString, !url.isEmpty {
            currentUrl = url
            emit("did-navigate-in-page")
        }
    }

    // MARK: - WKUIDelegate
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        presentAlert(title: webView.title ?? "提示", message: message) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        presentAlert(title: webView.title ?? "提示", message: message) { completionHandler(true) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(defaultText)
    }

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    private func presentAlert(title: String, message: String, completion: @escaping () -> Void) {
        DispatchQueue.main.async {
            guard let controller = self.plugin?.bridge?.viewController else {
                completion()
                return
            }
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "知道了", style: .default) { _ in completion() })
            controller.present(alert, animated: true)
        }
    }

    private func emit(_ type: String, extra: [String: Any] = [:]) {
        var payload: [String: Any] = [
            "id": id,
            "type": type,
            "url": currentUrl,
            "title": currentTitle,
            "canGoBack": webView?.canGoBack ?? false,
            "canGoForward": webView?.canGoForward ?? false,
            "loading": loading
        ]
        for (key, value) in extra { payload[key] = value }
        plugin?.notifyWebview(payload)
    }
}
