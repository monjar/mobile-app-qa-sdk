/*
 * Foreground service (type mediaProjection) that owns the MediaProjection for
 * system capture mode (spec §5.3): VirtualDisplay → ImageReader (RGBA_8888,
 * 2 buffers) at the downscaled size (long edge ≤ 960 px) → on each image, at
 * most systemFps per second, copy into a reused bitmap and hand it to the
 * core's FrameSink, which masks, checksums, JPEG-encodes and stores it.
 *
 * The projection stays alive while the app is in the background (Android 14+
 * would otherwise need a new consent each time), but frames are dropped then:
 * FrameSink.isAcceptingFrames is false whenever the app isn't in front, so
 * other apps' screens are never encoded. A low-importance notification
 * channel, "Snitch screen recording", carries the mandatory notification.
 * Known limit: the mirror is letterboxed after a rotation.
 */
package io.github.monjar.snitch.system

import android.annotation.TargetApi
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
import android.os.Process
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import java.nio.Buffer
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class SnitchProjectionService : Service() {
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var bitmap: Bitmap? = null
    private var scratch: ByteBuffer? = null
    private var width = 0
    private var height = 0
    private var scale = 1f
    private var lastFrameAt = 0L
    private var stopping = false

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "screen capture stopped by the system")
            release(notifySink = true)
            stopSelf()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (projection != null) return START_NOT_STICKY
        stopping = false
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data = intent?.let { resultData(it) }
        if (data == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            // Must be in the foreground with type mediaProjection before getMediaProjection (Android 14+).
            goForeground()
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val p = mpm.getMediaProjection(resultCode, data) ?: throw IllegalStateException("no projection")
            projection = p
            startCapture(p)
            SinkHolder.sink?.onSystemCaptureStarted()
        } catch (e: Exception) {
            Log.w(TAG, "screen capture failed to start", e)
            release(notifySink = true)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        release(notifySink = false)
        super.onDestroy()
    }

    private fun startCapture(p: MediaProjection) {
        val t = HandlerThread("snitch-projection", Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
        thread = t
        val h = Handler(t.looper)
        handler = h
        // Required before createVirtualDisplay on Android 14+.
        p.registerCallback(projectionCallback, h)

        val metrics = realMetrics()
        scale = min(1f, MAX_EDGE / max(metrics.widthPixels, metrics.heightPixels).toFloat())
        width = max(2, (metrics.widthPixels * scale).roundToInt())
        height = max(2, (metrics.heightPixels * scale).roundToInt())
        val dpi = max(1, (metrics.densityDpi * scale).roundToInt())

        val r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        reader = r
        r.setOnImageAvailableListener({ onImage(it) }, h)
        display = p.createVirtualDisplay(
            "snitch-capture",
            width,
            height,
            dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            r.surface,
            null,
            h,
        )
    }

    /** Projection thread. */
    private fun onImage(r: ImageReader) {
        val image = try {
            r.acquireLatestImage()
        } catch (e: Exception) {
            null
        } ?: return
        try {
            val sink = SinkHolder.sink ?: return
            val now = SystemClock.uptimeMillis()
            val minInterval = (1000.0 / sink.systemFps.coerceIn(1.0, 15.0)).toLong()
            if (!sink.isAcceptingFrames || now - lastFrameAt < minInterval) return
            lastFrameAt = now
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val paddedWidth = rowStride / pixelStride
            val needed = rowStride * height
            val src = plane.buffer
            val input = if (src.remaining() >= needed) {
                src
            } else {
                // The last row is often not padded: copy into a full-size buffer.
                val s = scratch?.takeIf { it.capacity() >= needed } ?: ByteBuffer.allocateDirect(needed).also { scratch = it }
                s.clearCompat()
                s.put(src)
                s.rewindCompat()
                s
            }
            val bmp = bitmap?.takeIf { it.width == paddedWidth && it.height == height }
                ?: Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888).also { bitmap = it }
            bmp.copyPixelsFromBuffer(input)
            val frame = if (paddedWidth == width) bmp else Bitmap.createBitmap(bmp, 0, 0, width, height)
            sink.submitDisplayFrame(frame, scale, now)
            if (frame !== bmp) frame.recycle()
        } catch (e: Exception) {
            Log.w(TAG, "dropping a screen frame", e)
        } finally {
            image.close()
        }
    }

    /** Full display size, system bars included. DisplayManager works from a Service context (WindowManager wouldn't on 30+). */
    @Suppress("DEPRECATION")
    private fun realMetrics(): DisplayMetrics {
        val out = DisplayMetrics()
        out.setTo(resources.displayMetrics)
        val dm = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        dm?.getDisplay(Display.DEFAULT_DISPLAY)?.getRealMetrics(out)
        return out
    }

    private fun goForeground() {
        val builder = if (Build.VERSION.SDK_INT >= 26) channelBuilder26() else legacyBuilder()
        val notification = builder
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle(CHANNEL_NAME)
            .setContentText("Recent screen activity stays on this device unless you send a report.")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground29(notification) else startForeground(NOTIFICATION_ID, notification)
    }

    @TargetApi(26)
    private fun channelBuilder26(): Notification.Builder {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Snitch keeps the last seconds of screen activity for bug reports."
                setShowBadge(false)
            },
        )
        return Notification.Builder(this, CHANNEL_ID)
    }

    @Suppress("DEPRECATION")
    private fun legacyBuilder(): Notification.Builder = Notification.Builder(this)

    @TargetApi(29)
    private fun startForeground29(notification: Notification) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    }

    private fun release(notifySink: Boolean) {
        if (stopping) return
        stopping = true
        try {
            display?.release()
        } catch (_: Exception) {
        }
        display = null
        try {
            reader?.setOnImageAvailableListener(null, null)
            reader?.close()
        } catch (_: Exception) {
        }
        reader = null
        val p = projection
        projection = null
        try {
            p?.unregisterCallback(projectionCallback)
            p?.stop()
        } catch (_: Exception) {
        }
        thread?.quitSafely()
        thread = null
        handler = null
        bitmap = null
        if (notifySink) SinkHolder.sink?.onSystemCaptureStopped(declined = false)
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    @Suppress("DEPRECATION")
    private fun resultData(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java) else intent.getParcelableExtra(EXTRA_RESULT_DATA)

    companion object {
        internal const val EXTRA_RESULT_CODE = "io.github.monjar.snitch.system.RESULT_CODE"
        internal const val EXTRA_RESULT_DATA = "io.github.monjar.snitch.system.RESULT_DATA"
        private const val TAG = "Snitch"
        private const val CHANNEL_ID = "snitch_screen_recording"
        private const val CHANNEL_NAME = "Snitch screen recording"
        private const val NOTIFICATION_ID = 0x5317
        private const val MAX_EDGE = 960f
    }
}

/** Through java.nio.Buffer: ByteBuffer's covariant overrides are missing on older Android versions. */
private fun Buffer.clearCompat() {
    clear()
}

private fun Buffer.rewindCompat() {
    rewind()
}
