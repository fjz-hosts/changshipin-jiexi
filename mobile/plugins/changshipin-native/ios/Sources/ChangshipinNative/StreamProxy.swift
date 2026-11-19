import Foundation
import GCDWebServer

/// 手机端本地取流代理（iOS）：与 Android / 桌面端 proxy.js 同一套行为。
/// 用 GCDWebServer 只监听 127.0.0.1，带随机 token；HLS 播放列表的分片、密钥、子列表都改写成代理地址。
final class StreamProxy {
    static let ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"

    private let server = GCDWebServer()
    private let maxPlaylistBytes = 8 * 1024 * 1024
    private(set) var port: UInt = 0
    let token: String = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(18))
    private var started = false

    func start() throws {
        if started { return }
        addHandlers()
        let options: [String: Any] = [
            GCDWebServerOption_BindToLocalhost: true,
            GCDWebServerOption_Port: 0,
            GCDWebServerOption_AutomaticallySuspendInBackground: false
        ]
        try server.start(options: options)
        port = server.port
        started = true
    }

    func stop() {
        if started {
            server.stop()
            started = false
        }
    }

    private func addHandlers() {
        server.addHandler(forMethod: "GET", path: "/health", request: GCDWebServerRequest.self) { _ in
            self.textResponse("ok")
        }
        server.addHandler(forMethod: "GET", path: "/stream", request: GCDWebServerRequest.self) { request in
            self.handleStream(request)
        }
        server.addHandler(forMethod: "HEAD", path: "/stream", request: GCDWebServerRequest.self) { request in
            self.handleStream(request)
        }
        server.addHandler(forMethod: "GET", path: "/fetch", request: GCDWebServerRequest.self) { request in
            self.handleFetch(request, body: nil)
        }
        server.addHandler(forMethod: "POST", path: "/fetch", request: GCDWebServerDataRequest.self) { request in
            let dataRequest = request as? GCDWebServerDataRequest
            return self.handleFetch(request, body: dataRequest?.data)
        }
        server.addHandler(forMethod: "OPTIONS", path: "/", request: GCDWebServerRequest.self) { _ in
            self.optionsResponse()
        }
        server.addHandler(forMethod: "OPTIONS", path: "/stream", request: GCDWebServerRequest.self) { _ in
            self.optionsResponse()
        }
        server.addHandler(forMethod: "OPTIONS", path: "/fetch", request: GCDWebServerRequest.self) { _ in
            self.optionsResponse()
        }
    }

    private func handleStream(_ request: GCDWebServerRequest) -> GCDWebServerResponse {
        guard let query = request.query, query["t"] == token else {
            return textResponse("forbidden", status: 403)
        }
        guard let target = decode(query["u"]), isHttp(target) else {
            return textResponse("bad target", status: 400)
        }
        let referer = decode(query["r"])
        let cookie = decode(query["c"])
        guard let upstream = load(target, method: "GET", referer: referer, cookie: cookie, request: request) else {
            return textResponse("upstream failed", status: 502)
        }
        if let error = upstream.error {
            return textResponse("上游取流失败：\(error.localizedDescription)", status: 502)
        }
        let data = upstream.data ?? Data()
        let response = upstream.response
        let status = response?.statusCode ?? 200
        let contentType = response?.value(forHTTPHeaderField: "Content-Type") ?? ""
        let isPlaylist = contentType.lowercased().contains("mpegurl") ||
            target.lowercased().contains(".m3u8") ||
            target.lowercased().contains("/m3u8/")
        if isPlaylist, data.count <= maxPlaylistBytes, var text = String(data: data, encoding: .utf8) {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("#EXTM3U") {
                text = rewritePlaylist(text, baseUrl: target, referer: referer, cookie: cookie)
            }
            let body = Data(text.utf8)
            let result = GCDWebServerDataResponse(data: body, contentType: contentType.isEmpty ? "application/vnd.apple.mpegurl" : contentType)
            result.statusCode = status
            decorate(result, status: status)
            return result
        }
        let result = GCDWebServerDataResponse(data: data, contentType: contentType.isEmpty ? "application/octet-stream" : contentType)
        result.statusCode = status
        decorate(result, status: status)
        if let contentRange = response?.value(forHTTPHeaderField: "Content-Range") {
            result.setValue(contentRange, forAdditionalHeader: "Content-Range")
        }
        if let acceptRanges = response?.value(forHTTPHeaderField: "Accept-Ranges") {
            result.setValue(acceptRanges, forAdditionalHeader: "Accept-Ranges")
        }
        if let etag = response?.value(forHTTPHeaderField: "ETag") {
            result.setValue(etag, forAdditionalHeader: "ETag")
        }
        return result
    }

    private func handleFetch(_ request: GCDWebServerRequest, body: Data?) -> GCDWebServerResponse {
        guard let query = request.query, query["t"] == token else {
            return textResponse("forbidden", status: 403)
        }
        guard let target = decode(query["u"]), isHttp(target) else {
            return textResponse("bad target", status: 400)
        }
        let referer = decode(query["r"])
        let cookie = decode(query["c"])
        let method = (query["m"] ?? "GET").uppercased()
        guard let upstream = load(target, method: method, referer: referer, cookie: cookie, body: body, request: request) else {
            return textResponse("upstream failed", status: 502)
        }
        if let error = upstream.error {
            return textResponse("请求失败：\(error.localizedDescription)", status: 502)
        }
        let data = upstream.data ?? Data()
        let contentType = upstream.response?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        let result = GCDWebServerDataResponse(data: data, contentType: contentType)
        result.statusCode = 200
        decorate(result, status: 200)
        result.setValue(String(upstream.response?.statusCode ?? 0), forAdditionalHeader: "X-Proxy-Status")
        if let response = upstream.response {
            let headers = response.allHeaderFields.reduce(into: [String: String]()) { partial, item in
                if let key = item.key as? String, let value = item.value as? String {
                    partial[key] = value
                }
            }
            let cookies = URL(string: target).map { HTTPCookie.cookies(withResponseHeaderFields: headers, for: $0) } ?? []
            if !cookies.isEmpty {
                let list = cookies.map { "\($0.name)=\($0.value)" }
                if let encoded = try? JSONSerialization.data(withJSONObject: list, options: []) {
                    result.setValue(base64url(encoded), forAdditionalHeader: "X-Proxy-Set-Cookie")
                }
            }
        }
        return result
    }

    private struct Upstream {
        let data: Data?
        let response: HTTPURLResponse?
        let error: Error?
    }

    private func load(
        _ target: String,
        method: String,
        referer: String,
        cookie: String,
        body: Data? = nil,
        request: GCDWebServerRequest
    ) -> Upstream? {
        guard let url = URL(string: target) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.httpShouldHandleCookies = false
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        req.setValue("zh-CN,zh;q=0.9,en;q=0.6", forHTTPHeaderField: "Accept-Language")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if !referer.isEmpty { req.setValue(referer, forHTTPHeaderField: "Referer") }
        if !cookie.isEmpty { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let accept = request.headers["Accept"] { req.setValue(accept, forHTTPHeaderField: "Accept") }
        if let range = request.headers["Range"] { req.setValue(range, forHTTPHeaderField: "Range") }
        if let contentType = request.headers["Content-Type"] { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let origin = request.headers["Origin"] { req.setValue(origin, forHTTPHeaderField: "Origin") }
        if let body = body, method == "POST" || method == "PUT" {
            req.httpBody = body
        }
        let semaphore = DispatchSemaphore(value: 0)
        var resultData: Data?
        var resultResponse: HTTPURLResponse?
        var resultError: Error?
        let task = URLSession.shared.dataTask(with: req) { data, response, error in
            resultData = data
            resultResponse = response as? HTTPURLResponse
            resultError = error
            semaphore.signal()
        }
        task.resume()
        if semaphore.wait(timeout: .now() + 45) == .timedOut {
            task.cancel()
            return Upstream(data: nil, response: nil, error: NSError(domain: "csp", code: -1, userInfo: [NSLocalizedDescriptionKey: "上游取流超时"]))
        }
        if let error = resultError {
            return Upstream(data: resultData, response: resultResponse, error: error)
        }
        return Upstream(data: resultData, response: resultResponse, error: nil)
    }

    private func rewritePlaylist(_ text: String, baseUrl: String, referer: String, cookie: String) -> String {
        let base = referer.isEmpty ? baseUrl : referer
        func rewrite(_ relative: String) -> String {
            guard let absolute = URL(string: relative, relativeTo: URL(string: baseUrl))?.absoluteString else { return relative }
            return resourceUrl(absolute, referer: base, cookie: cookie)
        }
        return text.components(separatedBy: .newlines).map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return line }
            if trimmed.hasPrefix("#") {
                var output = ""
                var rest = Substring(trimmed)
                while let start = rest.range(of: "URI=\"") {
                    output += String(rest[..<start.upperBound])
                    let afterStart = rest[start.upperBound...]
                    guard let end = afterStart.firstIndex(of: "\"") else {
                        output += String(afterStart)
                        rest = ""
                        break
                    }
                    let uri = String(afterStart[..<end])
                    output += rewrite(uri)
                    rest = afterStart[end...]
                }
                output += String(rest)
                return output
            }
            return rewrite(trimmed)
        }.joined(separator: "\n")
    }

    private func resourceUrl(_ target: String, referer: String, cookie: String) -> String {
        var value = "http://127.0.0.1:\(port)/stream?t=\(token)&u=\(encode(target))"
        if !referer.isEmpty { value += "&r=\(encode(referer))" }
        if !cookie.isEmpty { value += "&c=\(encode(cookie))" }
        return value
    }

    private func decorate(_ response: GCDWebServerResponse, status: Int) {
        response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
        response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Headers")
        response.setValue("GET, POST, HEAD, OPTIONS", forAdditionalHeader: "Access-Control-Allow-Methods")
        response.setValue("Content-Length, Content-Range, Accept-Ranges, X-Proxy-Status", forAdditionalHeader: "Access-Control-Expose-Headers")
        response.setValue("close", forAdditionalHeader: "Connection")
    }

    private func textResponse(_ text: String, status: Int = 200) -> GCDWebServerDataResponse {
        let response = GCDWebServerDataResponse(data: Data(text.utf8), contentType: "text/plain; charset=utf-8")
        response.statusCode = status
        decorate(response, status: status)
        return response
    }

    private func optionsResponse() -> GCDWebServerResponse {
        let response = GCDWebServerResponse(statusCode: 204)
        decorate(response, status: 204)
        return response
    }

    private func isHttp(_ value: String) -> Bool {
        value.hasPrefix("http://") || value.hasPrefix("https://")
    }

    private func encode(_ value: String) -> String {
        base64url(Data(value.utf8))
    }

    private func decode(_ value: String?) -> String {
        guard let value = value, !value.isEmpty else { return "" }
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        guard let data = Data(base64Encoded: text) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
