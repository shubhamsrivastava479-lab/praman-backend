package com.praman.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Praman Call: opens the same live-call page the customer would open in a browser, and adds what a
 * phone browser cannot do: sharing the screen. Only pages of the Praman site are ever loaded.
 */
class MainActivity : Activity() {

    companion object {
        const val BASE = "https://praman-backend-vtbz.onrender.com"
        private const val REQ_PERMS = 11
        private const val REQ_SCREEN = 12
    }

    private var web: WebView? = null
    private lateinit var root: LinearLayout

    private fun trusted(u: Uri?): Boolean {
        val base = Uri.parse(BASE)
        return u != null && u.scheme == "https" && u.host == base.host
    }

    /** Accepts a full call link or just the code; anything else is refused. */
    private fun toCallUrl(text: String): String? {
        val t = text.trim()
        if (t.isEmpty()) return null
        if (Regex("^[0-9a-fA-F]{32}$").matches(t)) return "$BASE/live-join.html?t=$t"
        val u = try { Uri.parse(t) } catch (e: Exception) { return null }
        if (!trusted(u) || u.path?.startsWith("/live-join.html") != true) return null
        return t
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        setContentView(root)
        askPermissions()
        val link = intent?.data?.toString()
        val url = if (link != null) toCallUrl(link) else null
        if (url != null) openCall(url) else showEntry(null)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        val url = intent?.data?.toString()?.let { toCallUrl(it) }
        if (url != null) openCall(url)
    }

    private fun askPermissions() {
        val need = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty() && Build.VERSION.SDK_INT >= 23) requestPermissions(missing.toTypedArray(), REQ_PERMS)
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    private fun showEntry(error: String?) {
        web?.destroy(); web = null
        root.removeAllViews()
        root.gravity = Gravity.CENTER
        root.setPadding(dp(24), dp(24), dp(24), dp(24))
        val title = TextView(this).apply { text = "Praman Call"; textSize = 24f; setTextColor(Color.parseColor("#10151f")) }
        val hint = TextView(this).apply {
            text = "Paste the video call link you received on WhatsApp.\nवीडियो कॉल का लिंक यहाँ डालें।"
            textSize = 14f; setPadding(0, dp(12), 0, dp(12))
        }
        val input = EditText(this).apply { this.hint = "https://…/live-join.html?t=…" ; setSingleLine(true) }
        val err = TextView(this).apply { text = error ?: ""; setTextColor(Color.parseColor("#b23a2c")); textSize = 13f }
        val go = Button(this).apply {
            text = "Join / जुड़ें"
            setOnClickListener {
                val u = toCallUrl(input.text.toString())
                if (u == null) err.text = "This is not a valid Praman call link. / यह सही लिंक नहीं है।" else openCall(u)
            }
        }
        root.addView(title); root.addView(hint); root.addView(input); root.addView(err); root.addView(go)
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun openCall(url: String) {
        root.removeAllViews()
        root.setPadding(0, 0, 0, 0)
        val w = WebView(this)
        web = w
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !trusted(request.url)    // never leave the Praman site inside this window
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (trusted(request.origin)) runOnUiThread { request.grant(request.resources) } else request.deny()
            }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, trusted(Uri.parse(origin)), false)
            }
        }
        w.addJavascriptInterface(Bridge(), "PramanAndroid")
        w.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(w)

        ScreenCaptureService.onFrame = { b64 ->
            w.post { w.evaluateJavascript("window.__pramanFrame&&window.__pramanFrame('$b64')", null) }
        }
        ScreenCaptureService.onStopped = {
            w.post { w.evaluateJavascript("window.__pramanScreenStopped&&window.__pramanScreenStopped()", null) }
        }
        w.loadUrl(url)
    }

    inner class Bridge {
        @JavascriptInterface
        fun startScreen() {
            runOnUiThread {
                // only our own page may start a screen share
                val here = web?.url?.let { Uri.parse(it) }
                if (!trusted(here)) return@runOnUiThread
                val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN)
            }
        }

        @JavascriptInterface
        fun stopScreen() {
            runOnUiThread {
                startService(Intent(this@MainActivity, ScreenCaptureService::class.java).setAction(ScreenCaptureService.ACTION_STOP))
            }
        }

        @JavascriptInterface
        fun version(): String = "1"
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_SCREEN) return
        if (resultCode == RESULT_OK && data != null) {
            val svc = Intent(this, ScreenCaptureService::class.java).putExtra("code", resultCode).putExtra("data", data)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc) else startService(svc)
        } else {
            web?.post { web?.evaluateJavascript("window.__pramanScreenStopped&&window.__pramanScreenStopped()", null) }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val w = web
        if (w != null) showEntry(null) else super.onBackPressed()
    }

    override fun onDestroy() {
        ScreenCaptureService.onFrame = null
        ScreenCaptureService.onStopped = null
        web?.destroy()
        super.onDestroy()
    }
}
