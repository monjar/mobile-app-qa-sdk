/*
 * Test hooks (spec §9), honoured only when the release type is `debug`.
 *
 * Sources, later wins per field:
 *   1. manifest meta-data io.github.monjar.snitch.DEBUG_SERVER_URL, DEBUG_INGEST_KEY,
 *      DEBUG_AUTOREPORT (s), DEBUG_CANCEL_AFTER_MS, DEBUG_SHOW_ON_LAUNCH
 *   2. Snitch.debugOverrides(SnitchDebugOverrides(...)) — the instrumentation-friendly
 *      setter; works before start or at any time after it.
 * Android has no equivalent of the iOS process environment for an installed app,
 * and reading `debug.snitch.*` system properties would need hidden APIs, so these
 * two sources replace it. Pure Kotlin.
 */
package io.github.monjar.snitch.debug

import io.github.monjar.snitch.SnitchDebugOverrides

internal object DebugHooks {
    /** Field-wise merge; [override] wins where it sets a value. */
    fun merge(base: SnitchDebugOverrides?, override: SnitchDebugOverrides?): SnitchDebugOverrides? {
        if (base == null) return override
        if (override == null) return base
        return SnitchDebugOverrides(
            serverUrl = override.serverUrl ?: base.serverUrl,
            ingestKey = override.ingestKey ?: base.ingestKey,
            autoReportAfterSeconds = override.autoReportAfterSeconds ?: base.autoReportAfterSeconds,
            cancelAfterMs = override.cancelAfterMs ?: base.cancelAfterMs,
            showOnLaunch = override.showOnLaunch || base.showOnLaunch,
        )
    }

    /** Autoreport: type `bug`, description `autoreport`, screenshot + min(5, buffered) s of video, trigger `api`. */
    const val AUTOREPORT_TYPE = "bug"
    const val AUTOREPORT_DESCRIPTION = "autoreport"
    const val AUTOREPORT_MAX_VIDEO_SECONDS = 5
    const val SHOW_ON_LAUNCH_DELAY_MS = 2000L
}
