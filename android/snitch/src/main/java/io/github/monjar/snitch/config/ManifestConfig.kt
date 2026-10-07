/*
 * Static configuration from the app manifest (spec §2.1): `<meta-data
 * android:name="io.github.monjar.snitch.*">` on <application>. Values may be
 * typed by aapt (true → Boolean, 30 → Integer) or strings, so everything is
 * read leniently. Also reads the debug hooks (`DEBUG_*`, spec §9) and the
 * RELEASE_TYPE override, which apps usually set per build type with
 * manifestPlaceholders.
 */
package io.github.monjar.snitch.config

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import io.github.monjar.snitch.SnitchCaptureMode
import io.github.monjar.snitch.SnitchDebugOverrides
import io.github.monjar.snitch.SnitchGesture
import io.github.monjar.snitch.SnitchLog
import io.github.monjar.snitch.SnitchOptions
import io.github.monjar.snitch.SnitchReleaseType

/** Everything start() needs, from code or from the manifest. */
internal data class StartConfig(
    val serverUrl: String?,
    val ingestKey: String?,
    val options: SnitchOptions,
    val releaseTypeOverride: String?,
    val debug: SnitchDebugOverrides?,
)

internal data class ManifestConfig(
    val enabled: Boolean,
    val serverUrl: String?,
    val ingestKey: String?,
    val options: SnitchOptions,
    val releaseTypeOverride: String?,
    val debug: SnitchDebugOverrides?,
) {
    fun toStartConfig() = StartConfig(serverUrl, ingestKey, options, releaseTypeOverride, debug)
}

internal object ManifestConfigReader {
    private const val P = "io.github.monjar.snitch."
    const val KEY_SERVER_URL = P + "SERVER_URL"

    fun metaData(context: Context): Bundle? = try {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(context.packageName, PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        }
        info.metaData
    } catch (e: Exception) {
        SnitchLog.warn("cannot read manifest meta-data", e)
        null
    }

    fun read(context: Context): ManifestConfig {
        val md = metaData(context) ?: Bundle.EMPTY
        val d = SnitchOptions()
        val types = string(md, "ENABLED_RELEASE_TYPES")
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?.mapNotNull { checked("ENABLED_RELEASE_TYPES", it, SnitchReleaseType.fromWire(it)) }
            ?.toSet()
        val options = SnitchOptions(
            enabledReleaseTypes = if (types.isNullOrEmpty()) d.enabledReleaseTypes else types,
            gesture = string(md, "GESTURE")?.let { checked("GESTURE", it, SnitchGesture.fromWire(it)) } ?: d.gesture,
            screenshotPrompt = bool(md, "SCREENSHOT_PROMPT") ?: d.screenshotPrompt,
            maskTextInputs = bool(md, "MASK_TEXT_INPUTS") ?: d.maskTextInputs,
            captureMode = string(md, "CAPTURE_MODE")?.let { checked("CAPTURE_MODE", it, SnitchCaptureMode.fromWire(it)) } ?: d.captureMode,
            videoMaxSeconds = int(md, "VIDEO_MAX_SECONDS")?.coerceIn(1, 30) ?: d.videoMaxSeconds,
            showTesterNotice = bool(md, "SHOW_TESTER_NOTICE") ?: d.showTesterNotice,
        )
        val debugServer = string(md, "DEBUG_SERVER_URL")
        val debugKey = string(md, "DEBUG_INGEST_KEY")
        val autoReport = int(md, "DEBUG_AUTOREPORT")
        val cancelAfter = int(md, "DEBUG_CANCEL_AFTER_MS")?.toLong()
        val showOnLaunch = bool(md, "DEBUG_SHOW_ON_LAUNCH") ?: false
        val debug = if (debugServer != null || debugKey != null || autoReport != null || cancelAfter != null || showOnLaunch) {
            SnitchDebugOverrides(debugServer, debugKey, autoReport, cancelAfter, showOnLaunch)
        } else {
            null
        }
        return ManifestConfig(
            enabled = bool(md, "ENABLED") ?: true,
            serverUrl = string(md, "SERVER_URL"),
            ingestKey = string(md, "INGEST_KEY"),
            options = options,
            releaseTypeOverride = string(md, "RELEASE_TYPE"),
            debug = debug,
        )
    }

    private fun warnValue(key: String, value: String) {
        SnitchLog.warnOnce("manifest-$key", "ignoring invalid meta-data $P$key=\"$value\"")
    }

    /** [parsed], warning once when the raw value was not understood. */
    private fun <T> checked(key: String, raw: String, parsed: T?): T? {
        if (parsed == null) warnValue(key, raw)
        return parsed
    }

    @Suppress("DEPRECATION")
    private fun raw(md: Bundle, key: String): Any? = md.get(P + key)

    private fun string(md: Bundle, key: String): String? = raw(md, key)?.toString()?.trim()?.ifEmpty { null }

    private fun bool(md: Bundle, key: String): Boolean? = when (val v = raw(md, key)) {
        is Boolean -> v
        is String -> when (v.trim().lowercase()) {
            "true", "1", "yes" -> true
            "false", "0", "no" -> false
            else -> checked<Boolean>(key, v, null)
        }
        is Number -> v.toInt() != 0
        else -> null
    }

    private fun int(md: Bundle, key: String): Int? = when (val v = raw(md, key)) {
        is Number -> v.toInt()
        is String -> checked(key, v, v.trim().toIntOrNull())
        else -> null
    }
}
