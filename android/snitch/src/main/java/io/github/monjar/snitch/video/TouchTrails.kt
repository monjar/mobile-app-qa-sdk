/*
 * Touch trails drawn into the composed clip (spec §5.7): for an output frame
 * at time t, every touch sample in (t − 200 ms, t] is a filled circle — radius
 * 14 dp in frame pixels, white at alpha 0.55 scaled by recency, 1.5 dp dark
 * outline — and the newest sample of each pointer still down is drawn unfaded.
 *
 * Samples are in dp, window coordinates; a frame maps them to its pixels with
 * its own pxPerDp and window origin (system-capture frames show the whole
 * display, so the window is offset inside them).
 */
package io.github.monjar.snitch.video

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import io.github.monjar.snitch.capture.Frame
import io.github.monjar.snitch.capture.TouchSample

internal class TouchTrails(private val samples: List<TouchSample>) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private var first = 0
    private val newest = HashMap<Int, TouchSample>()

    /**
     * Draws the trails for output time [t] onto [canvas]; the source [frame] was drawn
     * scaled by [fit] and translated by ([dx], [dy]). Calls must come in ascending [t].
     */
    fun draw(canvas: Canvas, t: Long, frame: Frame, fit: Float, dx: Float, dy: Float) {
        if (samples.isEmpty()) return
        while (first < samples.size && samples[first].t <= t - WINDOW_MS) first++
        newest.clear()
        var i = first
        while (i < samples.size && samples[i].t <= t) {
            newest[samples[i].id] = samples[i]
            i++
        }
        if (newest.isEmpty()) return
        val pxPerDp = frame.pxPerDp * fit
        val radius = RADIUS_DP * pxPerDp
        stroke.strokeWidth = OUTLINE_DP * pxPerDp
        i = first
        while (i < samples.size && samples[i].t <= t) {
            val s = samples[i]
            val isNewest = newest[s.id] === s && s.phase != TouchSample.Phase.UP
            val recency = if (isNewest) 1f else 1f - (t - s.t).toFloat() / WINDOW_MS
            if (recency > 0f) {
                val cx = (frame.originX + s.x * frame.pxPerDp) * fit + dx
                val cy = (frame.originY + s.y * frame.pxPerDp) * fit + dy
                fill.color = Color.argb((255 * FILL_ALPHA * recency).toInt(), 255, 255, 255)
                stroke.color = Color.argb((255 * OUTLINE_ALPHA * recency).toInt(), 0, 0, 0)
                canvas.drawCircle(cx, cy, radius, fill)
                canvas.drawCircle(cx, cy, radius, stroke)
            }
            i++
        }
    }

    companion object {
        private const val WINDOW_MS = 200L
        private const val RADIUS_DP = 14f
        private const val OUTLINE_DP = 1.5f
        private const val FILL_ALPHA = 0.55f
        private const val OUTLINE_ALPHA = 0.6f
    }
}
