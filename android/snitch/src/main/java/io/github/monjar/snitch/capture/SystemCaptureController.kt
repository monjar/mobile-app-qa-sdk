/*
 * Core side of system capture mode (spec §5.3): finds the optional
 * snitch-system-capture module by name, starts it, and implements the
 * FrameSink it pushes MediaProjection frames into.
 *
 * Mask rectangles for display frames are computed on the main thread at ≤ 4 Hz
 * (display coordinates of the resumed activity's views) and cached; the
 * module's thread scales and paints them. If the module is missing, the user
 * declines consent or the projection stops, the runtime falls back to snapshot
 * mode for the rest of the session.
 */
package io.github.monjar.snitch.capture

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import io.github.monjar.snitch.SnitchLog
import io.github.monjar.snitch.SnitchState
import io.github.monjar.snitch.health.CaptureStats

internal interface SystemCaptureHost {
    val systemCaptureAccepting: Boolean
    val systemFps: Double
    val maskTextInputs: Boolean
    val resumedActivity: Activity?

    /** Main thread: capture stopped; [declined] when the user said no. */
    fun onSystemCaptureEnded(declined: Boolean)
}

internal class SystemCaptureController(
    private val main: Handler,
    private val frames: FrameStore,
    private val stats: CaptureStats,
    private val host: SystemCaptureHost,
) : FrameSink {
    enum class State { IDLE, REQUESTING, RUNNING, UNAVAILABLE }

    @Volatile
    var state: State = State.IDLE
        private set

    private val module: SystemCaptureModule? = load()
    private val codec = FrameCodec()
    private val rects = MaskRects()
    private val location = IntArray(2)

    /** Display-pixel mask rectangles and the window origin on the display, refreshed on the main thread. */
    @Volatile
    private var displayMasks = FloatArray(0)

    @Volatile
    private var windowOriginX = 0f

    @Volatile
    private var windowOriginY = 0f

    @Volatile
    private var density = 1f

    private val refreshMasks = object : Runnable {
        override fun run() {
            if (state != State.RUNNING) return
            updateMasks()
            main.postDelayed(this, MASK_REFRESH_MS)
        }
    }

    val isAvailable: Boolean get() = module != null

    /** Main thread. */
    fun start(activity: Activity) {
        val m = module
        if (m == null) {
            SnitchLog.warnOnce("system-missing", "captureMode is system but snitch-system-capture is not in the app; using snapshot capture")
            state = State.UNAVAILABLE
            return
        }
        if (state != State.IDLE) return
        state = State.REQUESTING
        try {
            m.start(activity, this)
        } catch (e: Throwable) {
            SnitchLog.warn("system capture failed to start; using snapshot mode", e)
            state = State.UNAVAILABLE
            host.onSystemCaptureEnded(declined = false)
        }
    }

    /** Main thread. */
    fun stop(context: Context) {
        main.removeCallbacks(refreshMasks)
        if (state == State.RUNNING || state == State.REQUESTING) {
            try {
                module?.stop(context)
            } catch (_: Throwable) {
            }
        }
        if (state != State.UNAVAILABLE) state = State.IDLE
    }

    override val isAcceptingFrames: Boolean get() = state == State.RUNNING && host.systemCaptureAccepting

    override val systemFps: Double get() = host.systemFps

    override fun submitDisplayFrame(bitmap: Bitmap, scale: Float, uptimeMs: Long) {
        if (!isAcceptingFrames) return
        synchronized(codec) {
            try {
                val masks = displayMasks
                if (masks.isNotEmpty()) {
                    val scaled = FloatArray(masks.size) { masks[it] * scale }
                    Masking.paint(bitmap, scaled)
                }
                val checksum = codec.checksum(bitmap)
                if (checksum == frames.newestChecksum()) {
                    stats.recordFrame(uptimeMs)
                    return
                }
                val jpeg = codec.jpeg(bitmap, FrameCodec.VIDEO_QUALITY)
                frames.push(
                    Frame(
                        t = uptimeMs,
                        jpeg = jpeg,
                        width = bitmap.width,
                        height = bitmap.height,
                        checksum = checksum,
                        pxPerDp = density * scale,
                        originX = windowOriginX * scale,
                        originY = windowOriginY * scale,
                    ),
                )
                stats.recordFrame(uptimeMs)
            } catch (e: Throwable) {
                // Drop the frame.
            }
        }
    }

    override fun onSystemCaptureStarted() {
        main.post {
            state = State.RUNNING
            main.removeCallbacks(refreshMasks)
            refreshMasks.run()
        }
    }

    override fun onSystemCaptureStopped(declined: Boolean) {
        main.post {
            main.removeCallbacks(refreshMasks)
            state = State.UNAVAILABLE
            host.onSystemCaptureEnded(declined)
        }
    }

    private fun updateMasks() {
        val activity = host.resumedActivity ?: return
        val decor = activity.window?.peekDecorView() ?: return
        if (!decor.isAttachedToWindow) return
        decor.getLocationOnScreen(location)
        val ox = location[0].toFloat()
        val oy = location[1].toFloat()
        Masking.collect(decor, host.maskTextInputs, SnitchState.masks, rects)
        displayMasks = rects.scaled(1f, ox, oy)
        windowOriginX = ox
        windowOriginY = oy
        density = activity.resources.displayMetrics.density
    }

    private fun load(): SystemCaptureModule? = try {
        Class.forName(SystemCaptureModule.CLASS_NAME).getDeclaredConstructor().newInstance() as SystemCaptureModule
    } catch (e: ClassNotFoundException) {
        null
    } catch (e: Throwable) {
        SnitchLog.warn("snitch-system-capture is present but could not be loaded", e)
        null
    }

    companion object {
        private const val MASK_REFRESH_MS = 250L
    }
}
