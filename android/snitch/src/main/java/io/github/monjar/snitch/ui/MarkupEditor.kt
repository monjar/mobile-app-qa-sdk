/*
 * Screenshot markup (spec §11.7): tapping the sheet's thumbnail opens this
 * full-screen editor over the screenshot. Plain Views, no resources, like the
 * rest of the SDK's UI.
 *
 * Tools: Arrow, Box and Blur (pixelation in 16-pixel blocks of the image, see
 * logic/Pixelate), plus Undo, Clear, Cancel and Done. Strokes are red
 * (#FF3B30), 4 dp wide in image pixels (the screenshot is at window pixels, so
 * 4 dp = 4 × density). Marks are kept in image coordinates and applied in the
 * order they were made, the same way on screen (a downsampled preview) and in
 * the export, so what the tester sees is what is sent.
 *
 * Done renders the marks into the full-size image on a worker thread and hands
 * back a new JPEG (quality 80) with its thumbnail; the sheet then sends that
 * instead of the original. Blur rewrites the pixels themselves, so blurred
 * content can't be recovered from the file. Cancel (or back) keeps the original.
 */
package io.github.monjar.snitch.ui

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.TextView
import io.github.monjar.snitch.SnitchLog
import io.github.monjar.snitch.capture.FrameCodec
import io.github.monjar.snitch.capture.Screenshot
import io.github.monjar.snitch.logic.Pixelate
import java.io.ByteArrayOutputStream
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

