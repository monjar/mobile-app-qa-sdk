/*
 * Public API of the Snitch Android SDK (spec §8.2).
 *
 * `Snitch` is a thin, thread-safe facade: state that may be set before start()
 * (user, metadata, logs, masks, wrapper) lives in SnitchState, and everything
 * else is delegated to the SnitchRuntime created by start(). Every method may
 * be called from any thread; UI work hops to the main thread internally.
 *
 * Autostart: SnitchInitProvider calls start(context) when the manifest has the
 * SERVER_URL meta-data, so most apps never call start() themselves.
 */
package io.github.monjar.snitch

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import io.github.monjar.snitch.config.ManifestConfigReader
import io.github.monjar.snitch.config.StartConfig

/** How the running build was distributed (wire values from contract/src/enums.ts). */
enum class SnitchReleaseType(val wireValue: String) {
    DEBUG("debug"),
    ADHOC("adhoc"),
    ENTERPRISE("enterprise"),
    TESTFLIGHT("testflight"),
    APPSTORE("appstore"),
    INTERNAL("internal"),
    PLAY("play"),
    UNKNOWN("unknown"),
    ;

    companion object {
        /** Every pre-release channel; store builds (`play`, `appstore`) and `unknown` stay off. */
        @JvmField
        val DEFAULT_ENABLED: Set<SnitchReleaseType> = setOf(DEBUG, ADHOC, ENTERPRISE, TESTFLIGHT, INTERNAL)

        @JvmStatic
        fun fromWire(value: String?): SnitchReleaseType? {
            val v = value?.trim()?.lowercase() ?: return null
            return entries.firstOrNull { it.wireValue == v }
        }
    }
}

enum class SnitchLogLevel { DEBUG, INFO, WARN, ERROR }

/** What opens the report sheet. */
enum class SnitchGesture(val wireValue: String) {
    THREE_FINGER_HOLD("threeFingerHold"),
    SHAKE("shake"),
    BOTH("both"),
    NONE("none"),
    ;

    companion object {
        @JvmStatic
        fun fromWire(value: String?): SnitchGesture? = entries.firstOrNull { it.wireValue.equals(value?.trim(), ignoreCase = true) }
    }
}

/** Where video frames come from. `SYSTEM` needs the snitch-system-capture module. */
enum class SnitchCaptureMode(val wireValue: String) {
    SNAPSHOT("snapshot"),
    SYSTEM("system"),
    OFF("off"),
    ;

    companion object {
        @JvmStatic
        fun fromWire(value: String?): SnitchCaptureMode? = entries.firstOrNull { it.wireValue.equals(value?.trim(), ignoreCase = true) }
    }
}

/** Static options (spec §2.1). Remote config is applied on top at run time. */
data class SnitchOptions @JvmOverloads constructor(
    val enabledReleaseTypes: Set<SnitchReleaseType> = SnitchReleaseType.DEFAULT_ENABLED,
    val gesture: SnitchGesture = SnitchGesture.THREE_FINGER_HOLD,
    /** "Report this screen?" after a system screenshot; Android 14+ and only with DETECT_SCREEN_CAPTURE. */
    val screenshotPrompt: Boolean = true,
    val maskTextInputs: Boolean = true,
    val captureMode: SnitchCaptureMode = SnitchCaptureMode.SNAPSHOT,
    /** Longest clip offered, 1–30 s. */
    val videoMaxSeconds: Int = 30,
    val showTesterNotice: Boolean = true,
) {
    companion object {
        /**
         * Builds options from lowerCamelCase keys mirroring spec §2.1 (`enabledReleaseTypes`,
         * `gesture`, `screenshotPrompt`, `maskTextInputs`, `captureMode`, `videoMaxSeconds`,
         * `showTesterNotice`). Unknown keys and invalid values are ignored. Used by the
         * React Native bridge.
         */
        @JvmStatic
        fun fromMap(map: Map<String, Any?>): SnitchOptions {
            val d = SnitchOptions()
            val types = when (val v = map["enabledReleaseTypes"]) {
                is Collection<*> -> v.mapNotNull { SnitchReleaseType.fromWire(it?.toString()) }.toSet()
                is String -> v.split(',').mapNotNull { SnitchReleaseType.fromWire(it) }.toSet()
                else -> null
            }
            return SnitchOptions(
                enabledReleaseTypes = if (types.isNullOrEmpty()) d.enabledReleaseTypes else types,
                gesture = SnitchGesture.fromWire(map["gesture"]?.toString()) ?: d.gesture,
                screenshotPrompt = (map["screenshotPrompt"] as? Boolean) ?: d.screenshotPrompt,
                maskTextInputs = (map["maskTextInputs"] as? Boolean) ?: d.maskTextInputs,
                captureMode = SnitchCaptureMode.fromWire(map["captureMode"]?.toString()) ?: d.captureMode,
                videoMaxSeconds = (map["videoMaxSeconds"] as? Number)?.toInt()?.coerceIn(1, 30) ?: d.videoMaxSeconds,
                showTesterNotice = (map["showTesterNotice"] as? Boolean) ?: d.showTesterNotice,
            )
        }
    }
}

/**
 * Test hooks (spec §9). Honoured only when the release type is `debug`.
 *
 * Set them in code with [Snitch.debugOverrides] (instrumented tests: call it
 * from the test after the activity launched), or with meta-data
 * `io.github.monjar.snitch.DEBUG_SERVER_URL`, `DEBUG_INGEST_KEY`,
 * `DEBUG_AUTOREPORT` (seconds), `DEBUG_CANCEL_AFTER_MS`, `DEBUG_SHOW_ON_LAUNCH`.
 */
