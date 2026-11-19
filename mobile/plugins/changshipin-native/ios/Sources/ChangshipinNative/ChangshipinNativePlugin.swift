import Foundation
import UIKit
import WebKit
import Capacitor

@objc(ChangshipinNativePlugin)
public class ChangshipinNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ChangshipinNativePlugin"
    public let jsName = "ChangshipinNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startProxy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createWebview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWebviewFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroyWebview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadWebview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadWebview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopWebview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webviewBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webviewForward", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webviewEval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWebviewMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webviewState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pageEval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createSniffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snifferState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroySniffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openDownloadsFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installApk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise)
    ]

    private var proxy: StreamProxy?
    private var webviews: [String: WebviewHost] = [:]
    private var sniffers: [String: WebviewHost] = [:]
    private var snifferSeen: [String: Set<String>] = [:]
    private var pageHosts: [String: WebviewHost] = [:]
    private var documentControllers: [UIDocumentInteractionController] = []

    public override func load() {
        proxy = StreamProxy()
        try? proxy?.start()
    }

    @objc func startProxy(_ call: CAPPluginCall) {
        if proxy == nil || proxy?.port == 0 {
            proxy = StreamProxy()
            try? proxy?.start()
        }
        guard let service = proxy, service.port != 0 else {
            call.reject("取流代理启动失败")
            return
        }
        call.resolve(["port": Int(service.port), "token": service.token])
    }

    @objc func createWebview(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        let src = call.getString("src") ?? ""
        DispatchQueue.main.async {
            if let existing = self.webviews[id] {
                if !src.isEmpty { existing.load(src) }
                call.resolve()
                return
            }
            let host = WebviewHost(plugin: self, id: id, sniffMode: false)
            self.webviews[id] = host
            host.create(src: src)
            call.resolve()
        }
    }

    @objc func setWebviewFrame(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let host = webviews[id] else {
            call.resolve()
            return
        }
        host.setFrame(
            x: CGFloat(call.getFloat("x") ?? 0),
            y: CGFloat(call.getFloat("y") ?? 0),
            width: CGFloat(call.getFloat("width") ?? 1),
            height: CGFloat(call.getFloat("height") ?? 1),
            visible: call.getBool("visible") ?? false
        )
        call.resolve()
    }

    @objc func destroyWebview(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        webviews.removeValue(forKey: id)?.destroy()
        call.resolve()
    }

    @objc func loadWebview(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let url = call.getString("url") else {
            call.reject("缺少参数")
            return
        }
        webviews[id]?.load(url)
        call.resolve()
    }

    @objc func reloadWebview(_ call: CAPPluginCall) {
        webviews[call.getString("id") ?? ""]?.reload()
        call.resolve()
    }

    @objc func stopWebview(_ call: CAPPluginCall) {
        webviews[call.getString("id") ?? ""]?.stop()
        call.resolve()
    }

    @objc func webviewBack(_ call: CAPPluginCall) {
        webviews[call.getString("id") ?? ""]?.goBack()
        call.resolve()
    }

    @objc func webviewForward(_ call: CAPPluginCall) {
        webviews[call.getString("id") ?? ""]?.goForward()
        call.resolve()
    }

    @objc func webviewEval(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        let script = call.getString("script") ?? ""
        guard let host = webviews[id] else {
            call.resolve([:])
            return
        }
        host.eval(script) { value in
            if let value = value, !(value is NSNull) {
                call.resolve(["value": value])
            } else {
                call.resolve([:])
            }
        }
    }

    @objc func setWebviewMuted(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        webviews[id]?.setMuted(call.getBool("muted", false))
        call.resolve()
    }

    @objc func webviewState(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let host = webviews[id] else {
            call.resolve([:])
            return
        }
        DispatchQueue.main.async {
            call.resolve(host.state())
        }
    }

    @objc func getCookies(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.resolve(["cookie": ""])
            return
        }
        let host = url.host ?? ""
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            let header = cookies.filter { cookie in
                let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
                return !domain.isEmpty && (host == domain || host.hasSuffix("." + domain))
            }.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            DispatchQueue.main.async {
                call.resolve(["cookie": header])
            }
        }
    }

    @objc func pageEval(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else {
            call.reject("缺少参数")
            return
        }
        let script = call.getString("script", "document.title")
        let timeout = call.getInt("timeoutMs", 18000)
        let id = "page-\(UUID().uuidString)"
        var finished = false
        let host = WebviewHost(plugin: self, id: id, sniffMode: false)
        pageHosts[id] = host
        let finish: (Any?) -> Void = { value in
            guard !finished else { return }
            finished = true
            self.pageHosts.removeValue(forKey: id)
            host.destroy()
            if let value = value, !(value is NSNull) {
                call.resolve(["value": value])
            } else {
                call.resolve(["value": ""])
            }
        }
        host.onFinish = {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                host.eval(script) { value in finish(value) }
            }
        }
        host.create(src: url)
        host.prepareHiddenForEval()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeout)) {
            finish("")
        }
    }

    @objc func createSniffer(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let url = call.getString("url") else {
            call.reject("缺少参数")
            return
        }
        DispatchQueue.main.async {
            self.sniffers.removeValue(forKey: id)?.destroy()
            self.snifferSeen[id] = Set<String>()
            let host = WebviewHost(plugin: self, id: id, sniffMode: true)
            self.sniffers[id] = host
            host.create(src: url)
            call.resolve()
        }
    }

    @objc func snifferState(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.resolve(["title": ""])
            return
        }
        call.resolve(["title": sniffers[id]?.currentTitleValue() ?? ""])
    }

    @objc func destroySniffer(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        sniffers.removeValue(forKey: id)?.destroy()
        snifferSeen.removeValue(forKey: id)
        call.resolve()
    }

    @objc func publishDownload(_ call: CAPPluginCall) {
        guard let raw = call.getString("path"), let source = URL(string: raw) else {
            call.reject("缺少 path")
            return
        }
        let name = sanitize(call.getString("name") ?? "视频.ts")
        do {
            let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let dir = documents.appendingPathComponent("长视频解析", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
            var target = dir.appendingPathComponent(name)
            var index = 1
            while FileManager.default.fileExists(atPath: target.path) {
                let base = (name as NSString).deletingPathExtension
                let ext = (name as NSString).pathExtension
                target = dir.appendingPathComponent("\(base) (\(index))\(ext.isEmpty ? "" : ".\(ext)")")
                index += 1
            }
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.copyItem(at: source, to: target)
            call.resolve([
                "ok": true,
                "uri": target.absoluteString,
                "displayPath": "「文件」App → 我的 iPhone → 长视频解析/\(target.lastPathComponent)"
            ])
        } catch {
            call.reject("保存文件失败：\(error.localizedDescription)")
        }
    }

    @objc func openDownload(_ call: CAPPluginCall) {
        guard let raw = call.getString("uri"), let url = URL(string: raw) else {
            call.reject("缺少 uri")
            return
        }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else {
                call.reject("无法打开文件")
                return
            }
            let doc = UIDocumentInteractionController(url: url)
            self.documentControllers.append(doc)
            doc.presentOptionsMenu(from: controller.view.bounds, in: controller.view, animated: true)
            call.resolve(["ok": true])
        }
    }

    @objc func shareDownload(_ call: CAPPluginCall) {
        guard let raw = call.getString("uri"), let url = URL(string: raw) else {
            call.reject("缺少 uri")
            return
        }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else {
                call.reject("无法分享")
                return
            }
            let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = controller.view
                popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
            }
            controller.present(activity, animated: true)
            call.resolve(["ok": true])
        }
    }

    @objc func openDownloadsFolder(_ call: CAPPluginCall) {
        call.reject("iOS 请在「文件」App 的「我的 iPhone → 长视频解析」里查看下载内容")
    }

    @objc func installApk(_ call: CAPPluginCall) {
        call.resolve(["ok": false, "error": "iOS 免签名 IPA 需要在电脑上用 Sideloadly / AltStore 重新签名安装"])
    }

    @objc func getInfo(_ call: CAPPluginCall) {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        call.resolve(["version": version, "build": build, "platform": "ios"])
    }

    func notifyWebview(_ data: [String: Any]) {
        DispatchQueue.main.async {
            self.notifyListeners("webviewEvent", data: data)
        }
    }

    func notifySniffer(id: String, url: String) {
        DispatchQueue.main.async {
            var seen = self.snifferSeen[id] ?? Set<String>()
            if seen.contains(url) { return }
            seen.insert(url)
            self.snifferSeen[id] = seen
            self.notifyListeners("snifferMedia", data: ["id": id, "url": url])
        }
    }

    private func sanitize(_ raw: String) -> String {
        let cleaned = raw
            .replacingOccurrences(of: "/", with: " ")
            .replacingOccurrences(of: "\\", with: " ")
            .replacingOccurrences(of: ":", with: " ")
            .replacingOccurrences(of: "*", with: " ")
            .replacingOccurrences(of: "?", with: " ")
            .replacingOccurrences(of: "\"", with: " ")
            .replacingOccurrences(of: "<", with: " ")
            .replacingOccurrences(of: ">", with: " ")
            .replacingOccurrences(of: "|", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "视频.ts" : cleaned
    }
}
