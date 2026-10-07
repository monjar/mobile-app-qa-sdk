/*
 * Snapshot-mode video capture (spec §5.2, Android): PixelCopy of the resumed
 * activity's window a few times a second, paced by the pure CaptureGovernor.
 *
 * Main thread, per capture: collect mask rectangles and issue
 * PixelCopy.request() into one of two pooled bitmaps sized so the long edge is
 * ≤ 960 px. Only that main-thread part is measured as the capture cost that the
 * governor budgets (3 % of main-thread time). At most one request is in
 * flight; a capture that comes due while one is pending counts as skipped.
 *
 * Capture thread (PixelCopy's callback handler): paint masks, checksum,
 * JPEG 55, push to the ring — unless the checksum shows the screen didn't
 * change, in which case encoding is skipped.
 *
 * Windows with FLAG_SECURE are never captured. API 26+ only (PixelCopy). Known gaps: SurfaceView/TextureView-in-overlay
 * content can be black, and other windows (dialogs, popups) are not captured.
 */
package io.github.monjar.snitch.capture

import android.annotation.TargetApi
import android.app.Activity
import android.graphics.Bitmap
import android.os.Handler
import android.os.SystemClock
import android.view.PixelCopy
import io.github.monjar.snitch.SnitchState
import io.github.monjar.snitch.health.CaptureStats
import io.github.monjar.snitch.logic.CaptureGovernor
import io.github.monjar.snitch.logic.GovernorConfig
import io.github.monjar.snitch.logic.GovernorInput
import io.github.monjar.snitch.logic.ThermalState
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** What the capturer needs to know from the runtime; read on the main thread. */
internal interface CaptureHost {
    /** Video on, snapshot mode, foreground, not paused, Snitch UI hidden, SDK enabled. */
    val snapshotCaptureAllowed: Boolean
    val maskTextInputs: Boolean
    val lastTouchAt: Long?
    val lowPower: Boolean
    val thermal: ThermalState
    val governorConfig: GovernorConfig
}

@TargetApi(26)
internal class SnapshotCapturer(
    private val main: Handler,
    private val captureHandler: Handler,
    private val frames: FrameStore,
    private val stats: CaptureStats,
    private val host: CaptureHost,
) {
    private var activityRef: WeakReference<Activity>? = null
    private var scheduled = false
    private var nextAt = 0L
    private var avgCostMs: Double? = null
    private val inFlight = AtomicBoolean(false)
    private val pool = arrayOfNulls<Bitmap>(2)
    private var poolIndex = 0
    private val rects = MaskRects()
    private val codec = FrameCodec() // capture thread only
    private val tick = Runnable {
        scheduled = false
        captureNow()
    }

    /** Main thread. Starts (or moves) capture to [activity]'s window. */
    fun attach(activity: Activity) {
        if (activityRef?.get() !== activity) activityRef = WeakReference(activity)
        schedule()
    }

    fun detach(activity: Activity?) {
        if (activity == null || activityRef?.get() === activity) {
            activityRef = null
            cancel()
        }
    }

    /** Re-evaluate after a state change (pause, thermal, foreground…). */
    fun refresh() {
        if (activityRef?.get() != null) schedule() else cancel()
    }

    fun cancel() {
        main.removeCallbacks(tick)
        scheduled = false
    }

    /** A touch arrived: if the next capture is an idle interval away, bring it forward to the active rate. */
    fun onTouch(now: Long) {
        if (!scheduled) return
        val activeInterval = (1000.0 / host.governorConfig.activeFps).toLong()
        if (nextAt - now > activeInterval) schedule()
    }

    private fun schedule() {
        main.removeCallbacks(tick)
        scheduled = false
        val now = SystemClock.uptimeMillis()
        val input = GovernorInput(
            now = now,
            lastTouchAt = host.lastTouchAt,
            avgCostMs = avgCostMs ?: 0.0,
            lowPower = host.lowPower,
            thermal = host.thermal,
            paused = !host.snapshotCaptureAllowed || activityRef?.get() == null,
        )
        val delay = CaptureGovernor.nextCaptureDelayMs(host.governorConfig, input) ?: return
        nextAt = now + delay
        scheduled = main.postAtTime(tick, nextAt)
    }

    private fun captureNow() {
        val activity = activityRef?.get() ?: return
        if (!host.snapshotCaptureAllowed) return
        if (inFlight.get()) {
            stats.recordSkip()
            schedule()
            return
        }
        val window = activity.window
        val decor = window?.peekDecorView()
        if (window == null || decor == null || decor.width <= 0 || decor.height <= 0 || !decor.isAttachedToWindow || Masking.isSecure(window)) {
            schedule()
            return
        }
        val t0 = SystemClock.elapsedRealtimeNanos()
        val w = decor.width
        val h = decor.height
        val scale = min(1f, MAX_EDGE / max(w, h).toFloat())
        val bw = max(1, (w * scale).roundToInt())
        val bh = max(1, (h * scale).roundToInt())
        val bitmap = pooledBitmap(bw, bh)
        Masking.collect(decor, host.maskTextInputs, SnitchState.masks, rects)
        val maskPx = rects.scaled(bw / w.toFloat())
        val pxPerDp = activity.resources.displayMetrics.density * (bw / w.toFloat())
        val t = SystemClock.uptimeMillis()
        inFlight.set(true)
        try {
            PixelCopy.request(window, bitmap, { result -> onCopied(result, bitmap, maskPx, t, pxPerDp) }, captureHandler)
        } catch (e: IllegalArgumentException) {
            // No surface yet / not hardware accelerated.
            inFlight.set(false)
        }
        val cost = (SystemClock.elapsedRealtimeNanos() - t0) / 1_000_000.0
        avgCostMs = CaptureGovernor.updateAverageCost(avgCostMs, cost)
        stats.recordCost(cost)
        schedule()
    }

    /** Capture thread. */
    private fun onCopied(result: Int, bitmap: Bitmap, maskPx: FloatArray, t: Long, pxPerDp: Float) {
        // The other pooled bitmap is free; the main thread may start the next copy while we encode.
        inFlight.set(false)
        if (result != PixelCopy.SUCCESS) return
        try {
            Masking.paint(bitmap, maskPx)
            val checksum = codec.checksum(bitmap)
            if (checksum == frames.newestChecksum()) {
                stats.recordFrame(t)
                return
            }
            val jpeg = codec.jpeg(bitmap, FrameCodec.VIDEO_QUALITY)
            frames.push(Frame(t, jpeg, bitmap.width, bitmap.height, checksum, pxPerDp))
            stats.recordFrame(t)
        } catch (e: Throwable) {
            // Out of memory or a recycled bitmap: drop this frame, keep the app alive.
        }
    }

    private fun pooledBitmap(w: Int, h: Int): Bitmap {
        val i = poolIndex
        poolIndex = (poolIndex + 1) % pool.size
        val existing = pool[i]
        if (existing != null && existing.width == w && existing.height == h) return existing
        // Old bitmaps may still be encoding on the capture thread; let the GC reclaim them.
        return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { pool[i] = it }
    }

    companion object {
        const val MAX_EDGE = 960f
    }
}
