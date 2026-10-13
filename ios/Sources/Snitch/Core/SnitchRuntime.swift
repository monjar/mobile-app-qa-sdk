// The SDK's engine: one main-thread object that owns every component and keeps
// them in step with the effective configuration and the app's state.
//
// start → detect release type → (only if enabled) validate config, apply debug
// hooks, activate. Before activation nothing is installed and nothing touches
// the network, so a store build pays for one Info.plist read and one file probe.
//
// `reconcile()` is the single place that decides what runs: triggers, prompt and
// capture follow (activated ∧ app-enabled ∧ remote-enabled), pause while the
// sheet is visible or the app is not active, and capture mode/renderer follow
// the merged config. Every state change ends in a call to it.
//
// 0.3 (spec §11): the timeline recorder's switches and the network gate follow
// the same reconcile; the timeline is frozen with the frame ring when the sheet
// opens; config fetches carry the check-in fields; and after an unexpected exit
// the crash follow-up offers a report once per launch. Each of those lives in its
// own type (Timeline/, Network/, Crash/, CheckIn); this file only wires them.

import UIKit

struct PublicState: Equatable {
    var isEnabled: Bool
    var releaseType: SnitchReleaseType
    /// On, with the CaptureConsole option (the RN module installs its console hook on this).
    var consoleCapture: Bool
}

final class SnitchRuntime: WindowTouchRecognizerHost {
    static let shared = SnitchRuntime()

    private let publicStateBox = Locked(PublicState(isEnabled: false, releaseType: .unknown, consoleCapture: false))
    var publicState: PublicState {
        publicStateBox.get()
    }

    // MARK: State (main thread)

    private var started = false
    private var activated = false
    private var staticConfig: StaticConfig?
    private var releaseType: SnitchReleaseType = .unknown
    private var detection: ReleaseDetection?
    private var installId: String?
    private var inactiveCheckInSent = false
    private var crashOffered = false
    private var sessionLogTimer: Timer?
    private var hooks = DebugHooks.inactive
    private var appEnabled = true
    private var testerPausedRecording = false
    private var appActive = false
    private var systemFallback = false
    private var lastTouchAt: Double?
    private var effective = ConfigMerger.effective(options: SnitchOptions(), remote: nil)
    private var pendingSheet: PendingSheet?
    private var sessionReports = Set<String>()
    private var offlineNotified = Set<String>()
    private var uploadTask: BackgroundTask?
    private var noticeTimer: Timer?
    private var observers: [NSObjectProtocol] = []

    // MARK: Components

    private var client: APIClient?
    private var remote: RemoteConfigStore?
    private var outbox: Outbox?
    private var uploader: Uploader?
    private var sentinel: CrashLoopSentinel?
    private var frameCapturer: FrameCapturer?
    private var systemCapturer: SystemCapturer?
    private var windowTracker: WindowTracker?
    private var crashStore: CrashStore?
    private var crashSubscriber: CrashDiagnosticsSubscriber?
    private let recorder = TimelineRecorder.shared
    private lazy var screenTracker = ScreenTracker(recorder: recorder)
    private let network = NetworkMonitor()
    private let store = FrameStore()
    private let stats = CaptureStats()
    private let touchLog = TouchLog(maxAgeMs: 30_000)
    private let shake = ShakeDetector()
    private let screenshotObserver = ScreenshotObserver()
    private let overlay = OverlayController()
    private let reportQueue = DispatchQueue(label: "io.github.monjar.snitch.report", qos: .userInitiated)
    private let fileQueue = DispatchQueue(label: "io.github.monjar.snitch.files", qos: .utility)
    private let defaults = UserDefaults.standard

    private struct PendingSheet {
        var trigger: String
        var preselectedType: String?
        var frozen: FrozenCapture
        var screenshot: Screenshot?
        var debugDismiss: Bool
        /// Frozen with the capture; the crash follow-up carries the previous session's log instead.
        var timeline: TimelineSnapshot?
        /// Set for the crash follow-up (trigger `crash`).
        var crash: PendingCrash? = nil
    }

    private var isOn: Bool {
        activated && appEnabled && effective.enabled
    }

    // MARK: - Start

