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

    // WebViewからのマイク権限リクエストが来た時点でOS権限がまだ無い場合の保留分。
    // (通常は起動時の先行リクエストで解決済みのはずだが、念のためのフォールバック)
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

    private fun hasMicPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // OS側のマイク権限を、WebView上で録音開始が押される前に先に確保しておく。
        // これをJS側のgetUserMedia呼び出し時(onPermissionRequest内)で初めて要求すると、
        // システム権限ダイアログの割り込みでWebViewのページが一瞬非表示状態になり、
        // Chromiumがそのタイミングでの取得を失敗として扱うことがある(そしてその失敗を
        // ページのセッション内で記憶してしまい、権限を後から許可しても直らない)。
        // 起動時点で解決しておけば、実際にgetUserMediaが呼ばれる瞬間には権限確定済みで
        // ダイアログの割り込みが起きず、onPermissionRequestは同期的に許可できる。
        if (!hasMicPermission()) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }

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
                if (hasMicPermission()) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    // 起動時の先行リクエストが拒否された等のフォールバック
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
