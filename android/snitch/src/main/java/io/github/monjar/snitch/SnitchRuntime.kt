/*
 * The running SDK: created by Snitch.start() once the release type is allowed
 * and the server URL / ingest key are valid; never torn down.
 *
 * Threads:
 * - main: lifecycle callbacks, window wrapping, view traversal (masks), PixelCopy
 *   requests, UI. Everything here is cheap; state below marked "main" is only
 *   touched on the main thread.
 * - snitch-io (single thread): SharedPreferences reads, remote config, outbox
 *   writes, video composition, logcat reads, uploads, the crash follow-up's
 *   files — serially, so uploads never race.
 * - snitch-capture (HandlerThread): PixelCopy callbacks, masking, checksums, JPEG.
 *
 * The runtime reacts to a handful of inputs — lifecycle, remote config, the app's
 * setEnabled, power/thermal, the sheet — by recomputing what should run in
 * onStateChanged(), so "remote config says disabled" stops the gesture, capture,
 * timeline and prompts immediately and re-enables them just as easily.
 *
 * 0.3 (spec §11): every config fetch is a check-in (installId, signals, …); the
 * report timeline (SnitchState.timeline) is switched by onStateChanged, fed by
 * lifecycle events, resumed activities and the touch log, frozen with the
 * capture when the sheet opens and written at Send with this process's logcat;
 * and the crash follow-up saves crashes and the session log, then offers to
 * report them on the next launch.
 */
package io.github.monjar.snitch

import android.app.Activity
import android.app.Application
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.SharedPreferences
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.Window
import io.github.monjar.snitch.capture.CaptureHost
import io.github.monjar.snitch.capture.Frame
import io.github.monjar.snitch.capture.FrameStore
import io.github.monjar.snitch.capture.Screenshot
import io.github.monjar.snitch.capture.ScreenshotTaker
import io.github.monjar.snitch.capture.SnapshotCapturer
import io.github.monjar.snitch.capture.SystemCaptureController
import io.github.monjar.snitch.capture.SystemCaptureHost
import io.github.monjar.snitch.capture.TouchLog
import io.github.monjar.snitch.capture.TouchSample
import io.github.monjar.snitch.config.EffectiveConfig
import io.github.monjar.snitch.config.InstallId
import io.github.monjar.snitch.config.KeyValueStore
import io.github.monjar.snitch.config.RemoteConfigClient
import io.github.monjar.snitch.config.SdkConfig
import io.github.monjar.snitch.config.StartConfig
import io.github.monjar.snitch.crash.CrashHandler
import io.github.monjar.snitch.crash.CrashStore
import io.github.monjar.snitch.crash.ExitReasons
import io.github.monjar.snitch.crash.PendingCrash
import io.github.monjar.snitch.debug.DebugHooks
import io.github.monjar.snitch.env.DeviceInfoCollector
import io.github.monjar.snitch.env.NetworkMonitor
import io.github.monjar.snitch.env.PowerMonitor
import io.github.monjar.snitch.env.ReleaseTypeDetector
import io.github.monjar.snitch.health.CaptureStats
import io.github.monjar.snitch.health.CrashLoopSentinel
import io.github.monjar.snitch.logic.FrameRing
import io.github.monjar.snitch.logic.GovernorConfig
import io.github.monjar.snitch.logic.LogcatParser
import io.github.monjar.snitch.logic.ReleaseTypeClassifier
import io.github.monjar.snitch.logic.ThermalState
import io.github.monjar.snitch.logic.TimelineLimits
import io.github.monjar.snitch.logic.TimelineNdjson
import io.github.monjar.snitch.logic.TimelineSnapshot
import io.github.monjar.snitch.logic.UrlSanitizer
import io.github.monjar.snitch.report.AppInfo
import io.github.monjar.snitch.report.AttachmentDecl
import io.github.monjar.snitch.report.Endpoint
import io.github.monjar.snitch.report.LogRing
import io.github.monjar.snitch.report.Outbox
import io.github.monjar.snitch.report.ReportBuilder
import io.github.monjar.snitch.report.ReportPayload
import io.github.monjar.snitch.report.ReporterInfo
import io.github.monjar.snitch.report.SdkInfo
import io.github.monjar.snitch.report.Sha256
import io.github.monjar.snitch.report.StatsSnapshot
import io.github.monjar.snitch.report.UploadOutcome
import io.github.monjar.snitch.report.Uploader
import io.github.monjar.snitch.timeline.LogcatReader
import io.github.monjar.snitch.timeline.ReportTimeline
import io.github.monjar.snitch.trigger.GestureHost
import io.github.monjar.snitch.trigger.ScreenshotObserver
import io.github.monjar.snitch.trigger.ShakeDetector
import io.github.monjar.snitch.trigger.WindowCallbackWrapper
import io.github.monjar.snitch.ui.Banner
import io.github.monjar.snitch.ui.PromptPill
import io.github.monjar.snitch.ui.ReportDialog
import io.github.monjar.snitch.ui.ReportDraft
import io.github.monjar.snitch.ui.ReportSheetListener
import io.github.monjar.snitch.ui.ReportSheetModel
import io.github.monjar.snitch.ui.Strings
import io.github.monjar.snitch.ui.TesterNotice
import io.github.monjar.snitch.ui.dp
import io.github.monjar.snitch.video.VideoComposer
import io.github.monjar.snitch.video.VideoResult
import java.io.File
import java.lang.ref.WeakReference
import java.net.URL
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal class StartResult(val releaseType: SnitchReleaseType, val runtime: SnitchRuntime?)

/** Everything frozen at trigger time for one report. */
internal class ReportSession(
    val trigger: String,
    /** Uptime ms the clip ends at: first finger down for the gesture, trigger time otherwise. */
    val endT: Long,
    val frames: List<Frame>,
    val touches: List<TouchSample>,
    val autoReport: Boolean,
    /** The timeline at trigger time; null while Snitch was off, and for the crash follow-up. */
    val timeline: TimelineSnapshot? = null,
    /** Touch downs of the last five minutes up to [endT], for the timeline. */
    val touchDowns: List<TouchSample> = emptyList(),
    /** Wall-clock ms minus uptime ms, taken once at freeze (converts touch-log and clip times). */
    val wallOffset: Long = 0,
    /** The crash this report follows up (trigger `crash`). */
    val crash: PendingCrash? = null,
) {
    @Volatile
    var screenshot: Screenshot? = null
        private set

    private val screenshotDone = CountDownLatch(1)

    /** Main thread: the screenshot finished (null: failed or disabled). */
    fun completeScreenshot(shot: Screenshot?) {
        screenshot = shot
        screenshotDone.countDown()
    }

    /** Main thread: the tester marked the screenshot up. */
    fun replaceScreenshot(shot: Screenshot) {
        screenshot = shot
    }

    /** I/O thread: a quick Send may beat the async screenshot; wait for it briefly. */
    fun awaitScreenshot(timeoutMs: Long): Screenshot? {
        screenshotDone.await(timeoutMs, TimeUnit.MILLISECONDS)
        return screenshot
    }

    val bufferedMs: Long get() = frames.firstOrNull()?.let { maxOf(0L, endT - it.t) } ?: 0L
}

