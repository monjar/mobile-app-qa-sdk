/*
 * The settings the SDK actually runs with (spec §2.2).
 *
 * Until the first remote fetch succeeds: DEFAULT_SDK_CONFIG with the static
 * options (manifest / code) on top. After it: static options, then the remote
 * config on top — except captureMode, which remote config can only restrict
 * (off < snapshot < system): static `off` stays off, and static `snapshot` is
 * never upgraded to `system` because system mode needs manifest entries and the
 * snitch-system-capture module the app may not have.
 *
 * Android's interaction frame rate is 8 fps (iOS: 4). The contract default for
 * `video.activeFps` is 4, so a remote value equal to that default means "not
 * tuned" and maps to the Android default; any other value is honoured.
 */
package io.github.monjar.snitch.config

import io.github.monjar.snitch.SnitchCaptureMode
import io.github.monjar.snitch.SnitchOptions

internal data class EffectiveConfig(
    /** Remote kill switch (the app's own pause is tracked separately). */
    val remoteEnabled: Boolean,
    val reportTypes: List<ReportTypeOption>,
    val message: String?,
    val screenshotEnabled: Boolean,
    /** OFF when video is disabled remotely or by the capture-mode rule. */
    val captureMode: SnitchCaptureMode,
    val videoMaxSeconds: Int,
    val idleFps: Double,
    val activeFps: Double,
    val systemFps: Double,
    val budgetPct: Double,
    val maskTextInputs: Boolean,
    val screenshotPrompt: Boolean,
    val ttlSeconds: Long,
) {
    val videoEnabled: Boolean get() = captureMode != SnitchCaptureMode.OFF

    companion object {
        const val ANDROID_ACTIVE_FPS = 8.0

        fun resolve(options: SnitchOptions, remote: SdkConfig?): EffectiveConfig {
            val base = remote ?: SdkConfig.DEFAULT
            val v = base.video
            val staticMode = options.captureMode
            val mode = if (remote == null) {
                staticMode
            } else if (!v.enabled) {
                SnitchCaptureMode.OFF
            } else {
                restrict(staticMode, SnitchCaptureMode.fromWire(v.captureMode) ?: SnitchCaptureMode.SNAPSHOT)
            }
            return EffectiveConfig(
                remoteEnabled = base.enabled,
                reportTypes = base.reportTypes,
                message = base.message,
                screenshotEnabled = base.screenshotEnabled,
                captureMode = mode,
                videoMaxSeconds = (if (remote == null) options.videoMaxSeconds else v.maxSeconds).coerceIn(1, 30),
                idleFps = v.idleFps,
                activeFps = if (v.activeFps == SdkConfig.DEFAULT.video.activeFps) ANDROID_ACTIVE_FPS else v.activeFps,
                systemFps = v.systemFps,
                budgetPct = v.mainThreadBudgetPct,
                maskTextInputs = if (remote == null) options.maskTextInputs else base.maskTextInputs,
                screenshotPrompt = if (remote == null) options.screenshotPrompt else base.screenshotPrompt,
                ttlSeconds = base.ttlSeconds,
            )
        }

        private fun rank(m: SnitchCaptureMode): Int = when (m) {
            SnitchCaptureMode.OFF -> 0
            SnitchCaptureMode.SNAPSHOT -> 1
            SnitchCaptureMode.SYSTEM -> 2
        }

        /** The more restrictive of the two modes. */
        fun restrict(static: SnitchCaptureMode, remote: SnitchCaptureMode): SnitchCaptureMode =
            if (rank(remote) < rank(static)) remote else static
    }
}
