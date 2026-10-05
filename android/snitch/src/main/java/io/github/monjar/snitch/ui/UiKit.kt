/*
 * Small helpers for the plain-View UI: dp/sp sizing, a light/dark palette
 * picked from Configuration.uiMode, rounded backgrounds and window insets.
 * No AndroidX, no resources; text sizes in sp so font scale is respected.
 */
package io.github.monjar.snitch.ui

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.View
import android.view.WindowInsets
import android.widget.TextView

internal class Palette(val dark: Boolean) {
    val surface = if (dark) 0xFF1C1C1E.toInt() else Color.WHITE
    val onSurface = if (dark) Color.WHITE else 0xFF000000.toInt()
    val secondary = if (dark) 0xFFAEAEB2.toInt() else 0xFF6C6C70.toInt()
    val accent = if (dark) 0xFF0A84FF.toInt() else 0xFF007AFF.toInt()
    val onAccent = Color.WHITE
    val field = if (dark) 0xFF2C2C2E.toInt() else 0xFFF2F2F7.toInt()
    val handle = if (dark) 0x66FFFFFF else 0x33000000
    val disabled = if (dark) 0xFF3A3A3C.toInt() else 0xFFD1D1D6.toInt()

    /** Toast-like surfaces use the inverse colours so they stand out from the app. */
    val bannerBackground = if (dark) 0xF2F2F2F7.toInt() else 0xF21C1C1E.toInt()
    val bannerText = if (dark) 0xFF000000.toInt() else Color.WHITE

    companion object {
        fun of(context: Context): Palette =
            Palette((context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
    }
}

internal fun Context.dp(value: Float): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

internal fun Context.dpf(value: Float): Float = value * resources.displayMetrics.density

internal fun TextView.textSp(sp: Float) {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
}

internal fun roundedBackground(color: Int, radius: Float, strokeColor: Int = 0, strokeWidth: Int = 0): GradientDrawable =
    GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius
        if (strokeWidth > 0) setStroke(strokeWidth, strokeColor)
    }

internal fun topRoundedBackground(color: Int, radius: Float): GradientDrawable =
    GradientDrawable().apply {
        setColor(color)
        cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
    }

internal object Insets {
    /** System bars (and, when [ime], the keyboard) of the window [view] is attached to: (top, bottom). */
    fun of(view: View, ime: Boolean = false): Pair<Int, Int> {
        val insets = view.rootWindowInsets ?: return 0 to 0
        return if (Build.VERSION.SDK_INT >= 30) {
            val types = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or (if (ime) WindowInsets.Type.ime() else 0)
            val i = insets.getInsets(types)
            i.top to i.bottom
        } else {
            @Suppress("DEPRECATION")
            insets.systemWindowInsetTop to insets.systemWindowInsetBottom
        }
    }
}
