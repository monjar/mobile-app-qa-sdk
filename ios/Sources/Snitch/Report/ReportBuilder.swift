// Builds a report on disk (spec §7.1): writes the attachments into a fresh
// outbox directory, composes the clip, hashes everything, then commits
// report.json. Runs on the report queue, never on main; everything that needs
// UIKit (device info, screenshot) was captured on main beforehand.
//
// Values are clamped to the contract's limits here, because a 422 makes the
// uploader drop the report — a typo in the email field must not cost the tester
// their report.
//
// 0.3 attachments: `timeline` (application/x-ndjson, spec §11.3) from the snapshot
// frozen with the capture, finished here — the unified-log lines are read now, on
// the report queue, and meta.videoStart/videoEnd come from the clip just composed —
// and `crash` (text/plain, spec §11.8), the saved diagnostic of a crash follow-up.
// Every report carries the timeline: servers since 0.1 accept application/x-ndjson,
// so it doesn't wait for the first config fetch to confirm the `timeline` feature.

import Foundation

/// Everything about a report that was read on the main thread at Send time.
struct ReportContext {
    var clientReportId: String
    var reportedAt: Date
    var trigger: String
    var typeId: String
    var description: String
    var app: AppInfo
    var device: DeviceInfo
    var user: UserContext.User
    /// The sheet's email field, which wins over setUser's email.
    var email: String?
    var custom: [String: String]
    var wrapper: UserContext.Wrapper?
    var stats: CaptureStatsBody?
    var logText: String?
    /// The check-in installId.
    var installId: String? = nil
    /// The screen showing when the sheet opened.
    var screen: String? = nil
    /// Written as the `timeline` attachment.
    var timeline: TimelineSnapshot? = nil
    /// Written as the `crash` attachment (crash follow-up).
    var crashText: String? = nil
}

struct VideoRequest {
    var frozen: FrozenCapture
    var seconds: Int
}

enum ReportBuilder {
    static let attachmentLimits: [String: Int] = [
        "image/jpeg": 8 * 1024 * 1024,
        "video/mp4": 30 * 1024 * 1024,
        "text/plain": 2 * 1024 * 1024,
        "application/x-ndjson": TimelineLimits.maxBytes,
    ]
    /// The saved crash diagnostic is cut to this many bytes (spec §11.8).
    static let crashTextMaxBytes = 512 * 1024

    static func newReportId() -> String {
        UUID().uuidString.lowercased()
    }

    static func isPlausibleEmail(_ s: String) -> Bool {
        s.count <= 254 && s.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil
    }

    static func reporter(user: UserContext.User, email: String?) -> Reporter? {
        var r = Reporter()
        if let e = (email ?? user.email).nonEmpty, isPlausibleEmail(e) { r.email = e }
        if let n = user.name.nonEmpty { r.name = String(n.prefix(120)) }
        if let i = user.id.nonEmpty { r.id = String(i.prefix(200)) }
        return (r.email == nil && r.name == nil && r.id == nil) ? nil : r
    }

    static func isValidTypeId(_ id: String) -> Bool {
        id.range(of: "^[a-z0-9_-]{1,24}$", options: .regularExpression) != nil
    }

    /// The ReportCreate body for `context` and already-written attachments.
    static func makeReport(context: ReportContext, attachments: [AttachmentDeclaration], stats: CaptureStatsBody?) -> ReportCreate {
        var sdk = SdkInfo(name: SnitchVersion.sdkName, version: SnitchVersion.current, wrapper: nil, wrapperVersion: nil)
        if let w = context.wrapper {
            sdk.wrapper = w.name
            sdk.wrapperVersion = w.version
        }
        var custom: [String: String] = [:]
        for (k, v) in context.custom.prefix(UserContext.maxCustomKeys) {
            custom[String(k.prefix(64))] = String(v.prefix(1000))
        }
        return ReportCreate(
            clientReportId: context.clientReportId,
            type: isValidTypeId(context.typeId) ? context.typeId : "other",
            description: String(context.description.prefix(10_000)),
            reporter: reporter(user: context.user, email: context.email),
            reportedAt: ReportJSON.timestamp(context.reportedAt),
            trigger: context.trigger,
            app: context.app,
            device: context.device,
            sdk: sdk,
            custom: custom.isEmpty ? nil : custom,
            stats: stats,
            screen: TimelineText.field(context.screen, maxUTF16: TimelineLimits.screenChars),
            installId: context.installId.flatMap { InstallId.isValid($0) ? $0 : nil },
            attachments: attachments
        )
    }

