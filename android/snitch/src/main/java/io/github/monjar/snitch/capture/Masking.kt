/*
 * Masking (spec §5.5). On the main thread, walk the window's view tree and
 * collect the on-screen rectangles of views that must not be recorded:
 * every EditText (when maskTextInputs), views registered with Snitch.mask(),
 * and views a registered predicate accepts (the React Native wrapper reads the
 * testID). Hidden, transparent (alpha < 0.01) and zero-sized views are skipped,
 * and a masked view's children are not visited. Rectangles use the visible
 * part of each view (getGlobalVisibleRect), i.e. window coordinates.
 *
 * Windows flagged FLAG_SECURE are skipped entirely by the capturers.
 *
 * Off the main thread, the rectangles are painted onto the frame bitmap:
 * solid #8E8E93 with a 1 px darker border, so what the tester previews is what
 * is sent.
 */
package io.github.monjar.snitch.capture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import java.util.WeakHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** Views registered with Snitch.mask (held weakly) and mask predicates. */
internal class MaskRegistry {
    private val views = WeakHashMap<View, Boolean>()
    private val predicates = CopyOnWriteArrayList<(View) -> Boolean>()

    fun add(view: View) = synchronized(views) { views[view] = true }

    fun remove(view: View) = synchronized(views) { views.remove(view) }

    fun addPredicate(p: (View) -> Boolean) {
        predicates.add(p)
    }

    fun isRegistered(view: View): Boolean = synchronized(views) { views.containsKey(view) }

    fun hasRegistrations(): Boolean = synchronized(views) { views.isNotEmpty() } || predicates.isNotEmpty()

    fun matchesPredicate(view: View): Boolean {
        for (p in predicates) {
            try {
                if (p(view)) return true
            } catch (_: Throwable) {
                // A broken predicate must not break capture.
            }
        }
        return false
    }
}

/** A growable list of rectangles stored as [l, t, r, b, …] in window pixels. */
internal class MaskRects {
    var data = FloatArray(32)
        private set
    var count = 0
        private set

    fun clear() {
        count = 0
    }

    fun add(l: Float, t: Float, r: Float, b: Float) {
        if ((count + 1) * 4 > data.size) data = data.copyOf(data.size * 2)
        val i = count * 4
        data[i] = l
        data[i + 1] = t
        data[i + 2] = r
        data[i + 3] = b
        count++
    }

    /** A scaled, translated copy for painting on another thread. */
    fun scaled(scale: Float, dx: Float = 0f, dy: Float = 0f): FloatArray {
        val out = FloatArray(count * 4)
        for (k in 0 until count) {
            val i = k * 4
            out[i] = data[i] * scale + dx
            out[i + 1] = data[i + 1] * scale + dy
            out[i + 2] = data[i + 2] * scale + dx
            out[i + 3] = data[i + 3] * scale + dy
        }
        return out
    }
}

internal object Masking {
    /** The app marked the window FLAG_SECURE: it must not be captured at all. */
    fun isSecure(window: Window): Boolean = (window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0

    private val rect = Rect()
    private val fill = Paint().apply {
        color = Color.rgb(0x8E, 0x8E, 0x93)
        style = Paint.Style.FILL
    }
    private val border = Paint().apply {
        color = Color.rgb(0x63, 0x63, 0x66)
        style = Paint.Style.STROKE
        strokeWidth = 1f
    }

    /** Main thread only. Appends the rectangles to mask under [root] (window coordinates) to [out]. */
    fun collect(root: View, maskTextInputs: Boolean, registry: MaskRegistry, out: MaskRects) {
        out.clear()
        if (!maskTextInputs && !registry.hasRegistrations()) return
        visit(root, maskTextInputs, registry, out)
    }

    private fun visit(view: View, maskTextInputs: Boolean, registry: MaskRegistry, out: MaskRects) {
        if (view.visibility != View.VISIBLE || view.alpha < 0.01f || view.width <= 0 || view.height <= 0) return
        val masked = (maskTextInputs && view is EditText) || registry.isRegistered(view) || registry.matchesPredicate(view)
        if (masked) {
            if (view.getGlobalVisibleRect(rect)) {
                out.add(rect.left.toFloat() - 1f, rect.top.toFloat() - 1f, rect.right.toFloat() + 1f, rect.bottom.toFloat() + 1f)
            }
            return
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) visit(view.getChildAt(i), maskTextInputs, registry, out)
        }
    }

    /** Any thread. Paints [rects] ([l, t, r, b, …] in bitmap pixels) onto [bitmap]. */
    fun paint(bitmap: Bitmap, rects: FloatArray) {
        if (rects.isEmpty()) return
        val canvas = Canvas(bitmap)
        synchronized(fill) {
            var i = 0
            while (i + 3 < rects.size) {
                canvas.drawRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3], fill)
                canvas.drawRect(rects[i] + 0.5f, rects[i + 1] + 0.5f, rects[i + 2] - 0.5f, rects[i + 3] - 0.5f, border)
                i += 4
            }
        }
    }
}
