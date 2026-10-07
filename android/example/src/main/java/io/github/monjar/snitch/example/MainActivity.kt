/*
 * Example screen for the Snitch SDK (and the target of the instrumented tests):
 * - a list of rows; holding one for 600 ms counts a long-press, and every
 *   ACTION_CANCEL a row receives is counted too — the three-finger gesture must
 *   cancel the rows' touches before their long-press fires
 * - a text field (masked in screenshots and video by default)
 * - an animated colour band, so captured frames keep changing
 * - a Report button calling Snitch.show()
 * Plain framework Views; no AndroidX.
 */
package io.github.monjar.snitch.example

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.monjar.snitch.Snitch

class MainActivity : Activity() {
    /** Read by the instrumented tests on the main thread. */
    var longPresses = 0
        private set
    var cancels = 0
        private set

    lateinit var rows: List<View>
        private set

    private lateinit var longPressLabel: TextView
    private lateinit var cancelLabel: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(16)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
            setPadding(pad, pad, pad, pad)
        }
        longPressLabel = TextView(this).apply { textSize = 16f }
        cancelLabel = TextView(this).apply { textSize = 16f }
        root.addView(longPressLabel)
        root.addView(cancelLabel)
        root.addView(
            EditText(this).apply {
                hint = "Type something (masked in captures)"
                isSingleLine = true
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
        root.addView(HueView(this), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(8) })
        root.addView(
            Button(this).apply {
                text = "Report"
                setOnClickListener { Snitch.show() }
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) },
        )
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        rows = (1..12).map { i ->
            PressRow(this, "Row $i — hold for 600 ms", ::onLongPress, ::onCancel).also {
                list.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64)))
            }
        }
        root.addView(ScrollView(this).apply { addView(list) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        updateLabels()
    }

    private fun onLongPress() {
        longPresses++
        updateLabels()
    }

    private fun onCancel() {
        cancels++
        updateLabels()
    }

    private fun updateLabels() {
        longPressLabel.text = "Long presses: $longPresses"
        cancelLabel.text = "Cancels: $cancels"
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()
}

/** A row with its own 600 ms long-press timer, so the test controls the timing exactly. */
class PressRow(
    context: Context,
    label: String,
    private val onLongPress: () -> Unit,
    private val onCancel: () -> Unit,
) : TextView(context) {
    private val longPress = Runnable {
        isPressed = false
        onLongPress()
    }

    init {
        text = label
        textSize = 16f
        gravity = Gravity.CENTER_VERTICAL
        setPadding(24, 0, 24, 0)
        setBackgroundColor(Color.TRANSPARENT)
        isClickable = true
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                isPressed = true
                setBackgroundColor(0x220000FF)
                postDelayed(longPress, LONG_PRESS_MS)
            }
            MotionEvent.ACTION_UP -> {
                removeCallbacks(longPress)
                release()
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPress)
                release()
                onCancel()
            }
        }
        return true
    }

    override fun performClick(): Boolean = super.performClick()

    private fun release() {
        isPressed = false
        setBackgroundColor(Color.TRANSPARENT)
    }

    companion object {
        const val LONG_PRESS_MS = 600L
    }
}

/** A colour band whose hue follows the clock (not ValueAnimator, so it moves even with animations disabled). */
class HueView(context: Context) : View(context) {
    private val paint = Paint()
    private val hsv = floatArrayOf(0f, 0.6f, 0.95f)

    override fun onDraw(canvas: Canvas) {
        hsv[0] = (SystemClock.uptimeMillis() / 20 % 360).toFloat()
        paint.color = Color.HSVToColor(hsv)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
        val markerX = (SystemClock.uptimeMillis() / 10 % width.coerceAtLeast(1)).toFloat()
        paint.color = Color.WHITE
        canvas.drawRect(markerX, 0f, markerX + 8f, height.toFloat(), paint)
        postInvalidateDelayed(FRAME_MS)
    }

    companion object {
        private const val FRAME_MS = 50L
    }
}