    /// Writes the whole report into `outbox` and commits it. Returns the report directory.
    @discardableResult
    static func write(
        context: ReportContext,
        screenshot: Screenshot?,
        video: VideoRequest?,
        to outbox: Outbox
    ) throws -> URL {
        let dir = try outbox.createReportDirectory(id: context.clientReportId)
        var attachments: [AttachmentDeclaration] = []
        var stats = context.stats

        if let shot = screenshot, shot.jpeg.count > 0, shot.jpeg.count <= attachmentLimits["image/jpeg"]! {
            let url = dir.appendingPathComponent(Outbox.fileName(for: "screenshot"))
            try outbox.write(shot.jpeg, to: url)
            attachments.append(AttachmentDeclaration(
                name: "screenshot", contentType: "image/jpeg", sizeBytes: shot.jpeg.count,
                sha256: Hashing.sha256Hex(shot.jpeg), width: shot.width, height: shot.height, durationMs: nil
            ))
        }

        /// The composed clip's monotonic end and length, for the timeline's meta.
        var clip: (endT: Double, durationMs: Int)?
        if let video = video {
            let started = Clock.nowMs()
            let url = dir.appendingPathComponent(Outbox.fileName(for: "video"))
            do {
                let frames = video.frozen.ring.select(video.frozen.endT, Double(video.seconds) * 1000)
                let result = try VideoComposer.compose(
                    frames: frames,
                    touches: video.frozen.touches,
                    endT: video.frozen.endT,
                    durationMs: Double(video.seconds) * 1000,
                    to: url
                )
                let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
                guard size > 0, size <= attachmentLimits["video/mp4"]! else {
                    throw VideoComposer.ComposeError.writeFailed("size \(size)")
                }
                let hash = try Hashing.sha256Hex(fileAt: url)
                attachments.append(AttachmentDeclaration(
                    name: "video", contentType: "video/mp4", sizeBytes: size,
                    sha256: hash,
                    width: result.width, height: result.height,
                    durationMs: min(result.durationMs, 31_000)
                ))
                clip = (video.frozen.endT, min(result.durationMs, 31_000))
            } catch {
                SDKLog.warn("Composing the video failed (\(error)); sending the report without it")
                try? FileManager.default.removeItem(at: url)
                if stats == nil { stats = CaptureStatsBody() }
                stats?.videoLost = true
            }
            if stats == nil { stats = CaptureStatsBody() }
            stats?.composeMs = round1(Clock.nowMs() - started)
        }

        if let text = context.logText, let data = text.data(using: .utf8), !data.isEmpty,
           data.count <= attachmentLimits["text/plain"]! {
            let url = dir.appendingPathComponent(Outbox.fileName(for: "logs"))
            try outbox.write(data, to: url)
            attachments.append(AttachmentDeclaration(
                name: "logs", contentType: "text/plain", sizeBytes: data.count,
                sha256: Hashing.sha256Hex(data), width: nil, height: nil, durationMs: nil
            ))
        }

        if let timeline = context.timeline,
           let declaration = try writeTimeline(timeline, clip: clip, in: dir, outbox: outbox) {
            attachments.append(declaration)
        }

        if let text = context.crashText, !text.isEmpty {
            var data = Data(text.utf8)
            if data.count > crashTextMaxBytes { data = data.prefix(crashTextMaxBytes) }
            let url = dir.appendingPathComponent(Outbox.fileName(for: "crash"))
            try outbox.write(data, to: url)
            attachments.append(AttachmentDeclaration(
                name: "crash", contentType: "text/plain", sizeBytes: data.count,
                sha256: Hashing.sha256Hex(data), width: nil, height: nil, durationMs: nil
            ))
        }

        let report = makeReport(context: context, attachments: attachments, stats: stats)
        try outbox.commit(report, in: dir)
        return dir
    }

    /// Finishes the frozen timeline (unified-log lines, video span) and writes it; nil when
    /// there is nothing to show.
    static func writeTimeline(
        _ timeline: TimelineSnapshot,
        clip: (endT: Double, durationMs: Int)?,
        in dir: URL,
        outbox: Outbox
    ) throws -> AttachmentDeclaration? {
        var events = timeline.events
        if let console = timeline.nativeConsole {
            events += ConsoleReader.entries(console)
        }
        guard !events.isEmpty else { return nil }
        let span = clip.map { timelineVideoSpan(endT: $0.endT, durationMs: $0.durationMs, monoToWallMs: timeline.monoToWallMs) }
        let document = TimelineEncoding.document(
            events: events,
            end: timeline.end,
            videoStart: span?.start,
            videoEnd: span?.end,
            dropped: timeline.dropped
        )
        guard document.eventCount > 0, document.data.count <= TimelineLimits.maxBytes else { return nil }
        let url = dir.appendingPathComponent(Outbox.fileName(for: "timeline"))
        try outbox.write(document.data, to: url)
        return AttachmentDeclaration(
            name: "timeline", contentType: "application/x-ndjson", sizeBytes: document.data.count,
            sha256: Hashing.sha256Hex(document.data), width: nil, height: nil, durationMs: nil
        )
    }

    /// meta.videoEnd = wall(endT), videoStart = videoEnd − durationMs (spec §11.3).
    static func timelineVideoSpan(endT: Double, durationMs: Int, monoToWallMs: Double) -> (start: Int64, end: Int64) {
        let end = Int64((endT + monoToWallMs).rounded())
        return (start: max(0, end - Int64(durationMs)), end: end)
    }
}