    func start(explicit: StaticConfig.Explicit?) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !started else {
            SDKLog.once("start.twice", level: .info, "Snitch.start() was called more than once; ignoring the extra call")
            return
        }
        started = true
        var config = StaticConfig.fromInfoPlist()
        if let explicit = explicit { config = config.overlaid(with: explicit) }
        staticConfig = config
        guard config.enabled else {
            SDKLog.info("Snitch is turned off (Enabled = false)")
            return
        }
        // One run-loop turn later: `start()` may run from +load or early in
        // didFinishLaunching, before UIApplication or any scene is ready.
        DispatchQueue.main.async { [weak self] in
            ReleaseTypeDetector.detect { detection in self?.releaseTypeDetected(detection) }
        }
    }

    private func releaseTypeDetected(_ detection: ReleaseDetection) {
        let type = detection.type
        self.detection = detection
        releaseType = type
        publishState()
        guard !activated, let config = staticConfig else { return }
        guard type != .unknown else {
            SDKLog.once("releaseType.unknown", level: .info, "Snitch is inactive: the release type could not be determined")
            if detection.isFinal { sendInactiveCheckIn(config) }
            return
        }
        guard config.options.enabledReleaseTypes.contains(type) else {
            SDKLog.info("Snitch is inactive: release type \(type.rawValue) is not in EnabledReleaseTypes")
            return
        }
        hooks = DebugHooks.read(releaseType: type)
        let url = StaticConfig.normalizedServerURL(hooks.serverURL ?? config.serverURL)
        let key = hooks.ingestKey ?? config.ingestKey
        guard let serverURL = url, let ingestKey = key, StaticConfig.isValidIngestKey(ingestKey) else {
            SDKLog.warn("Snitch is inactive: ServerURL or IngestKey is missing or malformed")
            return
        }
        activate(serverURL: serverURL, ingestKey: ingestKey, options: config.options)
    }

    private func activate(serverURL: URL, ingestKey: String, options: SnitchOptions) {
        activated = true
        installId = InstallId.current(defaults: defaults)
        let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
        let sentinel = CrashLoopSentinel(build: build)
        sentinel.checkAtLaunch()
        self.sentinel = sentinel

        let client = APIClient(baseURL: serverURL, ingestKey: ingestKey) {
            APIClient.sdkHeaderValue(wrapper: UserContext.shared.wrapper?.name)
        }
        self.client = client
        let remote = RemoteConfigStore()
        self.remote = remote
        if let outbox = Outbox.makeDefault() {
            self.outbox = outbox
            let uploader = Uploader(outbox: outbox, client: client)
            uploader.chunkBytesCap = hooks.chunkBytes
            uploader.onOutcome = { [weak self] id, outcome in self?.uploadOutcome(id, outcome) }
            uploader.onDrainFinished = { [weak self] in
                self?.uploadTask?.end()
                self?.uploadTask = nil
            }
            self.uploader = uploader
        }
        network.onBecameSatisfied = { [weak self] in self?.runUploads() }
        network.start()

        windowTracker = WindowTracker { [unowned self] in WindowTouchRecognizer(host: self) }
        overlay.onSheetVisibilityChange = { [weak self] visible in
            self?.reconcile()
            if !visible { self?.offerCrashReportIfPending() }
        }
        shake.onShake = { [weak self] in self?.openSheet(trigger: "shake", type: nil) }
        screenshotObserver.onScreenshot = { [weak self] in self?.systemScreenshotTaken() }
        installObservers()

        // Network capture (spec §11.5): the gate in canInit keeps it inert until reconcile opens it.
        SnitchURLProtocol.gate.mutate { gate in
            gate.serverHost = serverURL.host?.lowercased()
            gate.serverPort = SnitchURLProtocol.effectivePort(serverURL)
        }
        if options.captureNetwork { URLProtocol.registerClass(SnitchURLProtocol.self) }
        // Crash follow-up (spec §11.8): last session's log becomes the previous one, then listen.
        if options.crashPrompt, let crashStore = CrashStore.makeDefault() {
            crashStore.promoteSessionLog()
            self.crashStore = crashStore
            let subscriber = CrashDiagnosticsSubscriber(store: crashStore)
            subscriber.onSaved = { [weak self] in self?.offerCrashReportIfPending() }
            subscriber.start()
            crashSubscriber = subscriber
        }

        appActive = UIApplication.shared.applicationState == .active
        effective = ConfigMerger.effective(options: options, remote: remote.config, rendererDowngrade: sentinel.downgradeLevel)
        reconcile()
        recorder.appEvent(.launch)
        fetchRemoteConfig(force: true)
        runUploads()
        scheduleTesterNotice()
        scheduleDebugHooks()
        DispatchQueue.main.async { [weak self] in
            self?.screenTracker.infer()
            self?.offerCrashReportIfPending()
        }
        SDKLog.info("Snitch \(SnitchVersion.current) active (release type \(releaseType.rawValue), capture \(effective.captureMode.rawValue))")
        NotificationCenter.default.post(name: Notification.Name(SnitchBridge.didActivateNotification), object: nil)
    }

    /// CheckInWhenInactive (spec §11.1): when the release type stayed `unknown`, one config
    /// fetch per launch with active=0 so the build shows up on the Devices page; the answer
    /// is ignored. The only request an inert SDK ever makes, and only when the app opted in.
    private func sendInactiveCheckIn(_ config: StaticConfig) {
        guard config.options.checkInWhenInactive, !inactiveCheckInSent,
              let serverURL = StaticConfig.normalizedServerURL(config.serverURL),
              let ingestKey = config.ingestKey, StaticConfig.isValidIngestKey(ingestKey) else { return }
        inactiveCheckInSent = true
        let client = APIClient(baseURL: serverURL, ingestKey: ingestKey) {
            APIClient.sdkHeaderValue(wrapper: UserContext.shared.wrapper?.name)
        }
        let query = configQuery(health: "ok", active: false)
        guard let request = client.makeRequest(method: "GET", path: "/api/v1/sdk/config", query: query.queryItems) else { return }
        SDKLog.info("Snitch is inactive (release type unknown); sending the opt-in diagnostic check-in")
        // The completion keeps the client (and its session) alive until the answer, which is ignored.
        client.send(request) { _ in withExtendedLifetime(client) {} }
    }

    // MARK: - Reconcile

    private func reconcile() {
        dispatchPrecondition(condition: .onQueue(.main))
        publishState()
        guard activated else { return }
        let on = isOn

        if on { windowTracker?.start() } else { windowTracker?.stop() }

        let gesture = effective.gesture
        // In debug builds RN's dev menu owns shake when both gestures are on.
        let wantsShake = on && appActive && !overlay.isSheetVisible
            && (gesture == .shake || (gesture == .both && releaseType != .debug))
        if wantsShake { shake.start() } else { shake.stop() }

        // The edge handle: shown while Snitch is on, the app is in front and no sheet is up.
        // It reports as trigger "gesture" (the contract's trigger list predates it, and older
        // servers would reject a new value).
        if on && appActive && !overlay.isSheetVisible && gesture == .edgeHandle {
            overlay.showEdgeHandle(
                side: effective.edgeHandleSide,
                position: effective.edgeHandlePosition,
                colorHex: effective.edgeHandleColor
            ) { [weak self] in
                self?.openSheet(trigger: "gesture", type: nil)
            }
        } else {
            overlay.hideEdgeHandle()
        }

        if on && effective.screenshotPrompt { screenshotObserver.start() } else {
            screenshotObserver.stop()
            overlay.hidePill(on ? OverlayController.PillKind.screenshot : nil)
        }
        if !(on && effective.crashPrompt) { overlay.hidePill(.crash) }

        reconcileCapture(on: on)
        reconcileTimeline(on: on)
    }

    /// Timeline switches (static option ∧ remote switch), the network gate, and the crash
    /// follow-up's session log, all off while Snitch is off.
    private func reconcileTimeline(on: Bool) {
        recorder.configure(TimelineRecorder.Switches(
            on: on,
            console: effective.consoleCapture,
            network: effective.networkCapture,
            screens: effective.trackScreens
        ))
        let networkOn = on && effective.networkCapture
        SnitchURLProtocol.gate.mutate { gate in gate.enabled = networkOn }

        let wantsSessionLog = on && effective.crashPrompt && crashStore != nil
        if wantsSessionLog && sessionLogTimer == nil {
            let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in self?.saveSessionLog() }
            timer.tolerance = 5
            RunLoop.main.add(timer, forMode: .common)
            sessionLogTimer = timer
        } else if !wantsSessionLog {
            sessionLogTimer?.invalidate()
            sessionLogTimer = nil
        }
    }

    /// The timeline's newest log lines, saved for the next launch's crash follow-up.
    private func saveSessionLog() {
        guard sessionLogTimer != nil, let store = crashStore else { return }
        let lines = recorder.sessionLogLines(limit: CrashStore.sessionLogLines)
        fileQueue.async { store.saveSessionLog(lines) }
    }

    private func reconcileCapture(on: Bool) {
        let maxAgeMs = Double(effective.videoMaxSeconds) * 1000
        touchLog.maxAgeMs = maxAgeMs
        let mode: CaptureMode = on && !testerPausedRecording ? effective.captureMode : .off
        let paused = !appActive || overlay.isSheetVisible

        switch mode {
        case .off:
            stopSnapshotCapture()
            systemCapturer?.stop()
            store.clear()
            touchLog.clear()
        case .snapshot:
            systemCapturer?.stop()
            runSnapshotCapture(maxAgeMs: maxAgeMs, paused: paused)
        case .system:
            if systemFallback {
                systemCapturer?.stop()
                runSnapshotCapture(maxAgeMs: maxAgeMs, paused: paused)
            } else {
                stopSnapshotCapture()
                store.setLimits(maxBytes: FrameStore.systemMaxBytes, maxAgeMs: maxAgeMs)
                let capturer = ensureSystemCapturer()
                capturer.systemFps = effective.systemFps
                capturer.maskTextInputs = effective.maskTextInputs
                capturer.isPaused = overlay.isSheetVisible
                if appActive { capturer.start() } else { capturer.stop() }
            }
        }
    }

    private func runSnapshotCapture(maxAgeMs: Double, paused: Bool) {
        store.setLimits(maxBytes: FrameStore.snapshotMaxBytes, maxAgeMs: maxAgeMs)
        let settings = FrameCapturer.Settings(
            renderer: effective.snapshotRenderer,
            governor: GovernorConfig(
                idleFps: effective.idleFps,
                activeFps: effective.activeFps,
                budgetPct: effective.budgetPct,
                activeWindowMs: 1500
            ),
            maskTextInputs: effective.maskTextInputs
        )
        let capturer: FrameCapturer
        if let existing = frameCapturer {
            capturer = existing
            capturer.settings = settings
        } else {
            capturer = FrameCapturer(settings: settings, store: store, stats: stats)
            capturer.isPaused = { [weak self] in
                guard let self = self else { return true }
                return !self.appActive || self.overlay.isSheetVisible || !self.isOn || self.testerPausedRecording
            }
            capturer.lastTouchAt = { [weak self] in self?.lastTouchAt }
            frameCapturer = capturer
        }
        if capturer.isRunning { capturer.reschedule() } else { capturer.start() }
        if appActive && !paused {
            sentinel?.sessionStarted(renderer: settings.renderer.rawValue)
        }
    }

    private func stopSnapshotCapture() {
        if frameCapturer?.isRunning == true {
            frameCapturer?.stop()
            sentinel?.sessionEnded()
        }
    }

    private func ensureSystemCapturer() -> SystemCapturer {
        if let existing = systemCapturer { return existing }
        let capturer = SystemCapturer(store: store, stats: stats)
        capturer.onFallback = { [weak self] _ in
            self?.systemFallback = true
            self?.reconcile()
        }
        capturer.onAvailable = { [weak self] in
            self?.systemFallback = false
            self?.reconcile()
        }
        systemCapturer = capturer
        return capturer
    }

    private func publishState() {
        let on = isOn
        publicStateBox.set(PublicState(
            isEnabled: on,
            releaseType: releaseType,
            consoleCapture: on && (staticConfig?.options.captureConsole ?? false)
        ))
    }

    // MARK: - App lifecycle

    private func installObservers() {
        let center = NotificationCenter.default
        func observe(_ name: Notification.Name, _ block: @escaping (Notification) -> Void) {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main, using: block))
        }
        observe(UIApplication.didBecomeActiveNotification) { [weak self] _ in
            guard let self = self else { return }
            self.appActive = true
            self.reconcile()
            // A turn later, once the app has settled its view controllers.
            DispatchQueue.main.async { [weak self] in
                self?.screenTracker.infer()
                self?.offerCrashReportIfPending()
            }
        }
        observe(UIApplication.willResignActiveNotification) { [weak self] _ in
            guard let self = self else { return }
            self.appActive = false
            self.sentinel?.sessionEnded()
            self.reconcile()
        }
        observe(UIApplication.didEnterBackgroundNotification) { [weak self] _ in
            guard let self = self else { return }
            self.appActive = false
            self.sentinel?.sessionEnded()
            self.systemCapturer?.stop()
            self.recorder.appEvent(.background)
            self.saveSessionLog()
            self.reconcile()
        }
        observe(UIApplication.willEnterForegroundNotification) { [weak self] _ in
            self?.recorder.appEvent(.foreground)
            self?.fetchRemoteConfig(force: false)
            self?.runUploads()
        }
        observe(UIApplication.didReceiveMemoryWarningNotification) { [weak self] _ in
            self?.store.trimHalf()
            self?.recorder.appEvent(.memoryWarning)
        }
        observe(ProcessInfo.thermalStateDidChangeNotification) { [weak self] _ in
            self?.frameCapturer?.reschedule()
        }
        observe(Notification.Name.NSProcessInfoPowerStateDidChange) { [weak self] _ in
            self?.frameCapturer?.reschedule()
        }
    }

    // MARK: - Remote config

    private func fetchRemoteConfig(force: Bool) {
        guard activated, let client = client, let remote = remote else { return }
        guard force || remote.isStale() else { return }
        let health = sentinel?.healthPending == true ? "crashloop" : "ok"
        let query = configQuery(health: health, active: true)
        remote.fetch(client: client, query: query) { [weak self] changed, succeeded in
            guard let self = self else { return }
            if succeeded && health == "crashloop" { self.sentinel?.healthReported() }
            if changed { self.remoteConfigChanged() }
            self.offerCrashReportIfPending()
        }
    }

    /// The config query with the check-in fields (spec §11.1).
    private func configQuery(health: String, active: Bool) -> RemoteConfigQuery {
        let info = Bundle.main.infoDictionary ?? [:]
        let checkIn = detection.map { detection in
            CheckInFields(
                installId: installId ?? InstallId.current(defaults: defaults),
                appId: Bundle.main.bundleIdentifier ?? "unknown",
                sdkVersion: SnitchVersion.current,
                wrapper: UserContext.shared.wrapper?.name,
                model: DeviceInfoCollector.hardwareModel(),
                signals: detection.summary,
                active: active
            )
        }
        return RemoteConfigQuery(
            releaseType: releaseType.rawValue,
            appVersion: (info["CFBundleShortVersionString"] as? String) ?? "0",
            build: (info["CFBundleVersion"] as? String) ?? "0",
            os: UIDevice.current.systemVersion,
            health: health,
            checkIn: checkIn
        )
    }

    private func remoteConfigChanged() {
        guard let config = staticConfig else { return }
        effective = ConfigMerger.effective(
            options: config.options,
            remote: remote?.config,
            rendererDowngrade: sentinel?.downgradeLevel ?? 0
        )
        if !effective.enabled { overlay.hidePill() }
        reconcile()
        if effective.enabled { scheduleTesterNotice() }
    }

    func setAppEnabled(_ enabled: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        appEnabled = enabled
        if !enabled {
            overlay.hidePill()
            overlay.hideNotice()
        }
        reconcile()
    }

    // MARK: - Touches (WindowTouchRecognizerHost)

    var gestureDetectionEnabled: Bool {
        let g = effective.gesture
        return isOn && !overlay.isSheetVisible && pendingSheet == nil
            && !UIAccessibility.isVoiceOverRunning
            && (g == .threeFingerHold || g == .both)
    }

    var debugCancelAfterMs: Double? {
        isOn ? hooks.cancelAfterMs : nil
    }

    func recognizer(_ recognizer: WindowTouchRecognizer, observed sample: TouchSample) {
        touchLog.add(sample)
        lastTouchAt = sample.t
        guard sample.phase == .down else { return }
        frameCapturer?.reschedule()
        // Timeline touch downs as fractions of the screen; the first finger also re-checks the screen.
        let window = recognizer.view as? UIWindow
        let bounds = window?.windowScene?.coordinateSpace.bounds ?? window?.bounds ?? .zero
        if bounds.width > 0, bounds.height > 0 {
            recorder.touchDown(
                mono: sample.t,
                x: sample.x / Double(bounds.width),
                y: sample.y / Double(bounds.height),
                fingers: recognizer.activeTouchCount
            )
        }
        if recognizer.activeTouchCount <= 1 { screenTracker.infer() }
    }

    func recognizerWillFire(_ recognizer: WindowTouchRecognizer, sequenceStart: Double, debug: Bool) -> Bool {
        guard isOn, !overlay.isSheetVisible, pendingSheet == nil else { return false }
        pendingSheet = PendingSheet(
            trigger: "gesture",
            preselectedType: nil,
            frozen: freeze(endT: sequenceStart),
            screenshot: takeScreenshot(),
            debugDismiss: debug,
            timeline: recorder.freeze()
        )
        return true
    }

    func recognizerDidFire(_ recognizer: WindowTouchRecognizer, debug: Bool) {
        guard let pending = pendingSheet else { return }
        pendingSheet = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        presentSheet(pending)
        if pending.debugDismiss {
            DispatchQueue.main.async { [weak self] in self?.overlay.dismissSheet() }
        }
    }

    // MARK: - Opening the sheet

    func show(type: String?) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard isOn else {
            SDKLog.once("show.inactive", level: .info, "Snitch.show() ignored: the SDK is not enabled")
            return
        }
        openSheet(trigger: "api", type: type)
    }

    private func openSheet(trigger: String, type: String?) {
        guard isOn, !overlay.isSheetVisible, pendingSheet == nil else { return }
        screenTracker.infer()
        let pending = PendingSheet(
            trigger: trigger,
            preselectedType: type,
            frozen: freeze(endT: Clock.nowMs()),
            screenshot: takeScreenshot(),
            debugDismiss: false,
            timeline: recorder.freeze()
        )
        if trigger == "shake" { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        presentSheet(pending)
    }

    private func systemScreenshotTaken() {
        guard isOn, effective.screenshotPrompt, !overlay.isSheetVisible else { return }
        overlay.showPill(
            .screenshot,
            title: Strings.screenshotPrompt,
            iconName: "exclamationmark.bubble.fill",
            duration: Theme.promptDuration
        ) { [weak self] in
            self?.openSheet(trigger: "screenshot", type: nil)
        }
    }

    // MARK: - Crash follow-up (spec §11.8)

    /// Once per launch, when the server takes `crash` reports and a crash from the last
    /// 7 days is pending: "The app closed unexpectedly. Report it?". Re-checked when the
    /// config arrives, a diagnostic is saved, the app comes to the front or the sheet closes.
    private func offerCrashReportIfPending() {
        guard isOn, appActive, !crashOffered, effective.crashPrompt,
              effective.serverFeatures.contains(ServerFeature.triggerCrash),
              !overlay.isSheetVisible, pendingSheet == nil,
              let crash = crashStore?.pendingCrash() else { return }
        crashOffered = overlay.showPill(
            .crash,
            title: Strings.crashPrompt,
            iconName: "exclamationmark.triangle.fill",
            duration: Theme.crashPromptDuration,
            onTap: { [weak self] in self?.openCrashSheet(crash) },
            onClose: { [weak self] in self?.crashStore?.discardPending() }
        )
    }

    /// Trigger `crash`, type bug, no video (the frames died with the process), screenshot
    /// unticked; Send attaches the diagnostic and the previous session's log as the timeline.
    private func openCrashSheet(_ crash: PendingCrash) {
        guard isOn, !overlay.isSheetVisible, pendingSheet == nil else { return }
        let pending = PendingSheet(
            trigger: "crash",
            preselectedType: "bug",
            frozen: freeze(endT: Clock.nowMs()),
            screenshot: takeScreenshot(),
            debugDismiss: false,
            timeline: crashStore?.previousSessionTimeline(),
            crash: crash
        )
        presentSheet(pending)
    }

    private func freeze(endT: Double) -> FrozenCapture {
        let ring = store.snapshot()
        let windowStart = endT - Double(effective.videoMaxSeconds) * 1000 - 1000
        return FrozenCapture(endT: endT, ring: ring, touches: touchLog.window(start: windowStart, end: endT))
    }

    private func takeScreenshot() -> Screenshot? {
        guard effective.screenshotEnabled else { return nil }
        let renderer: SnapshotRenderer = (sentinel?.downgradeLevel ?? 0) >= 1 ? .layerRender : effective.snapshotRenderer
        return ScreenshotTaker.take(renderer: renderer, maskTextInputs: effective.maskTextInputs)
    }

    private func recordedSeconds(_ frozen: FrozenCapture) -> Int {
        frozen.hasFrames ? max(1, Int(frozen.bufferedSeconds.rounded(.up))) : 0
    }

    private func presentSheet(_ pending: PendingSheet) {
        let user = UserContext.shared.user
        let isCrash = pending.crash != nil
        let model = ReportSheetModel(
            reportTypes: effective.reportTypes,
            preselectedType: pending.preselectedType,
            message: effective.message,
            screenshot: pending.screenshot,
            videoAvailable: effective.videoEnabled && !isCrash,
            recordedSeconds: recordedSeconds(pending.frozen),
            videoMaxSeconds: effective.videoMaxSeconds,
            email: defaults.string(forKey: DefaultsKey.reporterEmail) ?? user.email,
            pauseRecording: testerPausedRecording,
            screenshotSelected: !isCrash,
            crashAttached: isCrash
        )
        model.onDismiss = { [weak self] in
            self?.overlay.dismissSheet()
            // Dismissing the crash follow-up is an answer too: forget that crash.
            if isCrash { self?.crashStore?.discardPending() }
        }
        model.onSend = { [weak self] submission in self?.submit(submission, pending: pending) }
        overlay.presentSheet(model: model)
    }

    // MARK: - Sending

    private func submit(_ submission: ReportSheetModel.Submission, pending: PendingSheet) {
        overlay.dismissSheet()
        if let email = submission.email {
            defaults.set(email, forKey: DefaultsKey.reporterEmail)
        } else {
            defaults.removeObject(forKey: DefaultsKey.reporterEmail)
        }
        if submission.pauseRecording != testerPausedRecording {
            testerPausedRecording = submission.pauseRecording
            reconcile()
        }
        let isCrash = pending.crash != nil
        var context = makeContext(
            trigger: pending.trigger,
            typeId: submission.typeId,
            description: submission.description,
            email: submission.email,
            frozen: isCrash ? nil : pending.frozen
        )
        context.timeline = pending.timeline
        context.screen = isCrash ? nil : pending.timeline?.screen
        context.crashText = pending.crash?.text
        let video = submission.includeVideo && !isCrash
            ? VideoRequest(frozen: pending.frozen, seconds: submission.videoSeconds)
            : nil
        enqueue(context, screenshot: submission.includeScreenshot ? submission.screenshot : nil, video: video, announce: true)
        if isCrash { crashStore?.discardPending() }
    }


    private func makeContext(trigger: String, typeId: String, description: String, email: String?, frozen: FrozenCapture?) -> ReportContext {
        let snapshot = stats.snapshot()
        let actualMode: CaptureMode = effective.captureMode == .system && systemFallback ? .snapshot : effective.captureMode
        var body = CaptureStatsBody()
        body.captureMode = actualMode.rawValue
        if actualMode == .snapshot { body.snapshotRenderer = effective.snapshotRenderer.rawValue }
        body.captureMsP50 = snapshot.p50
        body.captureMsP95 = snapshot.p95
        body.effectiveFps = snapshot.effectiveFps
        body.ringBytes = frozen?.ring.totalBytes ?? store.totalBytes
        body.bufferedSeconds = round1(frozen?.bufferedSeconds ?? store.bufferedMs(Clock.nowMs()) / 1000)
        body.framesSkipped = snapshot.framesSkipped
        body.uptimeSec = snapshot.uptimeSec
        body.crashLoopDowngrades = sentinel?.downgrades ?? 0

        let user = UserContext.shared
        return ReportContext(
            clientReportId: ReportBuilder.newReportId(),
            reportedAt: Date(),
            trigger: trigger,
            typeId: typeId,
            description: description,
            app: DeviceInfoCollector.app(releaseType: releaseType),
            device: DeviceInfoCollector.device(network: network.current, window: AppWindows.keyWindow()),
            user: user.user,
            email: email,
            custom: user.metadata,
            wrapper: user.wrapper,
            stats: body,
            logText: LogRing.attachmentText(ringLines: LogRing.shared.snapshot(), providerText: user.logProvider?()),
            installId: installId
        )
    }

    private func enqueue(_ context: ReportContext, screenshot: Screenshot?, video: VideoRequest?, announce: Bool) {
        guard let outbox = outbox else {
            if announce { overlay.showToast(Strings.saveFailed, duration: Theme.toastDuration) }
            return
        }
        if announce {
            sessionReports.insert(context.clientReportId)
            overlay.showToast(Strings.sending, duration: 20)
        }
        let task = BackgroundTask.begin("Snitch report")
        reportQueue.async { [weak self] in
            var ok = true
            do {
                try ReportBuilder.write(context: context, screenshot: screenshot, video: video, to: outbox)
            } catch {
                ok = false
                SDKLog.error("Couldn't save the report: \(error)")
                outbox.delete(outbox.directory(for: context.clientReportId))
            }
            DispatchQueue.main.async {
                if ok {
                    self?.runUploads()
                } else if announce {
                    self?.sessionReports.remove(context.clientReportId)
                    self?.overlay.showToast(Strings.saveFailed, duration: Theme.toastDuration)
                }
                task.end()
            }
        }
    }

    private func runUploads() {
        guard let uploader = uploader else { return }
        if uploadTask == nil { uploadTask = BackgroundTask.begin("Snitch upload") }
        uploader.run()
    }

    private func uploadOutcome(_ id: String, _ outcome: Uploader.Outcome) {
        guard sessionReports.contains(id) else { return }
        switch outcome {
        case let .sent(ticket):
            sessionReports.remove(id)
            offlineNotified.remove(id)
            overlay.showToast(ticket.isEmpty ? Strings.sentNoTicket : Strings.sent(ticket), duration: Theme.toastDuration)
        case .retryLater:
            if !offlineNotified.contains(id) {
                offlineNotified.insert(id)
                overlay.showToast(Strings.savedOffline, duration: Theme.toastDuration)
            }
        case .dropped:
            sessionReports.remove(id)
            offlineNotified.remove(id)
            overlay.showToast(Strings.rejected, duration: Theme.toastDuration)
        }
    }

    // MARK: - Tester notice

    private func scheduleTesterNotice() {
        guard effective.showTesterNotice, !defaults.bool(forKey: DefaultsKey.noticeShown), noticeTimer == nil else { return }
        let timer = Timer(timeInterval: 5, repeats: false) { [weak self] _ in
            self?.noticeTimer = nil
            self?.tryShowNotice()
        }
        RunLoop.main.add(timer, forMode: .common)
        noticeTimer = timer
    }

    private func tryShowNotice() {
        guard isOn, effective.showTesterNotice, !defaults.bool(forKey: DefaultsKey.noticeShown) else { return }
        let recentlyTouched = lastTouchAt.map { Clock.nowMs() - $0 < 2000 } ?? false
        guard appActive, !overlay.isSheetVisible, !recentlyTouched else {
            // Only when the app is idle; look again shortly.
            let timer = Timer(timeInterval: 2, repeats: false) { [weak self] _ in
                self?.noticeTimer = nil
                self?.tryShowNotice()
            }
            RunLoop.main.add(timer, forMode: .common)
            noticeTimer = timer
            return
        }
        defaults.set(true, forKey: DefaultsKey.noticeShown)
        overlay.showNotice(text: Strings.testerNotice(gesture: effective.gesture, seconds: effective.videoMaxSeconds)) {}
    }

    // MARK: - Debug hooks

    private func scheduleDebugHooks() {
        if let seconds = hooks.autoReportAfter {
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.autoReport() }
        }
        if hooks.showOnLaunch {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.show(type: nil) }
        }
    }

    /// SNITCH_DEBUG_AUTOREPORT: a `bug` report with screenshot and up to 5 s of video, no UI.
    private func autoReport() {
        guard isOn else { return }
        screenTracker.infer()
        let frozen = freeze(endT: Clock.nowMs())
        let snapshot = recorder.freeze()
        let screenshot = takeScreenshot()
        let recorded = recordedSeconds(frozen)
        let seconds = effective.videoEnabled && recorded > 0 ? max(1, min(5, Int(frozen.bufferedSeconds.rounded(.down)))) : 0
        SDKLog.info("Debug autoreport: screenshot \(screenshot != nil), video \(seconds) s, timeline \(snapshot.events.count) events")
        var context = makeContext(trigger: "api", typeId: "bug", description: "autoreport", email: nil, frozen: frozen)
        context.timeline = snapshot
        context.screen = snapshot.screen
        enqueue(
            context,
            screenshot: screenshot,
            video: seconds > 0 ? VideoRequest(frozen: frozen, seconds: seconds) : nil,
            announce: false
        )
    }
}
