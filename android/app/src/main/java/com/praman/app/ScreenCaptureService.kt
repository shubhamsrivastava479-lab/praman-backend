package com.praman.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Captures the phone screen (after the customer allowed it in Android's own dialog) and hands
 * small JPEG pictures (about 4 per second) to the page, which turns them into a video track.
 * Runs as a foreground service with a visible notification, as Android requires.
 */
class ScreenCaptureService : Service() {

    companion object {
        @Volatile var onFrame: ((String) -> Unit)? = null
        @Volatile var onStopped: (() -> Unit)? = null
        @Volatile var running = false
        const val ACTION_STOP = "com.praman.app.STOP"
        private const val CHANNEL = "praman_screen"
        private const val NOTIF_ID = 41
        private const val WIDTH = 720
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var lastJpeg: String? = null
    private var lastSent = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything(true)
            return START_NOT_STICKY
        }
        startForegroundNow()
        val code = intent?.getIntExtra("code", 0) ?: 0
        val data = intent?.getParcelableExtra<Intent>("data")
        if (data == null) {
            stopEverything(false)
            onStopped?.invoke()
            return START_NOT_STICKY
        }
        try {
            begin(code, data)
        } catch (e: Exception) {
            stopEverything(false)
            onStopped?.invoke()
        }
        return START_NOT_STICKY
    }

    private fun startForegroundNow() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
        }
        val stop = android.app.PendingIntent.getService(
            this, 0, Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val n = builder
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Praman Call")
            .setContentText("Your screen is being shared with the officer. Tap Stop to end.")
            .setOngoing(true)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun begin(code: Int, data: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = mpm.getMediaProjection(code, data)
        projection = mp
        thread = HandlerThread("praman-capture").also { it.start() }
        handler = Handler(thread!!.looper)
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { stopEverything(true) }
        }, handler)

        val dm = resources.displayMetrics
        val w = WIDTH
        val h = ((dm.heightPixels.toLong() * w) / dm.widthPixels).toInt().coerceAtLeast(200)
        val ir = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader = ir
        display = mp.createVirtualDisplay(
            "praman-screen", w, h, dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, ir.surface, null, handler
        )
        running = true
        handler!!.post(object : Runnable {
            override fun run() {
                if (!running) return
                grab(ir, w, h)
                handler?.postDelayed(this, 250)
            }
        })
    }

    private fun grab(ir: ImageReader, w: Int, h: Int) {
        val now = System.currentTimeMillis()
        var b64: String? = null
        val image = try { ir.acquireLatestImage() } catch (e: Exception) { null }
        if (image != null) {
            try {
                val plane = image.planes[0]
                val rowPadding = plane.rowStride - plane.pixelStride * w
                val bmp = Bitmap.createBitmap(w + rowPadding / plane.pixelStride, h, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(bmp, 0, 0, w, h)
                val out = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 55, out)
                b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                lastJpeg = b64
                bmp.recycle()
                if (cropped !== bmp) cropped.recycle()
            } catch (e: Exception) {
                b64 = null
            } finally {
                image.close()
            }
        } else if (lastJpeg != null && now - lastSent > 1000) {
            b64 = lastJpeg   // screen did not change: repeat the last picture so the video does not freeze
        }
        if (b64 != null) {
            lastSent = now
            onFrame?.invoke(b64)
        }
    }

    private fun stopEverything(tell: Boolean) {
        val wasRunning = running
        running = false
        try { display?.release() } catch (e: Exception) {}
        try { reader?.close() } catch (e: Exception) {}
        try { projection?.stop() } catch (e: Exception) {}
        display = null; reader = null; projection = null
        try { thread?.quitSafely() } catch (e: Exception) {}
        thread = null; handler = null; lastJpeg = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
        stopSelf()
        if (tell && wasRunning) onStopped?.invoke()
    }

    override fun onDestroy() {
        if (running) stopEverything(true)
        super.onDestroy()
    }
}
