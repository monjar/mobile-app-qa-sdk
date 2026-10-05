/*
 * The seam between the core and the optional snitch-system-capture module
 * (spec §5.3). The core never references the module at compile time: it loads
 * `io.github.monjar.snitch.system.SystemCapture` with Class.forName and talks
 * to it through these two interfaces.
 *
 * Public only because Kotlin `internal` does not cross Gradle modules. They are
 * for the snitch-system-capture module; apps should not implement or call them,
 * and they may change in any release.
 */
package io.github.monjar.snitch.capture

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap

/** Implemented by the core; the system-capture module pushes display frames into it. */
interface FrameSink {
    /** False while the app is in the background, the Snitch sheet is open, or recording is paused: skip the work. */
    val isAcceptingFrames: Boolean

    /** Frames per second to keep from the system capture (remote `video.systemFps`). */
    val systemFps: Double

    /**
     * Masks, checksums and JPEG-encodes [bitmap] — the whole display, scaled by [scale]
     * (bitmap pixels per display pixel) — and adds it to the frame ring. Runs on the
     * caller's thread; [bitmap] may be reused as soon as this returns.
     */
    fun submitDisplayFrame(bitmap: Bitmap, scale: Float, uptimeMs: Long)

    /** The user granted consent and frames will follow. */
    fun onSystemCaptureStarted()

    /** Capture ended: consent declined ([declined] = true), projection revoked, or an error. The core falls back to snapshot mode. */
    fun onSystemCaptureStopped(declined: Boolean)
}

/** Implemented by `io.github.monjar.snitch.system.SystemCapture` (public no-arg constructor). */
interface SystemCaptureModule {
    /** Ask for MediaProjection consent from [activity] and start capturing into [sink]. */
    fun start(activity: Activity, sink: FrameSink)

    /** Stop capturing and release the projection. */
    fun stop(context: Context)

    companion object {
        const val CLASS_NAME = "io.github.monjar.snitch.system.SystemCapture"
    }
}
