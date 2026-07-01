package com.example.chorddetector

import android.content.Context
import java.io.FileNotFoundException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * assets/web/ 以下の静的ファイルを 127.0.0.1 だけに配信する最小限のHTTPサーバー。
 *
 * WebViewでnavigator.mediaDevices.getUserMedia()を使うには「安全なコンテキスト」
 * として扱われる必要がある。file://はWebView/Android のバージョンによって扱いが
 * 安定しないため、localhost経由(http://127.0.0.1:PORT/)で読み込ませることで
 * 仕様上確実に安全なコンテキストとして扱われるようにしている。
 * (Node製の開発用サーバー _server.mjs と同じ役割をKotlinで持たせたもの)
 */
class LocalWebServer(private val context: Context, private val port: Int = 8123) {
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var running = false
    private var acceptThread: Thread? = null

    val baseUrl: String get() = "http://127.0.0.1:$port/"

    fun start() {
        if (running) return
        running = true
        serverSocket = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
        acceptThread = Thread {
            while (running) {
                val socket = try {
                    serverSocket?.accept()
                } catch (e: Exception) {
                    null // stop()によるclose、または一時的なエラー
                }
                if (socket == null) {
                    if (!running) break
                    continue
                }
                // 1リクエスト1スレッドで処理(ローカルの少数ファイルなので十分)
                Thread { handleClient(socket) }.apply { isDaemon = true; start() }
            }
        }.apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            try {
                val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                val requestLine = input.readLine() ?: return
                // ヘッダーは空行まで読み飛ばす(GETのみ扱うのでボディは無い前提)
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                }

                val path = requestLine.split(" ").getOrNull(1)?.substringBefore('?')
                if (path == null) {
                    writeResponse(s.getOutputStream(), 400, "text/plain", ByteArray(0))
                    return
                }
                val assetPath = "web" + (if (path == "/") "/index.html" else path)

                try {
                    val bytes = context.assets.open(assetPath).use { it.readBytes() }
                    writeResponse(s.getOutputStream(), 200, contentTypeFor(assetPath), bytes)
                } catch (e: FileNotFoundException) {
                    writeResponse(s.getOutputStream(), 404, "text/plain", "not found".toByteArray())
                }
            } catch (_: Exception) {
                // クライアントが途中で切断した等は無視してよい
            }
        }
    }

    private fun contentTypeFor(path: String): String = when {
        path.endsWith(".html") -> "text/html; charset=utf-8"
        path.endsWith(".css") -> "text/css; charset=utf-8"
        path.endsWith(".js") -> "text/javascript; charset=utf-8"
        else -> "application/octet-stream"
    }

    private fun writeResponse(out: OutputStream, status: Int, contentType: String, body: ByteArray) {
        val statusText = when (status) {
            200 -> "OK"
            404 -> "Not Found"
            else -> "Bad Request"
        }
        val header = "HTTP/1.1 $status $statusText\r\n" +
            "Content-Type: $contentType\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        out.write(header.toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }
}