data class SnitchDebugOverrides @JvmOverloads constructor(
    val serverUrl: String? = null,
    val ingestKey: String? = null,
    /** File a report without UI this many seconds after the overrides apply (start, or the call). */
    val autoReportAfterSeconds: Int? = null,
    /** On every touch sequence, run the real fire path this long after the first touch down, then dismiss the sheet. */
    val cancelAfterMs: Long? = null,
    /** Open the sheet 2 s after the overrides apply. */
    val showOnLaunch: Boolean = false,
)

object Snitch {
    private val lock = Any()
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    @Volatile
    private var runtime: SnitchRuntime? = null

    @Volatile
    private var started = false

    @Volatile
    private var detectedReleaseType = SnitchReleaseType.UNKNOWN

    /** Starts from the manifest meta-data (`io.github.monjar.snitch.*`). */
    @JvmStatic
    fun start(context: Context) {
        val app = context.applicationContext ?: context
        val manifest = ManifestConfigReader.read(app)
        if (!manifest.enabled) {
            SnitchLog.info("disabled by io.github.monjar.snitch.ENABLED=false")
            return
        }
        startInternal(app, manifest.toStartConfig())
    }

    /** Starts with explicit values; they win over the manifest meta-data. */
    @JvmStatic
    @JvmOverloads
    fun start(context: Context, serverUrl: String, ingestKey: String, options: SnitchOptions = SnitchOptions()) {
        val app = context.applicationContext ?: context
        val manifest = ManifestConfigReader.read(app)
        startInternal(
            app,
            StartConfig(
                serverUrl = serverUrl,
                ingestKey = ingestKey,
                options = options,
                releaseTypeOverride = manifest.releaseTypeOverride,
                debug = manifest.debug,
            ),
        )
    }

    private fun startInternal(app: Context, config: StartConfig) {
        synchronized(lock) {
            if (started) {
                SnitchLog.infoOnce("start", "start() called again; ignoring")
                return
            }
            started = true
        }
        val result = SnitchRuntime.create(app, config)
        detectedReleaseType = result.releaseType
        runtime = result.runtime
    }

    /** Opens the report sheet (trigger `api`). [type] preselects a report type id. */
    @JvmStatic
    @JvmOverloads
    fun show(type: String? = null) {
        onMain { runtime?.showReport(trigger = "api", preselectType = type) }
    }

    @JvmStatic
    fun setUser(id: String?, email: String?, name: String?) {
        SnitchState.setUser(id, email, name)
    }

    /** Adds a key to the report's `custom` map; null removes it. */
    @JvmStatic
    fun setMetadata(key: String, value: String?) {
        SnitchState.setMetadata(key, value)
    }

    /** Appends a line to the in-memory log ring sent as the `logs` attachment. */
    @JvmStatic
    @JvmOverloads
    fun log(message: String, level: SnitchLogLevel = SnitchLogLevel.INFO) {
        SnitchState.logs.append(System.currentTimeMillis(), level, message)
    }

    /** Extra log text (e.g. the app's own logs) appended to the `logs` attachment at send time. */
    @JvmStatic
    fun setLogProvider(provider: (() -> String?)?) {
        SnitchState.logProvider = provider
    }

    /** Runtime pause by the app: false stops the gesture, capture and prompts until set back to true. */
    @JvmStatic
    fun setEnabled(enabled: Boolean) {
        SnitchState.appEnabled = enabled
        onMain { runtime?.onStateChanged() }
    }

    /** Started, release type allowed, not paused by the app, and enabled by remote config. */
    @JvmStatic
    val isEnabled: Boolean
        get() = runtime?.isEnabled ?: false

    @JvmStatic
    val releaseType: SnitchReleaseType
        get() = detectedReleaseType

    /** Masks [view] in screenshots and video (held weakly). */
    @JvmStatic
    fun mask(view: View) {
        SnitchState.masks.add(view)
    }

    @JvmStatic
    fun unmask(view: View) {
        SnitchState.masks.remove(view)
    }

    /** Masks every view for which [predicate] returns true. Called on the main thread during capture; keep it cheap. */
    @JvmStatic
    fun addMaskPredicate(predicate: (View) -> Boolean) {
        SnitchState.masks.addPredicate(predicate)
    }

    /** Set by wrappers (the React Native bridge sets `react-native`). */
    @JvmStatic
    fun setWrapper(name: String, version: String) {
        SnitchState.wrapper = name to version
    }

    /**
     * Applies test hooks (spec §9). Only honoured when the release type is `debug`;
     * see [SnitchDebugOverrides]. Safe to call before or after start.
     */
    @JvmStatic
    fun debugOverrides(overrides: SnitchDebugOverrides) {
        SnitchState.debugOverrides = overrides
        onMain { runtime?.applyDebugOverrides(overrides) }
    }

    /**
     * For instrumented tests: blocks the calling thread (never the main thread) until no
     * debug auto-report is pending and the outbox is empty, or [timeoutMs] passes.
     * Returns true when idle.
     */
    @JvmStatic
    fun debugAwaitIdle(timeoutMs: Long): Boolean {
        check(Looper.myLooper() != Looper.getMainLooper()) { "debugAwaitIdle must not run on the main thread" }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val rt = runtime ?: return true
            if (rt.isIdleForTests()) return true
            Thread.sleep(100)
        }
        return false
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }
}