internal class MarkupEditor private constructor(
    private val activity: Activity,
    private val source: Screenshot,
    /** The screenshot downsampled to about the screen size; owned (and recycled) by the editor. */
    private val preview: Bitmap,
    private val onDone: (Screenshot) -> Unit,
) : Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen) {
    enum class Tool { ARROW, BOX, BLUR }

    /** One mark, in image pixels. */
    class Mark(val tool: Tool, val x0: Float, val y0: Float, val x1: Float, val y1: Float)

    private val p = Palette(dark = true)
    private val marks = ArrayList<Mark>()
    private var tool = Tool.ARROW
    private var saving = false
    private var canvasView: MarkupView? = null
    private val toolButtons = ArrayList<Pair<Tool, TextView>>()
    private val actionButtons = ArrayList<TextView>()

    /** The stroke width in image pixels: the screenshot is at window pixels, so 4 dp × density. */
    private val strokePx = STROKE_DP * activity.resources.displayMetrics.density

    override fun onCreate(savedInstanceState: Bundle?) {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        super.onCreate(savedInstanceState)
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
        }
        root.addView(topBar(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val view = MarkupView(activity, preview, source.width, source.height, strokePx, { tool }) { mark ->
            marks.add(mark)
            refresh()
        }
        canvasView = view
        root.addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(bottomBar(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(root)
        val w = window
        if (w != null) {
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            w.setBackgroundDrawable(ColorDrawable(Color.BLACK))
            if (Build.VERSION.SDK_INT >= 30) applyInsets30(w, root) else root.fitsSystemWindows = true
        }
        setOnDismissListener { canvasView?.release() }
        refresh()
    }

    @TargetApi(30)
    @Suppress("DEPRECATION") // setDecorFitsSystemWindows: deprecated on 35 only because edge-to-edge is then forced.
    private fun applyInsets30(w: Window, root: View) {
        w.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
    }

    // ── Layout ──────────────────────────────────────────────────────────────

    private fun topBar(): View {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(activity.dp(8f), activity.dp(4f), activity.dp(8f), activity.dp(4f))
        }
        row.addView(button(Strings.MARKUP_CANCEL, Strings.MARKUP_CANCEL) { if (!saving) dismiss() })
        row.addView(View(activity), LinearLayout.LayoutParams(0, 1, 1f))
        row.addView(button(Strings.MARKUP_DONE, Strings.MARKUP_DONE, bold = true) { done() })
        return row
    }

    private fun bottomBar(): View {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(activity.dp(8f), activity.dp(6f), activity.dp(8f), activity.dp(6f))
        }
        for ((t, label, a11y) in listOf(
            Triple(Tool.ARROW, Strings.MARKUP_ARROW, Strings.MARKUP_ARROW_A11Y),
            Triple(Tool.BOX, Strings.MARKUP_BOX, Strings.MARKUP_BOX_A11Y),
            Triple(Tool.BLUR, Strings.MARKUP_BLUR, Strings.MARKUP_BLUR_A11Y),
        )) {
            val b = button(label, a11y) {
                tool = t
                refresh()
            }
            toolButtons.add(t to b)
            row.addView(b, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = activity.dp(4f) })
        }
        row.addView(View(activity), LinearLayout.LayoutParams(0, 1, 1f))
        val undo = button(Strings.MARKUP_UNDO, Strings.MARKUP_UNDO_A11Y) {
            if (marks.isNotEmpty()) marks.removeAt(marks.size - 1)
            refresh()
        }
        val clear = button(Strings.MARKUP_CLEAR, Strings.MARKUP_CLEAR_A11Y) {
            marks.clear()
            refresh()
        }
        actionButtons.add(undo)
        actionButtons.add(clear)
        row.addView(undo)
        row.addView(clear)
        return row
    }

    private fun button(label: String, a11y: String, bold: Boolean = false, onTap: () -> Unit): TextView =
        TextView(activity).apply {
            text = label
            textSp(16f)
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            minHeight = activity.dp(44f)
            minWidth = activity.dp(56f)
            setPadding(activity.dp(12f), activity.dp(8f), activity.dp(12f), activity.dp(8f))
            contentDescription = a11y
            isClickable = true
            isFocusable = true
            setOnClickListener { onTap() }
        }

    /** Re-renders the preview and updates the controls. */
    private fun refresh() {
        canvasView?.setMarks(marks)
        for ((t, b) in toolButtons) {
            val selected = t == tool
            b.isSelected = selected
            b.background = if (selected) roundedBackground(p.accent, activity.dpf(18f)) else null
        }
        for (b in actionButtons) {
            b.isEnabled = marks.isNotEmpty() && !saving
            b.alpha = if (b.isEnabled) 1f else 0.4f
        }
    }

    // ── Export ──────────────────────────────────────────────────────────────

    private fun done() {
        if (saving) return
        if (marks.isEmpty()) {
            dismiss()
            return
        }
        saving = true
        refresh()
        val snapshot = ArrayList(marks)
        val thumbHeight = activity.dp(THUMB_DP)
        Thread({
            val result = try {
                renderFull(snapshot, thumbHeight)
            } catch (e: Throwable) {
                SnitchLog.warn("markup: could not render the marks; keeping the original screenshot", e)
                null
            }
            activity.runOnUiThread {
                if (result != null) onDone(result)
                try {
                    if (isShowing) dismiss()
                } catch (_: Exception) {
                    // The activity window is already gone.
                }
            }
        }, "snitch-markup").start()
    }

    private fun renderFull(marks: List<Mark>, thumbHeight: Int): Screenshot? {
        val opts = BitmapFactory.Options().apply { inMutable = true }
        val bitmap = BitmapFactory.decodeByteArray(source.jpeg, 0, source.jpeg.size, opts) ?: return null
        try {
            render(bitmap, marks, 1f, strokePx)
            val out = ByteArrayOutputStream(source.jpeg.size)
            bitmap.compress(Bitmap.CompressFormat.JPEG, FrameCodec.SCREENSHOT_QUALITY, out)
            val th = max(1, thumbHeight)
            val tw = max(1, (bitmap.width * th / bitmap.height.toFloat()).roundToInt())
            val thumb = Bitmap.createScaledBitmap(bitmap, tw, th, true).let { if (it === bitmap) bitmap.copy(Bitmap.Config.ARGB_8888, false) else it }
            return Screenshot(out.toByteArray(), bitmap.width, bitmap.height, thumb)
        } finally {
            bitmap.recycle()
        }
    }

    companion object {
        /** Opens the editor over [activity]; false when the screenshot can't be decoded. Main thread. */
        fun open(activity: Activity, source: Screenshot, onDone: (Screenshot) -> Unit): Boolean {
            val metrics = activity.resources.displayMetrics
            val opts = BitmapFactory.Options().apply {
                inSampleSize = 1
                while (source.width / (inSampleSize * 2) >= metrics.widthPixels && source.height / (inSampleSize * 2) >= metrics.heightPixels / 2) inSampleSize *= 2
            }
            val preview = try {
                BitmapFactory.decodeByteArray(source.jpeg, 0, source.jpeg.size, opts)
            } catch (e: OutOfMemoryError) {
                null
            }
            if (preview == null) {
                SnitchLog.warn("markup: cannot decode the screenshot")
                return false
            }
            return try {
                MarkupEditor(activity, source, preview, onDone).show()
                true
            } catch (e: Exception) {
                SnitchLog.warn("markup: cannot open the editor", e)
                preview.recycle()
                false
            }
        }

        const val STROKE_DP = 4f
        const val COLOR = 0xFFFF3B30.toInt()
        private const val THUMB_DP = 88f
        private const val HEAD_ANGLE = 0.5
        private const val HEAD_STROKES = 4.5f

        /**
         * Applies [marks] (image pixels) to [target] in order; [scale] is target
         * pixels per image pixel, [strokePx] the stroke width in image pixels.
         */
        fun render(target: Bitmap, marks: List<Mark>, scale: Float, strokePx: Float) {
            val canvas = Canvas(target)
            val paint = strokePaint(strokePx * scale)
            for (m in marks) {
                when (m.tool) {
                    Tool.BLUR -> pixelate(target, m, scale)
                    Tool.BOX, Tool.ARROW -> drawStroke(canvas, m, scale, paint)
                }
            }
        }

        fun strokePaint(width: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = COLOR
            style = Paint.Style.STROKE
            strokeWidth = max(1f, width)
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }

        /** An arrow or a box, in [canvas] pixels ([scale] per image pixel). */
        fun drawStroke(canvas: Canvas, m: Mark, scale: Float, paint: Paint) {
            val x0 = m.x0 * scale
            val y0 = m.y0 * scale
            val x1 = m.x1 * scale
            val y1 = m.y1 * scale
            if (m.tool == Tool.BOX) {
                canvas.drawRect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), paint)
                return
            }
            canvas.drawLine(x0, y0, x1, y1, paint)
            val angle = atan2((y1 - y0).toDouble(), (x1 - x0).toDouble())
            val head = paint.strokeWidth * HEAD_STROKES
            val path = Path()
            path.moveTo(x1 + (head * cos(angle + Math.PI - HEAD_ANGLE)).toFloat(), y1 + (head * sin(angle + Math.PI - HEAD_ANGLE)).toFloat())
            path.lineTo(x1, y1)
            path.lineTo(x1 + (head * cos(angle + Math.PI + HEAD_ANGLE)).toFloat(), y1 + (head * sin(angle + Math.PI + HEAD_ANGLE)).toFloat())
            canvas.drawPath(path, paint)
        }

        /** Pixelates [m]'s rectangle of [target] in blocks of 16 image pixels. */
        private fun pixelate(target: Bitmap, m: Mark, scale: Float) {
            val l = floor(min(m.x0, m.x1) * scale).toInt().coerceIn(0, target.width)
            val t = floor(min(m.y0, m.y1) * scale).toInt().coerceIn(0, target.height)
            val r = ceil(max(m.x0, m.x1) * scale).toInt().coerceIn(0, target.width)
            val b = ceil(max(m.y0, m.y1) * scale).toInt().coerceIn(0, target.height)
            val w = r - l
            val h = b - t
            if (w <= 0 || h <= 0) return
            val pixels = IntArray(w * h)
            target.getPixels(pixels, 0, w, l, t, w, h)
            Pixelate.region(pixels, w, h, l, t, max(2, (Pixelate.BLOCK * scale).roundToInt()))
            target.setPixels(pixels, 0, w, l, t, w, h)
        }
    }

    /**
     * Shows the preview with the marks applied and turns drags into marks. The
     * preview bitmap is [base] (the screenshot downsampled); marks are converted
     * between view, preview and image pixels with one fit-centre matrix.
     */
    @SuppressLint("ViewConstructor")
    private class MarkupView(
        context: Context,
        private val base: Bitmap,
        private val imageWidth: Int,
        private val imageHeight: Int,
        private val strokePx: Float,
        private val currentTool: () -> Tool,
        private val onMark: (Mark) -> Unit,
    ) : View(context) {
        /** Preview pixels per image pixel. */
        private val scale = base.width / imageWidth.toFloat()

        /** [base] with the marks applied; [base] itself until the first render. */
        private var rendered: Bitmap = base
        private val toView = Matrix()
        private val toPreview = Matrix()
        private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)
        private val blurFill = Paint().apply {
            color = 0x55FFFFFF
            style = Paint.Style.FILL
        }
        private val blurEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = context.dpf(1.5f)
        }
        private val point = FloatArray(2)
        private var startX = 0f
        private var startY = 0f
        private var drag: Mark? = null
        private var released = false

        init {
            contentDescription = Strings.MARKUP_CANVAS_A11Y
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        fun setMarks(marks: List<Mark>) {
            if (released) return
            val next = if (marks.isEmpty()) {
                base
            } else {
                val copy = base.copy(Bitmap.Config.ARGB_8888, true) ?: return
                render(copy, marks, scale, strokePx)
                copy
            }
            if (rendered !== base) rendered.recycle()
            rendered = next
            invalidate()
        }

        fun release() {
            if (released) return
            released = true
            if (rendered !== base) rendered.recycle()
            base.recycle()
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            val s = min(w / base.width.toFloat(), h / base.height.toFloat())
            toView.setScale(s, s)
            toView.postTranslate((w - base.width * s) / 2f, (h - base.height * s) / 2f)
            toView.invert(toPreview)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (released) return
            canvas.drawBitmap(rendered, toView, bitmapPaint)
            val m = drag ?: return
            canvas.save()
            canvas.concat(toView)
            if (m.tool == Tool.BLUR) {
                val l = min(m.x0, m.x1) * scale
                val t = min(m.y0, m.y1) * scale
                val r = max(m.x0, m.x1) * scale
                val b = max(m.y0, m.y1) * scale
                canvas.drawRect(l, t, r, b, blurFill)
                canvas.drawRect(l, t, r, b, blurEdge)
            } else {
                drawStroke(canvas, m, scale, strokePaint(strokePx * scale))
            }
            canvas.restore()
        }

        /** View coordinates → image pixels, clamped to the image. */
        private fun toImage(x: Float, y: Float): FloatArray {
            point[0] = x
            point[1] = y
            toPreview.mapPoints(point)
            point[0] = (point[0] / scale).coerceIn(0f, imageWidth.toFloat())
            point[1] = (point[1] / scale).coerceIn(0f, imageHeight.toFloat())
            return point
        }

        @SuppressLint("ClickableViewAccessibility") // Drawing needs a finger; the editor's buttons stay accessible.
        override fun onTouchEvent(event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val p = toImage(event.x, event.y)
                    startX = p[0]
                    startY = p[1]
                    drag = null
                }
                MotionEvent.ACTION_MOVE -> {
                    val p = toImage(event.x, event.y)
                    drag = Mark(currentTool(), startX, startY, p[0], p[1])
                    invalidate()
                }
                MotionEvent.ACTION_UP -> {
                    val m = drag
                    drag = null
                    invalidate()
                    // A tap (or a tiny drag) is not a mark.
                    val minImagePx = context.dpf(MIN_DRAG_DP) / max(scale, 0.01f)
                    if (m != null && hypot(m.x1 - m.x0, m.y1 - m.y0) >= minImagePx) onMark(m)
                }
                MotionEvent.ACTION_CANCEL -> {
                    drag = null
                    invalidate()
                }
            }
            return true
        }

        companion object {
            private const val MIN_DRAG_DP = 8f
        }
    }
}