internal class SnitchRuntime private constructor(
    private val app: Application,
    config: StartConfig,
    val releaseType: SnitchReleaseType,
    serverUrl: String,
    ingestKey: String,
    @Volatile private var debug: SnitchDebugOverrides?,
    /** Release-type signals for the check-ins (spec §3.1). */
    private val signals: String,
) : Application.ActivityLifecycleCallbacks, ComponentCallbacks2, GestureHost, CaptureHost, SystemCaptureHost {

    private val options = config.options
    private val main = Handler(Looper.getMainLooper())
    private val io: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "snitch-io").apply {
            isDaemon = true
            priority = Thread.NORM_PRIORITY - 1
        }
    }
    private val captureThread = HandlerThread("snitch-capture", Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
    private val captureHandler = Handler(captureThread.looper)
    private val prefs: SharedPreferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile
    private var baseUrl = serverUrl.trim().trimEnd('/')

    @Volatile
    private var key = ingestKey.trim()

    private val remote = RemoteConfigClient(PrefsStore(prefs), SnitchLog)

    @Volatile
    private var effective = EffectiveConfig.resolve(options, null)

    @Volatile
    private var governor = governorFor(effective)

    private val frames = FrameStore()
    private val touchLog = TouchLog()
    private val timeline = SnitchState.timeline
    private val stats = CaptureStats()
    private val power = PowerMonitor(app) { main.post { onStateChanged() } }
    private val network = NetworkMonitor(app) { runUploads() }
    private val deviceInfo = DeviceInfoCollector(app, power, network)
    private val outbox = Outbox(File(app.noBackupFilesDir, "snitch/outbox"), SnitchLog)
    private val uploader = Uploader(outbox, { endpoint() }, SnitchLog, chunkCap = { debug?.chunkBytes?.toLong() })
    private val appInfo by lazy { deviceInfo.app(releaseType.wireValue) }

    /** The check-in installId; created on first activation (first read, on the I/O thread). */
    private val installId: String by lazy { InstallId.getOrCreate(PrefsStore(prefs)) }

    // Debug builds are exempt: a developer re-running the app kills a foreground process every time.
    private val sentinel by lazy { CrashLoopSentinel(prefs, appInfo.build, enabled = releaseType != SnitchReleaseType.DEBUG) }
    private val snapshot: SnapshotCapturer? =
        if (Build.VERSION.SDK_INT >= 26) SnapshotCapturer(main, captureHandler, frames, stats, this) else null
    private var system: SystemCaptureController? = null
    private val screenshots = ScreenshotTaker(main, captureHandler)
    private val banner = Banner(main)
    private val prompt = PromptPill(main)
    private val crashPill = PromptPill(main)
    private val screenshotObserver = ScreenshotObserver { activity -> onSystemScreenshot(activity) }
    private var shake: ShakeDetector? = null
    private val wrappers = WeakHashMap<Window, WeakReference<WindowCallbackWrapper>>()

    // Crash follow-up (spec §11.8).
    private val crashStore = CrashStore(File(app.noBackupFilesDir, "snitch/crash"), SnitchLog)
    private var crashHandler: CrashHandler? = null

    @Volatile
    private var pendingCrash: PendingCrash? = null
    private var crashReady = false // main
    private var crashOffered = false // main
    private var crashOfferAttempts = 0 // main
    private var persistedLogVersion = 0L // io

    /** The app's label, to tell an activity's own title from the default one; loaded on the I/O thread at start. */
    @Volatile
    private var appLabel: String? = null

    // Written on the main thread; the @Volatile ones are also read by the capture/projection threads.
    @Volatile
    private var resumed: WeakReference<Activity>? = null
    private var startedCount = 0

    @Volatile
    private var foreground = false

    @Volatile
    private var dialog: ReportDialog? = null
    private var notice: TesterNotice? = null
    private var noticeHandled = false

    @Volatile
    private var recordingPaused = false

    @Volatile
    private var systemFallback = false

    @Volatile
    private var sentinelReady = false

    @Volatile
    private var lastVideoOn = false

    @Volatile
    private var lastTouch: Long? = null

    // any thread
    private val sessionReports = ConcurrentHashMap.newKeySet<String>()
    private val deferredShown = ConcurrentHashMap.newKeySet<String>()
    private val autoReportPending = AtomicBoolean(false)
    private val pendingSubmissions = AtomicInteger(0)
    private val uploadQueued = AtomicBoolean(false)

    @Volatile
    private var uploadRunning = false
    private var uploadTimer: ScheduledFuture<*>? = null

    // ── Start ───────────────────────────────────────────────────────────────

    private fun start() {
        app.registerActivityLifecycleCallbacks(this)
        app.registerComponentCallbacks(this)
        SnitchState.serverOrigin = UrlSanitizer.origin(baseUrl)
        if (options.crashPrompt) crashHandler = CrashHandler.install()
        updateTimeline()
        timeline.app("launch")
        SnitchState.appScreen?.let { timeline.screen(it, "app") }
        io.execute {
            // Binder calls (power, thermal, connectivity) stay off the main thread at app start.
            power.start()
            network.start()
            if (appLabel == null) appLabel = loadAppLabel()

            remote.loadCache(baseUrl)?.let { main.post { applyRemote() } }
            sentinel.checkPreviousSession()
            main.post {
                sentinelReady = true
                onStateChanged()
            }
            if (options.crashPrompt) prepareCrashFollowUp()
            outbox.removeAbandoned(System.currentTimeMillis())
            fetchConfig()
            runUploads()
            if (options.showTesterNotice && !prefs.getBoolean(K_NOTICE_SHOWN, false)) {
                main.postDelayed(noticeCheck, NOTICE_DELAY_MS)
            }
        }
        if (options.crashPrompt) {
            io.scheduleWithFixedDelay({ persistSessionLog() }, SESSION_LOG_EVERY_MS, SESSION_LOG_EVERY_MS, TimeUnit.MILLISECONDS)
        }
        debug?.let { applyDebug(it, atStart = true) }
        // Started after the first screen resumed (JS start, or code in a later lifecycle
        // step): attach to it now rather than waiting for the next resume.
        ActivityTracker.resumedActivity?.let { current -> main.post { adopt(current) } }
        SnitchLog.info("started (${releaseType.wireValue}, ${options.captureMode.wireValue} capture, server $baseUrl)")
    }

    // ── State ───────────────────────────────────────────────────────────────

    /** The app hasn't paused us and remote config hasn't switched us off. */
    val isEnabled: Boolean get() = SnitchState.appEnabled && effective.remoteEnabled

    private val resumedActivity0: Activity? get() = resumed?.get()

    private val videoMode: SnitchCaptureMode
        get() {
            if (!isEnabled || Build.VERSION.SDK_INT < 26) return SnitchCaptureMode.OFF
            if (!sentinelReady || sentinel.downgraded) return SnitchCaptureMode.OFF
            val mode = effective.captureMode
            if (mode == SnitchCaptureMode.SYSTEM && (systemFallback || system?.isAvailable == false)) return SnitchCaptureMode.SNAPSHOT
            return mode
        }

    private val capturing: Boolean get() = foreground && !recordingPaused && dialog == null

    override val snapshotCaptureAllowed: Boolean get() = capturing && videoMode == SnitchCaptureMode.SNAPSHOT

    override val systemCaptureAccepting: Boolean get() = capturing && videoMode == SnitchCaptureMode.SYSTEM

    override val maskTextInputs: Boolean get() = effective.maskTextInputs

    override val lastTouchAt: Long? get() = lastTouch

    override val lowPower: Boolean get() = power.lowPower

    override val thermal: ThermalState get() = power.thermal

    override val governorConfig: GovernorConfig get() = governor

    override val systemFps: Double get() = effective.systemFps

    override val resumedActivity: Activity? get() = resumedActivity0

    override val gestureActive: Boolean
        get() = isEnabled &&
            (options.gesture == SnitchGesture.THREE_FINGER_HOLD || options.gesture == SnitchGesture.BOTH) &&
            dialog == null &&
            !DeviceInfoCollector.isScreenReaderOn(app)

    override val debugCancelAfterMs: Long?
        get() = if (releaseType == SnitchReleaseType.DEBUG && isEnabled) debug?.cancelAfterMs?.takeIf { it > 0 } else null

    /** Main thread. Recomputes what should be running. */
    fun onStateChanged() {
        updateTimeline()
        val mode = videoMode
        frames.configure(
            maxBytes = if (mode == SnitchCaptureMode.SYSTEM) FrameStore.SYSTEM_MAX_BYTES else FrameStore.SNAPSHOT_MAX_BYTES,
            maxAgeMs = effective.videoMaxSeconds * 1000L,
        )
        touchLog.maxAgeMs = effective.videoMaxSeconds * 1000L
        val videoOn = mode != SnitchCaptureMode.OFF
        if (lastVideoOn && !videoOn) {
            frames.clear()
            touchLog.clear()
        }
        lastVideoOn = videoOn

        val activity = resumedActivity0
        if (snapshotCaptureAllowed && activity != null) {
            snapshot?.attach(activity)
            sentinel.onCaptureSessionStarted()
        } else {
            snapshot?.cancel()
        }

        if (mode == SnitchCaptureMode.SYSTEM && foreground && activity != null && !recordingPaused) {
            val controller = system ?: SystemCaptureController(main, frames, stats, this).also { system = it }
            if (controller.state == SystemCaptureController.State.IDLE) controller.start(activity)
        } else if (mode != SnitchCaptureMode.SYSTEM || recordingPaused) {
            system?.stop(app)
        }

        updateShake()
        if (!isEnabled) {
            prompt.dismiss()
            crashPill.dismiss()
            notice?.dismiss()
        }
    }

    /** What the timeline records and whether crashes are saved: nothing while Snitch is off (spec §11.3). */
    private fun updateTimeline() {
        val on = isEnabled
        val e = effective
        timeline.configure(active = on, console = e.captureConsole, network = e.captureNetwork, screens = e.trackScreens)
        crashHandler?.store = if (on && e.crashPrompt) crashStore else null
    }

    private fun applyRemote() {
        effective = EffectiveConfig.resolve(options, remote.current)
        governor = governorFor(effective)
        onStateChanged()
        scheduleCrashOffer()
    }

    private fun updateShake() {
        val wants = isEnabled && foreground && dialog == null &&
            (options.gesture == SnitchGesture.SHAKE || (options.gesture == SnitchGesture.BOTH && releaseType != SnitchReleaseType.DEBUG))
        if (wants) {
            val s = shake ?: ShakeDetector(app, main) { showReport(trigger = "shake", preselectType = null) }.also { shake = it }
            s.start()
        } else {
            shake?.stop()
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (!isSnitchActivity(activity)) wrap(activity)
    }

    override fun onActivityStarted(activity: Activity) {
        startedCount++
        if (startedCount == 1) onForeground()
        if (!isSnitchActivity(activity)) screenshotObserver.register(activity)
    }

    override fun onActivityResumed(activity: Activity) {
        if (isSnitchActivity(activity)) return
        if (startedCount <= 0) {
            // start() ran after this activity was started (e.g. called from onCreate).
            startedCount = 1
            onForeground()
        }
        wrap(activity)
        resumed = WeakReference(activity)
        if (timeline.screensOn && !SnitchState.appNamesScreens) timeline.screen(screenName(activity), "native")
        onStateChanged()
        scheduleCrashOffer()
    }

    /** Spec §11.6: the activity's title when it set its own, else its class name. */
    private fun screenName(activity: Activity): String {
        val title = activity.title?.toString()?.trim().orEmpty()
        val label = appLabel ?: loadAppLabel().also { appLabel = it }
        if (title.isNotEmpty() && title != label) return title
        return activity.javaClass.simpleName.ifEmpty { activity.javaClass.name }
    }

    private fun loadAppLabel(): String = try {
        app.applicationInfo.loadLabel(app.packageManager).toString().trim()
    } catch (_: Exception) {
        ""
    }

    /** Attaches to an activity that resumed before this runtime existed (or was missed). */
    fun adopt(activity: Activity) {
        if (isSnitchActivity(activity) || activity.isFinishing || resumedActivity0 === activity) return
        screenshotObserver.register(activity)
        onActivityResumed(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (resumedActivity0 === activity) {
            resumed = null
            snapshot?.detach(activity)
        }
        banner.onActivityPaused(activity)
        prompt.onActivityPaused(activity)
        crashPill.onActivityPaused(activity)
        notice?.let { if (it.belongsTo(activity)) it.dismiss() }
    }

    override fun onActivityStopped(activity: Activity) {
        screenshotObserver.unregister(activity)
        startedCount = maxOf(0, startedCount - 1)
        if (startedCount == 0) onBackground()
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) {
        val d = dialog
        if (d != null && d.ownerActivity === activity) {
            try {
                d.dismiss()
            } catch (_: Exception) {
            }
        }
    }

    private fun onForeground() {
        foreground = true
        timeline.app("foreground")
        main.removeCallbacks(healthySession)
        main.postDelayed(healthySession, CrashLoopSentinel.HEALTHY_SESSION_MS)
        io.execute { if (remote.isStale()) fetchConfig() }
        runUploads()
        onStateChanged()
    }

    private fun onBackground() {
        foreground = false
        timeline.app("background")
        main.removeCallbacks(healthySession)
        if (sentinelReady) sentinel.onCaptureSessionEnded()
        if (options.crashPrompt) io.execute { persistSessionLog() }
        onStateChanged()
    }

    private val healthySession = Runnable { io.execute { sentinel.onHealthySession() } }

    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        val pressure = level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND
        if (pressure) {
            frames.trimHalf()
            timeline.app("memory_warning")
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() {
        frames.clear()
        timeline.app("memory_warning")
    }

    private fun isSnitchActivity(activity: Activity) = activity.javaClass.name == SYSTEM_CAPTURE_ACTIVITY

    /** Wraps [activity]'s Window.Callback once; re-wraps if someone replaced ours. */
    private fun wrap(activity: Activity) {
        val window = activity.window ?: return
        val current = window.callback ?: return
        if (current is WindowCallbackWrapper && current.active) return
        wrappers[window]?.get()?.active = false
        val wrapper = WindowCallbackWrapper(activity, current, this, main)
        window.callback = wrapper
        wrappers[window] = WeakReference(wrapper)
    }

    // ── Touches & trigger ───────────────────────────────────────────────────

    override fun onTouchEvent(event: MotionEvent, density: Float, windowWidth: Int, windowHeight: Int) {
        val t = event.eventTime
        lastTouch = t
        if (lastVideoOn) {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> sampleDown(event, event.actionIndex, density, windowWidth, windowHeight)
                MotionEvent.ACTION_MOVE -> for (i in 0 until event.pointerCount) sample(event, i, density, TouchSample.Phase.MOVE)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> sample(event, event.actionIndex, density, TouchSample.Phase.UP)
                MotionEvent.ACTION_CANCEL -> for (i in 0 until event.pointerCount) sample(event, i, density, TouchSample.Phase.UP)
            }
        }
        snapshot?.onTouch(t)
    }

    private fun sample(e: MotionEvent, i: Int, density: Float, phase: TouchSample.Phase) {
        touchLog.add(TouchSample(e.eventTime, e.getPointerId(i), e.getX(i) / density, e.getY(i) / density, phase))
    }

    /** A finger going down, with its position as a fraction of the window for the timeline. */
    private fun sampleDown(e: MotionEvent, i: Int, density: Float, windowWidth: Int, windowHeight: Int) {
        val x = e.getX(i)
        val y = e.getY(i)
        touchLog.add(
            TouchSample(
                t = e.eventTime,
                id = e.getPointerId(i),
                x = x / density,
                y = y / density,
                phase = TouchSample.Phase.DOWN,
                fx = if (windowWidth > 0) x / windowWidth else -1f,
                fy = if (windowHeight > 0) y / windowHeight else -1f,
                fingers = e.pointerCount,
            ),
        )
    }

    override fun onGestureFired(activity: Activity, firstDownTime: Long, debugDismiss: Boolean) {
        beginReport(activity, "gesture", firstDownTime, null, debugDismiss)
    }

    /** Main thread. Opens the sheet for trigger api / screenshot / shake. */
    fun showReport(trigger: String, preselectType: String?) {
        if (!isEnabled) {
            SnitchLog.infoOnce("show-disabled", "show() ignored: Snitch is disabled")
            return
        }
        val activity = resumedActivity0
        if (activity == null) {
            SnitchLog.infoOnce("show-no-activity", "show() ignored: no resumed activity")
            return
        }
        beginReport(activity, trigger, SystemClock.uptimeMillis(), preselectType, debugDismiss = false)
    }

    private fun freeze(trigger: String, endT: Long, autoReport: Boolean, crash: PendingCrash? = null): ReportSession {
        val maxMs = effective.videoMaxSeconds * 1000L
        val clip = if (crash == null && videoMode != SnitchCaptureMode.OFF) frames.select(endT, maxMs) else emptyList()
        val touches = if (clip.isEmpty()) emptyList() else touchLog.between(endT - maxMs - 1000, endT)
        val monoNow = SystemClock.uptimeMillis()
        val wallOffset = System.currentTimeMillis() - monoNow
        val snap = if (crash == null && timeline.active) timeline.freeze() else null
        val downs = if (snap == null) emptyList() else touchLog.downsBetween(monoNow - TimelineLimits.MAX_AGE_MS, endT, TimelineLimits.TOUCHES)
        return ReportSession(trigger, endT, clip, touches, autoReport, snap, downs, wallOffset, crash)
    }

    private fun beginReport(
        activity: Activity,
        trigger: String,
        endT: Long,
        preselectType: String?,
        debugDismiss: Boolean,
        crash: PendingCrash? = null,
    ) {
        if (dialog != null || activity.isFinishing) return
        prompt.dismiss()
        crashPill.dismiss()
        notice?.dismiss()
        val session = freeze(trigger, endT, autoReport = false, crash = crash)
        val cfg = effective
        val model = ReportSheetModel(
            types = cfg.reportTypes,
            preselectType = preselectType,
            message = cfg.message,
            screenshotEnabled = cfg.screenshotEnabled,
            videoEnabled = crash == null && videoMode != SnitchCaptureMode.OFF,
            videoMaxSeconds = cfg.videoMaxSeconds,
            hasFrames = session.frames.isNotEmpty(),
            bufferedMs = session.bufferedMs,
            email = prefs.getString(K_EMAIL, null) ?: SnitchState.user?.email,
            recordingPaused = recordingPaused,
            sdkVersion = SnitchVersion.SDK_VERSION,
            screenshotChecked = crash == null,
            implicitAttachment = crash != null,
        )
        var sent = false
        lateinit var sheet: ReportDialog
        sheet = ReportDialog(
            activity,
            model,
            object : ReportSheetListener {
                override fun onSend(draft: ReportDraft) {
                    sent = true
                    submit(session, draft, bannerActivity = WeakReference(activity))
                }

                override fun onPauseRecordingChanged(paused: Boolean) {
                    recordingPaused = paused
                }

                override fun onScreenshotEdited(shot: Screenshot) {
                    session.replaceScreenshot(shot)
                }

                override fun onClosed() {
                    if (dialog === sheet) dialog = null
                    // The tester saw the crash follow-up and closed it: that counts as dismissing it.
                    if (crash != null && !sent) discardCrashes()
                    onStateChanged()
                    scheduleCrashOffer()
                }
            },
        )
        sheet.setOwnerActivity(activity)
        dialog = sheet
        // 1. Screenshot first (the dialog is another window, so it is never in it).
        if (cfg.screenshotEnabled) {
            screenshots.take(activity, cfg.maskTextInputs, app.dp(88f)) { shot ->
                session.completeScreenshot(shot)
                sheet.setScreenshot(shot)
            }
        } else {
            session.completeScreenshot(null)
        }
        onStateChanged() // pauses capture while the sheet is up
        // 2. The caller sends the cancel; 3. the sheet appears on the next loop turn.
        main.post {
            if (dialog !== sheet || activity.isFinishing || activity.isDestroyed) {
                if (dialog === sheet) dialog = null
                onStateChanged()
                return@post
            }
            activity.window?.decorView?.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            try {
                sheet.show()
            } catch (e: Exception) {
                SnitchLog.warn("cannot show the report sheet", e)
                dialog = null
                onStateChanged()
                return@post
            }
            if (debugDismiss) main.post { sheet.dismiss() }
        }
    }

    override fun onSystemCaptureEnded(declined: Boolean) {
        systemFallback = true
        SnitchLog.info(if (declined) "screen recording declined; using snapshot capture" else "system capture stopped; using snapshot capture")
        onStateChanged()
    }

    private fun onSystemScreenshot(activity: Activity) {
        if (!isEnabled || !effective.screenshotPrompt || dialog != null) return
        prompt.show(activity, Strings.REPORT_THIS_SCREEN, SCREENSHOT_PILL_MS, onTap = { showReport(trigger = "screenshot", preselectType = null) })
    }

    // ── Crash follow-up ─────────────────────────────────────────────────────

    /**
     * I/O thread, at launch. Collects what the previous process left behind: its
     * pid and session log, the exits the system recorded since the last check
     * (API 30+), and logcat lines of that pid still in the buffer, which become
     * the crash's timeline. Then offers the newest pending crash.
     */
    private fun prepareCrashFollowUp() {
        try {
            val myPid = Process.myPid()
            val previousPid = prefs.getInt(K_SESSION_PID, 0)
            prefs.edit().putInt(K_SESSION_PID, myPid).apply()
            val previousLog = crashStore.takeSessionLog()
            val exits = ExitReasons.newerThan(app, prefs.getLong(K_EXIT_HANDLED_AT, 0L))
            for (e in exits) crashStore.add(e.kind, e.time, e.pid, e.text)
            if (exits.isNotEmpty()) prefs.edit().putLong(K_EXIT_HANDLED_AT, exits.maxOf { it.time }).apply()
            val pending = crashStore.pending(System.currentTimeMillis())
            if (previousPid != 0 && previousPid != myPid) {
                pending.firstOrNull { it.pid == previousPid && !it.timelineFile.exists() }?.let { crash ->
                    val lines = LogcatReader.read(LogcatReader.command(previousPid))
                    val logcat = LogcatParser.events(lines, crash.time - TimelineLimits.MAX_AGE_MS, crash.time + CRASH_LOGCAT_AFTER_MS)
                    crashStore.attachTimeline(crash, previousLog + logcat)
                }
            }
            val newest = pending.firstOrNull()
            main.post {
                pendingCrash = newest
                crashReady = true
                scheduleCrashOffer()
            }
        } catch (e: Exception) {
            SnitchLog.warn("crash follow-up: could not check the previous session", e)
        }
    }

    /** I/O thread. Saves the timeline's newest log lines for the next launch (spec §11.8). */
    private fun persistSessionLog() {
        if (!isEnabled || !effective.crashPrompt) return
        val version = timeline.logVersion
        if (version == persistedLogVersion) return
        persistedLogVersion = version
        try {
            crashStore.writeSessionLog(timeline.recentLogs(CrashStore.SESSION_LOG_LINES).map { TimelineNdjson.eventLine(it) })
        } catch (e: Exception) {
            SnitchLog.warnOnce("session-log", "crash follow-up: cannot save the session log", e)
        }
    }

    private val offerCrash = Runnable { maybeOfferCrash() }

    private fun scheduleCrashOffer() {
        main.removeCallbacks(offerCrash)
        main.postDelayed(offerCrash, CRASH_OFFER_DELAY_MS)
    }

    /** Main thread. Shows the crash pill once per launch, when the server takes `crash` reports. */
    private fun maybeOfferCrash() {
        if (crashOffered || !crashReady) return
        val crash = pendingCrash ?: return
        val cfg = effective
        if (!isEnabled || !cfg.crashPrompt || SdkConfig.FEATURE_TRIGGER_CRASH !in cfg.features) return
        // Without an activity, or under the sheet, the next resume or close tries again.
        val activity = resumedActivity0 ?: return
        if (dialog != null || !foreground) return
        val shown = crashPill.show(
            activity,
            Strings.CRASH_PROMPT,
            CRASH_PILL_MS,
            onTap = { showCrashReport(crash) },
            onDismiss = { discardCrashes() },
        )
        if (shown) {
            crashOffered = true
        } else if (++crashOfferAttempts < CRASH_OFFER_ATTEMPTS) {
            scheduleCrashOffer() // the window wasn't attached yet
        }
    }

    private fun showCrashReport(crash: PendingCrash) {
        if (!isEnabled) return
        val activity = resumedActivity0 ?: return
        beginReport(activity, "crash", SystemClock.uptimeMillis(), CRASH_REPORT_TYPE, debugDismiss = false, crash = crash)
    }

    /** Sent or dismissed: the pending crash files go. */
    private fun discardCrashes() {
        pendingCrash = null
        io.execute { crashStore.deleteAll() }
    }

    // ── Submit ──────────────────────────────────────────────────────────────

    /** Main thread. Writes the report to the outbox on the I/O thread, then uploads. */
    private fun submit(session: ReportSession, draft: ReportDraft, bannerActivity: WeakReference<Activity>?) {
        val showBanner = !session.autoReport
        if (showBanner) bannerActivity?.get()?.let { banner.show(it, Strings.SENDING, 0) }
        pendingSubmissions.incrementAndGet()
        val modeAtSend = videoMode
        io.execute {
            var id: String? = null
            try {
                if (!session.autoReport) {
                    prefs.edit().apply { if (draft.email == null) remove(K_EMAIL) else putString(K_EMAIL, draft.email) }.apply()
                }
                id = writeReport(session, draft, modeAtSend)
                if (showBanner) sessionReports.add(id)
            } catch (e: Throwable) {
                SnitchLog.warn("could not save the report", e)
                if (showBanner) main.post { resumedActivity0?.let { banner.show(it, Strings.REJECTED, BANNER_MS) } }
            } finally {
                pendingSubmissions.decrementAndGet()
                if (session.autoReport) autoReportPending.set(false)
            }
            if (id != null) runUploads()
        }
    }

    /** I/O thread. Attachments first, report.json last (atomically). Returns the clientReportId. */
    private fun writeReport(session: ReportSession, draft: ReportDraft, mode: SnitchCaptureMode): String {
        val id = UUID.randomUUID().toString()
        val dir = outbox.newReportDir(id)
        val attachments = ArrayList<AttachmentDecl>()
        val crash = session.crash
        try {
            val shot = if (draft.includeScreenshot) session.awaitScreenshot(SCREENSHOT_WAIT_MS) else null
            if (shot != null) {
                val f = File(dir, AttachmentDecl.fileNameFor(AttachmentDecl.SCREENSHOT, "image/jpeg"))
                f.writeBytes(shot.jpeg)
                attachments += AttachmentDecl(AttachmentDecl.SCREENSHOT, "image/jpeg", f.length(), Sha256.hex(shot.jpeg), shot.width, shot.height)
            }
            var videoLost: Boolean? = null
            var composeMs: Double? = null
            var video: VideoResult? = null
            if (draft.videoSeconds > 0 && session.frames.isNotEmpty()) {
                val durationMs = draft.videoSeconds * 1000L
                val start = session.endT - durationMs
                val clip = FrameRing.selectFrom(session.frames, session.endT, durationMs)
                val touches = session.touches.filter { it.t > start - 200 && it.t <= session.endT }
                val tmp = File(app.cacheDir, "snitch/$id.mp4")
                tmp.parentFile?.mkdirs()
                video = VideoComposer.compose(clip, touches, start, session.endT, tmp)
                if (video != null) {
                    val f = File(dir, AttachmentDecl.fileNameFor(AttachmentDecl.VIDEO, "video/mp4"))
                    if (!tmp.renameTo(f)) {
                        tmp.copyTo(f, overwrite = true)
                        tmp.delete()
                    }
                    attachments += AttachmentDecl(AttachmentDecl.VIDEO, "video/mp4", f.length(), Sha256.hex(f), video.width, video.height, video.durationMs)
                    composeMs = video.composeMs
                    stats.lastComposeMs = composeMs
                } else {
                    tmp.delete()
                    videoLost = true
                }
            }
            if (crash == null) {
                // A crash follow-up leaves this session's logs out: they say nothing about the crash.
                val provided = try {
                    SnitchState.logProvider?.invoke()
                } catch (e: Throwable) {
                    SnitchLog.warn("log provider threw", e)
                    null
                }
                LogRing.compose(SnitchState.logs.snapshot(), provided, LOG_LINES, LOG_BYTES)?.let { text ->
                    val f = File(dir, AttachmentDecl.fileNameFor(AttachmentDecl.LOGS, "text/plain"))
                    f.writeText(text)
                    attachments += AttachmentDecl(AttachmentDecl.LOGS, "text/plain", f.length(), Sha256.hex(f))
                }
            } else {
                crashStore.readText(crash)?.takeIf { it.isNotEmpty() }?.let { text ->
                    val bytes = text.toByteArray(Charsets.UTF_8)
                    val f = File(dir, AttachmentDecl.fileNameFor(AttachmentDecl.CRASH, "text/plain"))
                    f.writeBytes(bytes)
                    attachments += AttachmentDecl(AttachmentDecl.CRASH, "text/plain", bytes.size.toLong(), Sha256.hex(bytes))
                }
            }
            timelineFor(session, video)?.let { encoded ->
                val bytes = encoded.text.toByteArray(Charsets.UTF_8)
                val f = File(dir, AttachmentDecl.fileNameFor(AttachmentDecl.TIMELINE, TIMELINE_CONTENT_TYPE))
                f.writeBytes(bytes)
                attachments += AttachmentDecl(AttachmentDecl.TIMELINE, TIMELINE_CONTENT_TYPE, bytes.size.toLong(), Sha256.hex(bytes))
            }

            val user = SnitchState.user
            val email = draft.email?.takeIf { ReportBuilder.isValidEmail(it) } ?: user?.email
            val reporter = if (email == null && user?.name == null && user?.id == null) null else ReporterInfo(email, user?.name, user?.id)
            val wrapper = SnitchState.wrapper
            val now = SystemClock.uptimeMillis()
            val payload = ReportPayload(
                clientReportId = id,
                type = draft.type,
                description = draft.description,
                reporter = reporter,
                reportedAtMs = System.currentTimeMillis(),
                trigger = session.trigger,
                app = appInfo,
                device = deviceInfo.device(),
                sdk = SdkInfo(SnitchVersion.SDK_NAME, SnitchVersion.SDK_VERSION, wrapper?.first, wrapper?.second),
                custom = SnitchState.metadataSnapshot().takeIf { it.isNotEmpty() },
                stats = StatsSnapshot(
                    captureMode = mode.wireValue,
                    captureMsP50 = stats.percentile(0.5),
                    captureMsP95 = stats.percentile(0.95),
                    effectiveFps = stats.effectiveFps(now),
                    ringBytes = frames.totalBytes(),
                    bufferedSeconds = session.bufferedMs / 1000.0,
                    composeMs = composeMs,
                    framesSkipped = stats.framesSkipped,
                    uptimeSec = (SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()) / 1000.0,
                    crashLoopDowngrades = sentinel.downgrades,
                    videoLost = videoLost,
                ),
                attachments = attachments,
                screen = session.timeline?.screen,
                installId = installId,
            )
            outbox.commit(dir, ReportBuilder.toJson(payload).toString())
            if (crash != null) discardCrashes()
            return id
        } catch (e: Throwable) {
            outbox.delete(dir)
            throw e
        }
    }

    /**
     * I/O thread. The report's `timeline`: the frozen timeline plus this process's
     * logcat (when console capture was on), or the crashed session's log for a
     * crash follow-up.
     */
    private fun timelineFor(session: ReportSession, video: VideoResult?): TimelineNdjson.Encoded? {
        val crash = session.crash
        if (crash != null) return ReportTimeline.encodePast(crashStore.timelineEvents(crash))
        val snap = session.timeline ?: return null
        val logcat = if (snap.console) {
            LogcatParser.events(LogcatReader.read(LogcatReader.command(Process.myPid())), snap.frozenAt - TimelineLimits.MAX_AGE_MS, snap.frozenAt)
        } else {
            emptyList()
        }
        val videoEndWall = if (video != null) session.endT + session.wallOffset else null
        return ReportTimeline.encode(snap, session.touchDowns, session.wallOffset, logcat, videoEndWall, video?.durationMs)
    }

    // ── Upload ──────────────────────────────────────────────────────────────

    private fun endpoint(): Endpoint = endpointFor(baseUrl, key)

    /** Any thread. Runs the outbox once on the I/O thread (coalesced). */
    private fun runUploads() {
        if (!uploadQueued.compareAndSet(false, true)) return
        io.execute {
            uploadQueued.set(false)
            uploadRunning = true
            val run = try {
                uploader.runOnce()
            } catch (e: Throwable) {
                SnitchLog.warn("upload run failed", e)
                null
            } finally {
                uploadRunning = false
            }
            run?.outcomes?.forEach(::onUploadOutcome)
            val next = run?.nextAttemptAt
            uploadTimer?.cancel(false)
            uploadTimer = if (next != null) {
                val delay = maxOf(1_000L, next - System.currentTimeMillis())
                io.schedule({ runUploads() }, delay, TimeUnit.MILLISECONDS)
            } else {
                null
            }
        }
    }

    private fun onUploadOutcome(outcome: UploadOutcome) {
        val id = outcome.clientReportId
        if (id !in sessionReports) return
        val message = when (outcome) {
            is UploadOutcome.Sent -> {
                sessionReports.remove(id)
                Strings.sent(outcome.ticket)
            }
            is UploadOutcome.Deferred -> if (deferredShown.add(id)) Strings.SAVED_OFFLINE else null
            is UploadOutcome.Dropped -> {
                sessionReports.remove(id)
                Strings.REJECTED
            }
        } ?: return
        main.post { resumedActivity0?.let { banner.show(it, message, BANNER_MS) } }
    }

    /** I/O thread. Also the install's check-in (spec §11.1). */
    private fun fetchConfig() {
        val health = if (sentinel.healthPending) "crashloop" else "ok"
        val query = checkInQuery(appInfo, releaseType, installId, signals, active = true, health = health)
        when (remote.fetch(endpoint(), query)) {
            is RemoteConfigClient.FetchResult.Updated -> {
                sentinel.onHealthReported()
                main.post { applyRemote() }
            }
            RemoteConfigClient.FetchResult.NotModified -> sentinel.onHealthReported()
            is RemoteConfigClient.FetchResult.Failed -> Unit
        }
    }

    // ── Tester notice ───────────────────────────────────────────────────────

    private val noticeCheck = object : Runnable {
        override fun run() {
            if (noticeHandled || !options.showTesterNotice) return
            val activity = resumedActivity0
            val idle = lastTouch?.let { SystemClock.uptimeMillis() - it > NOTICE_IDLE_MS } ?: true
            if (!isEnabled || !foreground || activity == null || dialog != null || !idle) {
                main.postDelayed(this, NOTICE_RETRY_MS)
                return
            }
            val hint = when (options.gesture) {
                SnitchGesture.THREE_FINGER_HOLD -> Strings.HINT_THREE_FINGERS
                SnitchGesture.SHAKE -> Strings.HINT_SHAKE
                SnitchGesture.BOTH -> if (releaseType == SnitchReleaseType.DEBUG) Strings.HINT_THREE_FINGERS else Strings.HINT_BOTH
                SnitchGesture.NONE -> null
            }
            val seconds = if (videoMode != SnitchCaptureMode.OFF) effective.videoMaxSeconds else null
            val n = TesterNotice(activity, Strings.testerNotice(hint, seconds)) { notice = null }
            if (n.show()) {
                notice = n
                noticeHandled = true
                io.execute { prefs.edit().putBoolean(K_NOTICE_SHOWN, true).apply() }
            } else {
                main.postDelayed(this, NOTICE_RETRY_MS)
            }
        }
    }

    // ── Debug hooks ─────────────────────────────────────────────────────────

    /** Main thread. Applies Snitch.debugOverrides() after start. */
    fun applyDebugOverrides(o: SnitchDebugOverrides) {
        applyDebug(o, atStart = false)
    }

    private fun applyDebug(o: SnitchDebugOverrides, atStart: Boolean) {
        if (releaseType != SnitchReleaseType.DEBUG) {
            SnitchLog.warnOnce("debug-ignored", "debug overrides ignored: release type is ${releaseType.wireValue}")
            return
        }
        debug = if (atStart) o else DebugHooks.merge(debug, o)
        if (!atStart && (o.serverUrl != null || o.ingestKey != null)) {
            val url = o.serverUrl?.trim()?.trimEnd('/') ?: baseUrl
            val k = o.ingestKey?.trim() ?: key
            if (isValidServerUrl(url) && isValidIngestKey(k)) {
                baseUrl = url
                key = k
                SnitchState.serverOrigin = UrlSanitizer.origin(url)
                io.execute {
                    remote.loadCache(url)?.let { main.post { applyRemote() } }
                    fetchConfig()
                }
                runUploads()
            } else {
                SnitchLog.warn("debug overrides: invalid server URL or ingest key; keeping $baseUrl")
            }
        }
        o.autoReportAfterSeconds?.takeIf { it >= 0 }?.let { scheduleAutoReport(it) }
        if (o.showOnLaunch) {
            main.postDelayed({ showReport(trigger = "api", preselectType = null) }, DebugHooks.SHOW_ON_LAUNCH_DELAY_MS)
        }
    }

    private fun scheduleAutoReport(seconds: Int) {
        autoReportPending.set(true)
        main.postDelayed({ runAutoReport(attempt = 0) }, seconds * 1000L)
    }

    private fun runAutoReport(attempt: Int) {
        val activity = resumedActivity0
        if (activity == null && attempt < AUTOREPORT_RETRIES) {
            main.postDelayed({ runAutoReport(attempt + 1) }, 1000)
            return
        }
        val session = freeze("api", SystemClock.uptimeMillis(), autoReport = true)
        val maxSeconds = if (session.frames.isEmpty()) 0 else (session.bufferedMs / 1000).toInt().coerceIn(1, effective.videoMaxSeconds)
        val draft = ReportDraft(
            type = DebugHooks.AUTOREPORT_TYPE,
            description = DebugHooks.AUTOREPORT_DESCRIPTION,
            email = null,
            includeScreenshot = true,
            videoSeconds = minOf(DebugHooks.AUTOREPORT_MAX_VIDEO_SECONDS, maxSeconds),
        )
        if (activity != null && effective.screenshotEnabled) {
            screenshots.take(activity, effective.maskTextInputs, app.dp(88f)) { shot ->
                session.completeScreenshot(shot)
                submit(session, draft, bannerActivity = null)
            }
        } else {
            session.completeScreenshot(null)
            submit(session, draft, bannerActivity = null)
        }
    }

    /** Snitch.debugAwaitIdle: no auto-report pending, nothing being written, outbox empty. */
    fun isIdleForTests(): Boolean =
        !autoReportPending.get() && pendingSubmissions.get() == 0 && !uploadRunning && !uploadQueued.get() && outbox.isEmpty()

    // ── Helpers ─────────────────────────────────────────────────────────────

    private class PrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
        override fun getString(key: String): String? = prefs.getString(key, null)

        override fun putString(key: String, value: String?) {
            prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
        }
    }

    companion object {
        private const val PREFS = "snitch"
        private const val K_EMAIL = "email"
        private const val K_NOTICE_SHOWN = "noticeShown"
        private const val K_SESSION_PID = "sessionPid"
        private const val K_EXIT_HANDLED_AT = "exitHandledAt"
        private const val SYSTEM_CAPTURE_ACTIVITY = "io.github.monjar.snitch.system.SystemCaptureActivity"
        private const val NOTICE_DELAY_MS = 5_000L
        private const val NOTICE_RETRY_MS = 2_000L
        private const val NOTICE_IDLE_MS = 2_000L
        private const val BANNER_MS = 2_500L
        private const val SCREENSHOT_PILL_MS = 4_000L
        private const val CRASH_PILL_MS = 10_000L
        private const val CRASH_OFFER_DELAY_MS = 600L
        private const val CRASH_OFFER_ATTEMPTS = 10
        private const val CRASH_REPORT_TYPE = "bug"
        private const val CRASH_LOGCAT_AFTER_MS = 5_000L
        private const val SESSION_LOG_EVERY_MS = 30_000L
        private const val LOG_LINES = 200
        private const val LOG_BYTES = 256 * 1024
        private const val AUTOREPORT_RETRIES = 30
        private const val SCREENSHOT_WAIT_MS = 3_000L
        private const val GOVERNOR_ACTIVE_WINDOW_MS = 1500L
        private const val TIMELINE_CONTENT_TYPE = "application/x-ndjson"

        /** The opt-in inactive check-in goes out at most once per process. */
        private val inactiveCheckInSent = AtomicBoolean(false)

        /** `snitch_pk_` + 26 Crockford base32 characters (contract INGEST_KEY_PATTERN). */
        private val INGEST_KEY = Regex("^snitch_pk_[0-9A-HJKMNP-TV-Z]{26}$")

        fun isValidIngestKey(key: String?): Boolean = key != null && INGEST_KEY.matches(key.trim())

        fun isValidServerUrl(url: String?): Boolean {
            if (url.isNullOrBlank()) return false
            return try {
                val u = URL(url.trim())
                (u.protocol == "http" || u.protocol == "https") && !u.host.isNullOrEmpty()
            } catch (_: Exception) {
                false
            }
        }

        private fun governorFor(c: EffectiveConfig) = GovernorConfig(
            idleFps = c.idleFps,
            activeFps = c.activeFps,
            budgetPct = c.budgetPct,
            activeWindowMs = GOVERNOR_ACTIVE_WINDOW_MS,
        )

        private fun endpointFor(baseUrl: String, key: String): Endpoint {
            val wrapper = SnitchState.wrapper
            val sdkHeader = if (wrapper?.first == "react-native") "rn-android/${wrapper.second}" else "android/${SnitchVersion.SDK_VERSION}"
            return Endpoint(baseUrl, key, sdkHeader, "Snitch/${SnitchVersion.SDK_VERSION} (android)")
        }

        /** The config query with the check-in fields (contract SdkConfigQuery). */
        private fun checkInQuery(
            app: AppInfo,
            releaseType: SnitchReleaseType,
            installId: String,
            signals: String,
            active: Boolean,
            health: String?,
        ): Map<String, String> {
            val q = linkedMapOf(
                "platform" to "android",
                "releaseType" to releaseType.wireValue,
                "appVersion" to app.version.take(64),
                "build" to app.build.take(64),
                "os" to (Build.VERSION.RELEASE ?: "").take(32),
            )
            if (health != null) q["health"] = health
            q["installId"] = installId
            q["appId"] = app.id.take(255)
            q["sdkVersion"] = SnitchVersion.SDK_VERSION
            SnitchState.wrapper?.first?.takeIf { it.isNotBlank() }?.let { q["wrapper"] = it.take(32) }
            Build.MODEL?.takeIf { it.isNotBlank() }?.let { q["model"] = it.take(64) }
            q["signals"] = signals.take(300)
            q["active"] = if (active) "1" else "0"
            return q
        }

        /**
         * CheckInWhenInactive (spec §11.1): the release type is `unknown`, so the SDK
         * stays inert — except for this one config fetch with active=0, whose answer
         * is ignored. Only when the app opted in; once per process.
         */
        private fun sendInactiveCheckIn(app: Application, config: StartConfig, signals: String) {
            val url = config.serverUrl?.trim()?.trimEnd('/')
            val k = config.ingestKey?.trim()
            if (url == null || k == null || !isValidServerUrl(url) || !isValidIngestKey(k)) return
            if (!inactiveCheckInSent.compareAndSet(false, true)) return
            Thread({
                try {
                    val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    val info = DeviceInfoCollector(app, null, null).app(SnitchReleaseType.UNKNOWN.wireValue)
                    val query = checkInQuery(info, SnitchReleaseType.UNKNOWN, InstallId.getOrCreate(PrefsStore(prefs)), signals, active = false, health = null)
                    RemoteConfigClient.ping(endpointFor(url, k), query, SnitchLog)
                } catch (e: Exception) {
                    SnitchLog.debug("inactive check-in failed: ${e.javaClass.simpleName}")
                }
            }, "snitch-checkin").apply { isDaemon = true }.start()
        }

        fun create(context: Context, config: StartConfig): StartResult {
            val app = (context.applicationContext ?: context) as? Application
            if (app == null) {
                SnitchLog.warn("start() needs an Application context; Snitch stays inert")
                return StartResult(SnitchReleaseType.UNKNOWN, null)
            }
            val detected = ReleaseTypeDetector.signals(app, config.releaseTypeOverride)
            val releaseType = ReleaseTypeDetector.classify(detected)
            val signals = ReleaseTypeClassifier.signalsSummary(detected)
            if (releaseType !in config.options.enabledReleaseTypes) {
                SnitchLog.info("release type ${releaseType.wireValue} is not enabled; Snitch stays off")
                if (releaseType == SnitchReleaseType.UNKNOWN && config.options.checkInWhenInactive) sendInactiveCheckIn(app, config, signals)
                return StartResult(releaseType, null)
            }
            val debug = if (releaseType == SnitchReleaseType.DEBUG) DebugHooks.merge(config.debug, SnitchState.debugOverrides) else null
            val serverUrl = debug?.serverUrl ?: config.serverUrl
            val ingestKey = debug?.ingestKey ?: config.ingestKey
            if (!isValidServerUrl(serverUrl) || !isValidIngestKey(ingestKey)) {
                SnitchLog.warn("SERVER_URL or INGEST_KEY is missing or malformed; Snitch stays inert")
                return StartResult(releaseType, null)
            }
            val runtime = SnitchRuntime(app, config, releaseType, serverUrl!!, ingestKey!!, debug, signals)
            if (Looper.myLooper() == Looper.getMainLooper()) {
                runtime.start()
            } else {
                Handler(Looper.getMainLooper()).post { runtime.start() }
            }
            return StartResult(releaseType, runtime)
        }
    }
}
