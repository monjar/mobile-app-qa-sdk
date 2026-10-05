/*
 * The report screenshot (spec §5.6): taken at trigger time, before any Snitch
 * UI appears, at full window size. PixelCopy on API 26+ (async; falls back to
 * View.draw if the window has no hardware surface), View.draw below 26.
 * Masked, then kept in memory as JPEG 80 plus a small thumbnail for the
 * sheet; nothing touches the disk until Send.
 */
package io.github.monjar.snitch.capture

import android.annotation.TargetApi
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.view.PixelCopy
import android.view.View
import io.github.monjar.snitch.SnitchLog
import io.github.monjar.snitch.SnitchState
import kotlin.math.max
import kotlin.math.roundToInt

internal class Screenshot(val jpeg: ByteArray, val width: Int, val height: Int, val thumbnail: Bitmap?)

internal class ScreenshotTaker(private val main: Handler, private val captureHandler: Handler) {
    private val codec = FrameCodec() // capture thread only

    /** Main thread. [done] is called on the main thread, with null on failure. */
    fun take(activity: Activity, maskTextInputs: Boolean, thumbHeightPx: Int, done: (Screenshot?) -> Unit) {
        val window = activity.window
        val decor = window?.peekDecorView()
        if (window == null || decor == null || decor.width <= 0 || decor.height <= 0 || Masking.isSecure(window)) {
            done(null)
            return
        }
        val rects = MaskRects()
        Masking.collect(decor, maskTextInputs, SnitchState.masks, rects)
        val maskPx = rects.scaled(1f)
        val bitmap = try {
            Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
            done(null)
            return
        }
        if (Build.VERSION.SDK_INT >= 26 && decor.isHardwareAccelerated) {
            pixelCopy(activity, decor, bitmap, maskPx, thumbHeightPx, done)
        } else {
            drawSoftware(decor, bitmap, maskPx, thumbHeightPx, done)
        }
    }

    @TargetApi(26)
    private fun pixelCopy(activity: Activity, decor: View, bitmap: Bitmap, maskPx: FloatArray, thumbHeightPx: Int, done: (Screenshot?) -> Unit) {
        try {
            PixelCopy.request(activity.window, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) {
                    encode(bitmap, maskPx, thumbHeightPx, done)
                } else {
                    main.post { drawSoftware(decor, bitmap, maskPx, thumbHeightPx, done) }
                }
            }, captureHandler)
        } catch (e: IllegalArgumentException) {
            drawSoftware(decor, bitmap, maskPx, thumbHeightPx, done)
        }
    }

    /** Main thread. */
    private fun drawSoftware(decor: View, bitmap: Bitmap, maskPx: FloatArray, thumbHeightPx: Int, done: (Screenshot?) -> Unit) {
        try {
            bitmap.eraseColor(0)
            decor.draw(Canvas(bitmap))
        } catch (e: Throwable) {
            // e.g. hardware bitmaps in the hierarchy can't be drawn in software.
            SnitchLog.warnOnce("screenshot-draw", "screenshot fallback failed", e)
            done(null)
            return
        }
        captureHandler.post { encode(bitmap, maskPx, thumbHeightPx, done) }
    }

    /** Capture thread. */
    private fun encode(bitmap: Bitmap, maskPx: FloatArray, thumbHeightPx: Int, done: (Screenshot?) -> Unit) {
        val shot = try {
            Masking.paint(bitmap, maskPx)
            val jpeg = codec.jpeg(bitmap, FrameCodec.SCREENSHOT_QUALITY)
            val th = max(1, thumbHeightPx)
            val tw = max(1, (bitmap.width * th / bitmap.height.toFloat()).roundToInt())
            // createScaledBitmap returns the source itself when no scaling is needed; it is recycled below.
            val thumb = Bitmap.createScaledBitmap(bitmap, tw, th, true).let { if (it === bitmap) bitmap.copy(Bitmap.Config.ARGB_8888, false) else it }
            Screenshot(jpeg, bitmap.width, bitmap.height, thumb)
        } catch (e: Throwable) {
            SnitchLog.warn("screenshot encoding failed", e)
            null
        } finally {
            bitmap.recycle()
        }
        main.post { done(shot) }
    }
}
