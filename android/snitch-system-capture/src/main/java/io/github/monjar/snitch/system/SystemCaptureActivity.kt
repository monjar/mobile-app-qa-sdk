/*
 * Translucent, UI-less activity that asks for MediaProjection consent
 * (MediaProjectionManager.createScreenCaptureIntent) and, on consent, starts
 * SnitchProjectionService with the result. A decline is reported to the core,
 * which falls back to snapshot mode for the rest of the session. The core
 * ignores this activity in its lifecycle tracking (no wrapping, no capture).
 */
package io.github.monjar.snitch.system

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle

class SystemCaptureActivity : Activity() {
    private var requested = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requested = savedInstanceState?.getBoolean(KEY_REQUESTED) ?: false
        if (requested) return
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (mpm == null) {
            finishWith(declined = false)
            return
        }
        try {
            @Suppress("DEPRECATION") // android.app.Activity's result API; no AndroidX here.
            startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST)
            requested = true
        } catch (e: Exception) {
            finishWith(declined = false)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(KEY_REQUESTED, requested)
    }

    @Deprecated("android.app.Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST) return
        if (resultCode == RESULT_OK && data != null) {
            val service = Intent(this, SnitchProjectionService::class.java)
                .putExtra(SnitchProjectionService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(SnitchProjectionService.EXTRA_RESULT_DATA, data)
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
            } catch (e: Exception) {
                // e.g. ForegroundServiceStartNotAllowedException.
                SinkHolder.sink?.onSystemCaptureStopped(declined = false)
            }
            finish()
            overrideTransitionCompat()
        } else {
            finishWith(declined = true)
        }
    }

    private fun finishWith(declined: Boolean) {
        SinkHolder.sink?.onSystemCaptureStopped(declined)
        finish()
        overrideTransitionCompat()
    }

    @Suppress("DEPRECATION")
    private fun overrideTransitionCompat() {
        overridePendingTransition(0, 0)
    }

    companion object {
        private const val REQUEST = 0x5317
        private const val KEY_REQUESTED = "snitch.requested"
    }
}
