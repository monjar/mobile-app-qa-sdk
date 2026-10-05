/*
 * Small Snitch surfaces shown over the app without touching its view tree:
 * the toast-like top banner ("Sending…" → "Sent · MOCH-42"), the one-time
 * tester notice card, and the "Report this screen?" pill.
 *
 * Each is a TYPE_APPLICATION_PANEL window attached to the current activity's
 * window token — a sub-window, so it is never part of the activity's own
 * surface and therefore never appears in PixelCopy frames or screenshots, and
 * it needs no overlay permission. Non-focusable and not touch-modal: touches
 * outside it reach the app. Removed when the activity pauses.
 */
package io.github.monjar.snitch.ui

import android.app.Activity
import android.graphics.PixelFormat
import android.os.Handler
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

internal class OverlayWindow(private val activity: Activity, private val gravity: Int) {
    var view: View? = null
        private set

    val isShowing: Boolean get() = view != null

    fun show(content: View, yOffset: Int, touchable: Boolean, width: Int = ViewGroup.LayoutParams.WRAP_CONTENT): Boolean {
        remove()
        val decor = activity.window?.peekDecorView() ?: return false
        val token = decor.windowToken ?: return false
        if (activity.isFinishing) return false
        var flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        if (!touchable) flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        val lp = WindowManager.LayoutParams(
            width,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            flags,
            PixelFormat.TRANSLUCENT,
        )
        lp.token = token
        lp.gravity = gravity or Gravity.CENTER_HORIZONTAL
        lp.y = yOffset
        lp.title = "Snitch"
        return try {
            activity.windowManager.addView(content, lp)
            view = content
            true
        } catch (e: Exception) {
            // BadTokenException when the activity is going away.
            false
        }
    }

    fun remove() {
        val v = view ?: return
        view = null
        try {
            activity.windowManager.removeViewImmediate(v)
        } catch (_: Exception) {
        }
    }

    fun belongsTo(a: Activity) = a === activity
}

/** "Sending…" / "Sent · TICKET" at the top of the screen. */
internal class Banner(private val handler: Handler) {
    private var overlay: OverlayWindow? = null
    private var text: TextView? = null
    private val hide = Runnable { dismiss() }

    /** Shows [message] on [activity]; [durationMs] ≤ 0 keeps it until replaced. */
    fun show(activity: Activity, message: String, durationMs: Long) {
        handler.removeCallbacks(hide)
        val current = overlay
        val label = text
        if (current != null && current.isShowing && current.belongsTo(activity) && label != null) {
            label.text = message
        } else {
            dismiss()
            val p = Palette.of(activity)
            val tv = TextView(activity).apply {
                this.text = message
                textSp(14f)
                setTextColor(p.bannerText)
                background = roundedBackground(p.bannerBackground, activity.dpf(20f))
                setPadding(activity.dp(16f), activity.dp(10f), activity.dp(16f), activity.dp(10f))
                elevation = activity.dpf(6f)
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            }
            val o = OverlayWindow(activity, Gravity.TOP)
            val top = activity.window?.peekDecorView()?.let { Insets.of(it).first } ?: 0
            if (!o.show(tv, top + activity.dp(8f), touchable = false)) return
            overlay = o
            text = tv
        }
        if (durationMs > 0) handler.postDelayed(hide, durationMs)
    }

    fun dismiss() {
        handler.removeCallbacks(hide)
        overlay?.remove()
        overlay = null
        text = null
    }

    fun onActivityPaused(activity: Activity) {
        if (overlay?.belongsTo(activity) == true) dismiss()
    }
}

/** One-time tester notice card at the bottom. */
internal class TesterNotice(private val activity: Activity, private val message: String, private val onDone: () -> Unit) {
    private val overlay = OverlayWindow(activity, Gravity.BOTTOM)

    fun show(): Boolean {
        val p = Palette.of(activity)
        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBackground(p.surface, activity.dpf(16f))
            elevation = activity.dpf(12f)
            setPadding(activity.dp(16f), activity.dp(14f), activity.dp(16f), activity.dp(10f))
            minimumWidth = activity.dp(280f)
        }
        val width = minOf(activity.resources.displayMetrics.widthPixels - activity.dp(32f), activity.dp(420f))
        card.addView(
            TextView(activity).apply {
                text = message
                textSp(14f)
                setTextColor(p.onSurface)
                setLineSpacing(0f, 1.15f)
            },
        )
        card.addView(
            Button(activity).apply {
                text = Strings.GOT_IT
                isAllCaps = false
                setTextColor(p.accent)
                background = null
                setOnClickListener { dismiss() }
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.END },
        )
        val bottom = activity.window?.peekDecorView()?.let { Insets.of(it).second } ?: 0
        return overlay.show(card, bottom + activity.dp(16f), touchable = true, width = width)
    }

    fun dismiss() {
        if (!overlay.isShowing) return
        overlay.remove()
        onDone()
    }

    fun belongsTo(a: Activity) = overlay.belongsTo(a)
}

/** "Report this screen?" pill after a system screenshot, for 4 s. */
internal class ScreenshotPromptPill(private val handler: Handler) {
    private var overlay: OverlayWindow? = null
    private val hide = Runnable { dismiss() }

    fun show(activity: Activity, onTap: () -> Unit) {
        dismiss()
        val p = Palette.of(activity)
        val pill = TextView(activity).apply {
            text = Strings.REPORT_THIS_SCREEN
            textSp(15f)
            setTextColor(p.onAccent)
            background = roundedBackground(p.accent, activity.dpf(22f))
            setPadding(activity.dp(20f), activity.dp(12f), activity.dp(20f), activity.dp(12f))
            elevation = activity.dpf(8f)
            isClickable = true
            setOnClickListener {
                dismiss()
                onTap()
            }
        }
        val o = OverlayWindow(activity, Gravity.TOP)
        val top = activity.window?.peekDecorView()?.let { Insets.of(it).first } ?: 0
        if (!o.show(pill, top + activity.dp(12f), touchable = true)) return
        overlay = o
        handler.postDelayed(hide, DURATION_MS)
    }

    fun dismiss() {
        handler.removeCallbacks(hide)
        overlay?.remove()
        overlay = null
    }

    fun onActivityPaused(activity: Activity) {
        if (overlay?.belongsTo(activity) == true) dismiss()
    }

    companion object {
        private const val DURATION_MS = 4000L
    }
}
