/*
 * Small Snitch surfaces shown over the app without touching its view tree:
 * the toast-like top banner ("Sending…" → "Sent · MOCH-42"), the one-time
 * tester notice card, and the prompt pill ("Report this screen?", and the crash
 * follow-up's "The app closed unexpectedly. Report it?").
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

/**
 * A pill at the top of the screen: "Report this screen?" after a system
 * screenshot, or the crash follow-up. Tapping it runs onTap; with onDismiss it
 * also has a close button. It hides by itself after durationMs (that is not a
 * dismissal: onDismiss only runs when the tester closes it).
 */
internal class PromptPill(private val handler: Handler) {
    private var overlay: OverlayWindow? = null
    private val hide = Runnable { dismiss() }

    /** False when the activity's window can't take it yet (not attached, finishing). */
    fun show(activity: Activity, text: String, durationMs: Long, onTap: () -> Unit, onDismiss: (() -> Unit)? = null): Boolean {
        dismiss()
        val p = Palette.of(activity)
        val label = TextView(activity).apply {
            this.text = text
            textSp(15f)
            setTextColor(p.onAccent)
            isClickable = true
            isFocusable = true
            setOnClickListener {
                dismiss()
                onTap()
            }
        }
        val content: View = if (onDismiss == null) {
            label.apply {
                background = roundedBackground(p.accent, activity.dpf(22f))
                setPadding(activity.dp(20f), activity.dp(12f), activity.dp(20f), activity.dp(12f))
                elevation = activity.dpf(8f)
            }
        } else {
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = roundedBackground(p.accent, activity.dpf(22f))
                elevation = activity.dpf(8f)
                label.setPadding(activity.dp(20f), activity.dp(12f), activity.dp(8f), activity.dp(12f))
                addView(label, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(
                    TextView(activity).apply {
                        this.text = "✕"
                        textSp(15f)
                        setTextColor(p.onAccent)
                        gravity = Gravity.CENTER
                        contentDescription = Strings.DISMISS
                        isClickable = true
                        isFocusable = true
                        setOnClickListener {
                            dismiss()
                            onDismiss()
                        }
                    },
                    LinearLayout.LayoutParams(activity.dp(44f), activity.dp(44f)),
                )
            }
        }
        val o = OverlayWindow(activity, Gravity.TOP)
        val top = activity.window?.peekDecorView()?.let { Insets.of(it).first } ?: 0
        val width = if (onDismiss == null) {
            ViewGroup.LayoutParams.WRAP_CONTENT
        } else {
            minOf(activity.resources.displayMetrics.widthPixels - activity.dp(32f), activity.dp(420f))
        }
        if (!o.show(content, top + activity.dp(12f), touchable = true, width = width)) return false
        overlay = o
        handler.postDelayed(hide, durationMs)
        return true
    }

    fun dismiss() {
        handler.removeCallbacks(hide)
        overlay?.remove()
        overlay = null
    }

    fun onActivityPaused(activity: Activity) {
        if (overlay?.belongsTo(activity) == true) dismiss()
    }
}
