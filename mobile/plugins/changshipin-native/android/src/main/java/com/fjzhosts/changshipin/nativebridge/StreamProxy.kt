package com.fjzhosts.changshipin.nativebridge

import android.util.Base64
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray

/**
 * 手机端本地取流代理。
 *
 * 和桌面端 proxy.js 做同一件事：给第三方解析接口返回的 m3u8 / mp4 补上
 * Referer / UA / Cookie，并把 HLS 播放列表里的分片、密钥、子列表改写成代理地址。
 * 这里用一个很小的手写 HTTP/1.1 服务，只监听 127.0.0.1，不引第三方依赖。
 */
class StreamProxy {
    private val random = SecureRandom()
    val token: String = ByteArray(9).also { random.nextBytes(it) }
        .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "csp-proxy").also { it.isDaemon = true }
    }
    private val running = AtomicBoolean(false)
    @Volatile
    var port: Int = 0
        private set

    private val ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
    private val maxPlaylistBytes = 8 * 1024 * 1024

    fun start() {
        if (running.get()) return
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        server = socket
        port = socket.localPort
        running.set(true)
        pool.execute {
            while (running.get()) {
                try {
                    val client = socket.accept()
                    pool.execute { handleClient(client) }
                } catch (_: IOException) {
                    if (running.get()) continue else break
                } catch (_: Exception) {
                    if (!running.get()) break
                }
            }
        }
    }

    fun stop() {
        running.set(false)
        try {
            server?.close()
        } catch (_: Exception) {
        }
        server = null
    }

    private fun handleClient(client: Socket) {
        try {
            client.soTimeout = 45000
            val input = BufferedInputStream(client.getInputStream())
            val output = client.getOutputStream()
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase(Locale.US)
            val rawPath = parts[1]
            if (rawPath.length > 8192) return
            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val index = line.indexOf(':')
                if (index <= 0) continue
                headers[line.substring(0, index).trim().lowercase(Locale.US)] = line.substring(index + 1).trim()
            }
            var body = ByteArray(0)
            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            if (contentLength in 1..(1024 * 1024) && (method == "POST" || method == "PUT")) {
                body = readBytes(input, contentLength)
            }
            val uri = runCatching { java.net.URI("http://127.0.0.1$rawPath") }.getOrNull()
            if (uri == null) {
                writeSimple(output, 400, "text/plain; charset=utf-8", "bad request".toByteArray())
                return
            }
            val query = parseQuery(uri.rawQuery)
            if (uri.path == "/health") {
                writeSimple(output, 200, "text/plain; charset=utf-8", "ok".toByteArray())
                return
            }
            if (query["t"] != token) {
                writeSimple(output, 403, "text/plain; charset=utf-8", "forbidden".toByteArray())
                return
            }
            if (method == "OPTIONS") {
                writeSimple(output, 204, "text/plain; charset=utf-8", ByteArray(0))
                return
            }
            when (uri.path) {
                "/stream" -> handleStream(output, query, headers, method)
                "/fetch" -> handleFetch(output, query, headers, method, body)
                else -> writeSimple(output, 404, "text/plain; charset=utf-8", "not found".toByteArray())
            }
        } catch (error: Exception) {
            try {
                client.getOutputStream().write(
                    "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n"
                        .toByteArray(Charsets.UTF_8)
                )
            } catch (_: Exception) {
            }
        } finally {
            try {
                client.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun handleStream(output: OutputStream, query: Map<String, String>, requestHeaders: Map<String, String>, method: String) {
        val target = decode(query["u"])
        if (!target.startsWith("http://") && !target.startsWith("https://")) {
            writeSimple(output, 400, "text/plain; charset=utf-8", "bad target".toByteArray())
            return
        }
        val referer = decode(query["r"])
        val cookie = decode(query["c"])
        val conn = open(target, "GET", referer, cookie, requestHeaders)
        try {
            val status = conn.responseCode
            val contentType = conn.contentType ?: ""
            val isPlaylist = contentType.contains("mpegurl", true) ||
                target.contains(".m3u8", true) ||
                target.contains("/m3u8/", true)
            val input = if (status >= 400) conn.errorStream else conn.inputStream
            if (isPlaylist && input != null) {
                val bytes = readAll(input, maxPlaylistBytes)
                val text = String(bytes, Charsets.UTF_8)
                val rewritten = if (text.trimStart().startsWith("#EXTM3U")) {
                    rewritePlaylist(text, target, referer, cookie)
                } else {
                    text
                }
                val body = rewritten.toByteArray(Charsets.UTF_8)
                val headers = LinkedHashMap<String, String>()
                headers["Content-Type"] = if (contentType.isNotEmpty()) contentType else "application/vnd.apple.mpegurl"
                headers["Content-Length"] = body.size.toString()
                writeResponse(output, status, headers, body, method == "HEAD")
                return
            }
            val headers = LinkedHashMap<String, String>()
            putIf(headers, "Content-Type", contentType)
            putIf(headers, "Content-Range", conn.getHeaderField("Content-Range"))
            putIf(headers, "Accept-Ranges", conn.getHeaderField("Accept-Ranges"))
            putIf(headers, "ETag", conn.getHeaderField("ETag"))
            putIf(headers, "Last-Modified", conn.getHeaderField("Last-Modified"))
            val length = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            if (length >= 0) headers["Content-Length"] = length.toString()
            writeHead(output, status, headers)
            if (method == "HEAD" || input == null) return
            input.use { copy(it, output) }
        } finally {
            try {
                conn.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun handleFetch(
        output: OutputStream,
        query: Map<String, String>,
        requestHeaders: Map<String, String>,
        method: String,
        body: ByteArray
    ) {
        val target = decode(query["u"])
        if (!target.startsWith("http://") && !target.startsWith("https://")) {
            writeSimple(output, 400, "text/plain; charset=utf-8", "bad target".toByteArray())
            return
        }
        val referer = decode(query["r"])
        val cookie = decode(query["c"])
        val upstreamMethod = (query["m"] ?: "GET").uppercase(Locale.US)
        val conn = open(target, upstreamMethod, referer, cookie, requestHeaders)
        try {
            if (body.isNotEmpty() && (upstreamMethod == "POST" || upstreamMethod == "PUT")) {
                conn.doOutput = true
                requestHeaders["content-type"]?.let { conn.setRequestProperty("Content-Type", it) }
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val contentType = conn.contentType ?: "text/plain; charset=utf-8"
            val input = if (status >= 400) conn.errorStream else conn.inputStream
            val bytes = if (input == null) ByteArray(0) else readAll(input, 32 * 1024 * 1024)
            val headers = LinkedHashMap<String, String>()
            headers["Content-Type"] = contentType
            headers["X-Proxy-Status"] = status.toString()
            val setCookies = conn.headerFields?.entries?.firstOrNull { it.key.equals("Set-Cookie", true) }?.value
            if (!setCookies.isNullOrEmpty()) {
                val array = JSONArray()
                for (item in setCookies) array.put(item)
                headers["X-Proxy-Set-Cookie"] = Base64.encodeToString(
                    array.toString().toByteArray(Charsets.UTF_8),
                    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
                )
            }
            headers["Content-Length"] = bytes.size.toString()
            writeResponse(output, 200, headers, bytes, upstreamMethod == "HEAD")
        } finally {
            try {
                conn.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun open(
        target: String,
        method: String,
        referer: String,
        cookie: String,
        requestHeaders: Map<String, String>
    ): HttpURLConnection {
        val conn = URL(target).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = true
        conn.connectTimeout = 30000
        conn.readTimeout = 30000
        conn.requestMethod = method
        conn.setRequestProperty("User-Agent", ua)
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6")
        conn.setRequestProperty("Accept-Encoding", "identity")
        if (referer.isNotEmpty()) conn.setRequestProperty("Referer", referer)
        if (cookie.isNotEmpty()) conn.setRequestProperty("Cookie", cookie)
        requestHeaders["accept"]?.let { conn.setRequestProperty("Accept", it) }
        requestHeaders["range"]?.let { conn.setRequestProperty("Range", it) }
        requestHeaders["content-type"]?.let { conn.setRequestProperty("Content-Type", it) }
        requestHeaders["origin"]?.let { conn.setRequestProperty("Origin", it) }
        return conn
    }

    private fun rewritePlaylist(text: String, baseUrl: String, referer: String, cookie: String): String {
        val base = referer.ifEmpty { baseUrl }
        fun rewrite(relative: String): String {
            return try {
                val absolute = URL(URL(baseUrl), relative).toString()
                resourceUrl(absolute, base, cookie)
            } catch (_: Exception) {
                relative
            }
        }
        return text.split(Regex("\\r?\\n")).joinToString("\n") { line ->
            val trimmed = line.trim()
            when {
                trimmed.isEmpty() -> line
                trimmed.startsWith("#") -> trimmed.replace(Regex("URI=\"([^\"]+)\"")) { match ->
                    "URI=\"${rewrite(match.groupValues[1])}\""
                }
                else -> rewrite(trimmed)
            }
        }
    }

    private fun resourceUrl(target: String, referer: String, cookie: String): String {
        val sb = StringBuilder("http://127.0.0.1:$port/stream?t=$token&u=")
        sb.append(encode(target))
        if (referer.isNotEmpty()) sb.append("&r=").append(encode(referer))
        if (cookie.isNotEmpty()) sb.append("&c=").append(encode(cookie))
        return sb.toString()
    }

    private fun encode(value: String): String =
        Base64.encodeToString(value.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun decode(value: String?): String {
        if (value.isNullOrEmpty()) return ""
        return try {
            String(Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), Charsets.UTF_8)
        } catch (_: Exception) {
            ""
        }
    }

    private fun parseQuery(raw: String?): Map<String, String> {
        if (raw.isNullOrEmpty()) return emptyMap()
        val out = HashMap<String, String>()
        for (pair in raw.split("&")) {
            if (pair.isEmpty()) continue
            val index = pair.indexOf('=')
            val key = if (index >= 0) pair.substring(0, index) else pair
            val value = if (index >= 0) pair.substring(index + 1) else ""
            out[URLDecoder.decode(key, "UTF-8")] = URLDecoder.decode(value, "UTF-8")
        }
        return out
    }

    private fun readLine(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        var previous = -1
        while (true) {
            val current = input.read()
            if (current < 0) return if (bytes.size() == 0) null else bytes.toString("UTF-8")
            if (current == '\n'.code) {
                val raw = bytes.toByteArray()
                val length = if (raw.isNotEmpty() && raw.last() == '\r'.code.toByte()) raw.size - 1 else raw.size
                return String(raw, 0, length, Charsets.UTF_8)
            }
            if (bytes.size() > 8192) return null
            bytes.write(current)
            previous = current
        }
    }

    private fun readBytes(input: InputStream, length: Int): ByteArray {
        val out = ByteArrayOutputStream(length)
        val buffer = ByteArray(8192)
        var remaining = length
        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(buffer.size, remaining))
            if (read < 0) break
            out.write(buffer, 0, read)
            remaining -= read
        }
        return out.toByteArray()
    }

    private fun readAll(input: InputStream, max: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16384)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > max) throw IOException("response too large")
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    private fun copy(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(16384)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
        }
        output.flush()
    }

    private fun writeSimple(output: OutputStream, status: Int, contentType: String, body: ByteArray) {
        val headers = LinkedHashMap<String, String>()
        headers["Content-Type"] = contentType
        headers["Content-Length"] = body.size.toString()
        writeResponse(output, status, headers, body, false)
    }

    private fun writeHead(output: OutputStream, status: Int, headers: Map<String, String>) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Headers: *\r\n")
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, X-Proxy-Status, X-Proxy-Set-Cookie\r\n")
        sb.append("Connection: close\r\n")
        for ((key, value) in headers) sb.append(key).append(": ").append(value).append("\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray(Charsets.UTF_8))
        output.flush()
    }

    private fun writeResponse(
        output: OutputStream,
        status: Int,
        headers: Map<String, String>,
        body: ByteArray,
        headOnly: Boolean
    ) {
        writeHead(output, status, headers)
        if (!headOnly) {
            output.write(body)
            output.flush()
        }
    }

    private fun putIf(map: MutableMap<String, String>, key: String, value: String?) {
        if (!value.isNullOrEmpty()) map[key] = value
    }

    private fun statusText(status: Int): String = when (status) {
        200 -> "OK"
        204 -> "No Content"
        206 -> "Partial Content"
        301 -> "Moved Permanently"
        302 -> "Found"
        304 -> "Not Modified"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        else -> "OK"
    }
}
