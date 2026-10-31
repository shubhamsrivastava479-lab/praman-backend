package com.praman.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.app.PictureInPictureParams
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import java.io.File

/**
 * Praman: the whole Praman website and dashboards inside an app.
 *  - Start page (/app.html): "Join my verification call" for customers (mobile number + WhatsApp code)
 *    or "Team login" for vendor, agent, insurer, viewer and admin. A logged-in user goes straight to the dashboard.
 *  - Call links from WhatsApp (live-join, ai-call, verify) open here directly.
 *  - Adds what a phone browser cannot do: screen sharing, saving reports / CSV files, picking files.
 * Only pages of the Praman site are opened inside the app; any other link opens in its own app (WhatsApp, maps, mail).
 */
class MainActivity : Activity() {

    companion object {
        const val BASE = "https://pramanservices.space"
        const val START = "$BASE/app.html"
        // Old address stays trusted so call links already sent to customers keep working.
        private const val OLD_HOST = "praman-backend-vtbz.onrender.com"
        private const val REQ_PERMS = 11
        private const val REQ_SCREEN = 12
        private const val REQ_FILE = 13
        private const val REQ_WEB_PERMS = 14
        private const val REQ_GEO = 15
        private const val NAVY = "#04345a"
    }

    private var web: WebView? = null
    private lateinit var bar: ProgressBar
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null
    private var lastUrl: String = START

    private fun trusted(u: Uri?): Boolean {
        val base = Uri.parse(BASE)
        return u != null && u.scheme == "https" && (u.host == base.host || u.host == OLD_HOST)
    }

    /** A link opened from WhatsApp / the browser: open it if it is one of our pages, else the start page. */
    private fun startUrlFrom(intent: Intent?): String {
        val u = intent?.data ?: return START
        return if (trusted(u)) u.toString() else START
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.parseColor(NAVY)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        val w = WebView(this)
        web = w
        root.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = View.GONE }
        root.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)))
        setContentView(root)
        setup(w)
        val url = startUrlFrom(intent)
        lastUrl = url
        w.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent?.data != null) web?.loadUrl(startUrlFrom(intent))
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    private fun openOutside(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No app found to open this link", Toast.LENGTH_SHORT).show()
        }
    }

    private fun has(p: String) = Build.VERSION.SDK_INT < 23 || checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun setup(w: WebView) {
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)
            javaScriptCanOpenWindowsAutomatically = true   // window.open(...) opens in this same window
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = true                      // needed to upload files the user picks
            loadWithOverviewMode = true
            useWideViewPort = true
            userAgentString = "$userAgentString PramanApp/2"
        }
        CookieManager.getInstance().setAcceptCookie(true)

        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (trusted(u)) return false                  // our pages stay in the app
                if (u.scheme == "blob" || u.scheme == "data") return false
                openOutside(u)                                // WhatsApp, maps, mail, phone, other sites
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                if (url != null && trusted(Uri.parse(url))) {
                    lastUrl = url
                    view.evaluateJavascript(DOWNLOAD_HOOK, null)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val retry = lastUrl.replace("'", "%27")
                view.loadDataWithBaseURL(null, OFFLINE_PAGE.replace("{{URL}}", retry), "text/html", "utf-8", null)
            }
        }

        w.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                bar.progress = newProgress
                bar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            // Camera / microphone for the video call: ask Android first if needed, then give them to the page.
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!trusted(request.origin)) { request.deny(); return }
                val need = mutableListOf<String>()
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !has(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA)
                if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !has(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO)
                if (need.isEmpty()) { runOnUiThread { request.grant(request.resources) }; return }
                pendingWebPermission = request
                requestPermissions(need.toTypedArray(), REQ_WEB_PERMS)
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                val ok = trusted(Uri.parse(origin))
                if (!ok) { callback.invoke(origin, false, false); return }
                if (has(Manifest.permission.ACCESS_FINE_LOCATION)) { callback.invoke(origin, true, false); return }
                pendingGeo = Pair(origin, callback)
                requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_GEO)
            }

            // <input type="file">: Excel upload, call recordings, documents, photos.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    val pick = params.createIntent().apply {
                        if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    startActivityForResult(Intent.createChooser(pick, "Choose a file"), REQ_FILE)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        // Normal file links (http/https): let Android download them.
        w.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val u = Uri.parse(url)
            if (u.scheme == "blob" || u.scheme == "data") return@setDownloadListener   // handled by the page hook
            if (!trusted(u)) { openOutside(u); return@setDownloadListener }
            try {
                val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val req = DownloadManager.Request(u)
                    .setMimeType(mimeType)
                    .addRequestHeader("User-Agent", userAgent)
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                openOutside(u)
            }
        }

        w.addJavascriptInterface(Bridge(), "PramanAndroid")
        ScreenCaptureService.onFrame = { b64 ->
            w.post { w.evaluateJavascript("window.__pramanFrame&&window.__pramanFrame('$b64')", null) }
        }
        ScreenCaptureService.onStopped = {
            w.post { w.evaluateJavascript("window.__pramanScreenStopped&&window.__pramanScreenStopped()", null) }
        }
    }

    inner class Bridge {
        private fun pageTrusted(): Boolean {
            var ok = false
            val lock = Object()
            runOnUiThread { synchronized(lock) { ok = trusted(web?.url?.let { Uri.parse(it) }); lock.notifyAll() } }
            synchronized(lock) { try { lock.wait(500) } catch (e: InterruptedException) { } }
            return ok
        }

        @JavascriptInterface
        fun startScreen() {
            runOnUiThread {
                // only our own page may start a screen share
                if (!trusted(web?.url?.let { Uri.parse(it) })) return@runOnUiThread
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
        fun version(): String = "2"

        /** A file made inside the page (report PDF, CSV list): save it to Downloads and open it. */
        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String) {
            if (!pageTrusted()) return
            val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(80).ifBlank { "praman-file" }
            val type = mime.ifBlank { "application/octet-stream" }
            try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val uri: Uri? = if (Build.VERSION.SDK_INT >= 29) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safe)
                        put(MediaStore.Downloads.MIME_TYPE, type)
                    }
                    val u = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    if (u != null) contentResolver.openOutputStream(u)?.use { it.write(bytes) }
                    u
                } else {
                    val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
                    val f = File(dir, safe)
                    f.writeBytes(bytes)
                    null
                }
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Saved to Downloads: $safe", Toast.LENGTH_LONG).show()
                    if (uri != null) {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                        } catch (e: Exception) { /* no app to open this kind of file */ }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this@MainActivity, "Could not save the file", Toast.LENGTH_SHORT).show() }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_WEB_PERMS -> {
                val req = pendingWebPermission ?: return
                pendingWebPermission = null
                val granted = mutableListOf<String>()
                if (req.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && has(Manifest.permission.CAMERA)) granted.add(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                if (req.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && has(Manifest.permission.RECORD_AUDIO)) granted.add(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (granted.isEmpty()) req.deny() else req.grant(granted.toTypedArray())
            }
            REQ_GEO -> {
                val g = pendingGeo ?: return
                pendingGeo = null
                g.second.invoke(g.first, has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION), false)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_FILE -> {
                val cb = fileCallback ?: return
                fileCallback = null
                var result: Array<Uri>? = null
                if (resultCode == RESULT_OK && data != null) {
                    val clip = data.clipData
                    result = if (clip != null && clip.itemCount > 0) Array(clip.itemCount) { clip.getItemAt(it).uri }
                    else data.data?.let { arrayOf(it) }
                }
                cb.onReceiveValue(result)
            }
            REQ_SCREEN -> {
                if (resultCode == RESULT_OK && data != null) {
                    val svc = Intent(this, ScreenCaptureService::class.java).putExtra("code", resultCode).putExtra("data", data)
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc) else startService(svc)
                } else {
                    web?.post { web?.evaluateJavascript("window.__pramanScreenStopped&&window.__pramanScreenStopped()", null) }
                }
            }
        }
    }

    // While the screen is being shared and the customer goes to WhatsApp, keep the call page alive in a small
    // floating window. A page that is fully in the background stops drawing, and the officer would see a blank screen.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (ScreenCaptureService.running && web != null && Build.VERSION.SDK_INT >= 26) {
            try {
                enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16)).build())
            } catch (e: Exception) { /* not available on this phone */ }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        ScreenCaptureService.onFrame = null
        ScreenCaptureService.onStopped = null
        fileCallback?.onReceiveValue(null)
        web?.destroy()
        super.onDestroy()
    }
}

