package com.example.chorddetector

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * Web版(chord-detector)をそのままWebViewで動かすラッパー。
 * 解析ロジック(クロマ抽出・コード判定・キー推定・チューニング補正等)は
 * 全てassets/web/以下のJSにあり、実曲で検証済みのものをそのまま流用する。
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var server: LocalWebServer

    // WebViewからのマイク権限リクエストは、OS側のランタイム権限が無い場合
    // ここで許可ダイアログを出してから改めてWebView側へ許可を返す。
    private var pendingPermissionRequest: PermissionRequest? = null

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) return@registerForActivityResult
        if (granted) {
            request.grant(request.resources)
        } else {
            request.deny()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        server = LocalWebServer(applicationContext)
        server.start()

        webView = WebView(this)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsAudio = request.resources.any {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }
                if (!wantsAudio) {
                    // マイク以外(カメラ等)は要求しても許可しない
                    request.deny()
                    return
                }
                if (ContextCompat.checkSelfPermission(
                        this@MainActivity, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingPermissionRequest = request
                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
        }

        webView.loadUrl(server.baseUrl)
    }

    override fun onDestroy() {
        server.stop()
        super.onDestroy()
    }
}