// Pages make reports and CSV lists as "blob:" links and click them; a WebView cannot download those by itself.
// This hands the file to the app (PramanAndroid.saveFile), which saves it to Downloads.
private const val DOWNLOAD_HOOK = """
(function(){
  if (window.__pramanDl || !window.PramanAndroid || !PramanAndroid.saveFile) return; window.__pramanDl = 1;
  function save(a){
    var h = a.href || '', n = a.getAttribute('download') || 'praman-file';
    fetch(h).then(function(r){ return r.blob(); }).then(function(b){
      var fr = new FileReader();
      fr.onload = function(){ PramanAndroid.saveFile(String(fr.result).split(',')[1] || '', n, b.type || 'application/octet-stream'); };
      fr.readAsDataURL(b);
    });
  }
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if (/^(blob:|data:)/.test(this.href || '') && this.hasAttribute('download')) { save(this); return; }
    return click.apply(this, arguments);
  };
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && /^(blob:|data:)/.test(a.href || '')) { e.preventDefault(); save(a); }
  }, true);
})();
"""

private const val OFFLINE_PAGE = """
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;text-align:center;padding:60px 24px;color:#1c2733">
<div style="font-size:42px">📶</div>
<h2 style="color:#04345a">No internet connection</h2>
<p>Please check your internet and try again.<br>कृपया इंटरनेट जांचें और फिर से कोशिश करें।</p>
<p style="color:#5b6773;font-size:14px">If you just opened the app, the server may take up to a minute to wake up.</p>
<a href='{{URL}}' style="display:inline-block;margin-top:14px;padding:13px 26px;background:#c8781f;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">Try again</a>
</body></html>
"""
