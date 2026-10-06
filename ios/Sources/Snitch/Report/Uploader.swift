// The upload queue (spec §7.3): one report at a time on a serial queue.
//
//   1. POST /api/v1/reports (report.json) unless state.reportId is known
//   2. PUT each declared attachment the server doesn't have yet
//   3. POST /api/v1/reports/{id}/complete → delete the directory
//
// Errors follow contract/src/ingest.ts#isRetryable:
//   401/403/413/415/422 and other non-retryable → drop the report (logged once)
//   409 attachments_missing → back to step 2;  409 report_completed → done
//   404 on PUT/complete → forget reportId, restart at step 1
//   429/5xx/network → attempts += 1, nextAttemptAt = now + min(30 s·2^(n-1), 1 h),
//   or later if the server sent Retry-After
// State is persisted after every step, so an app kill resumes where it stopped.

import Foundation

final class Uploader {
    enum Outcome: Equatable {
        case sent(ticket: String)
        case retryLater(nextAttemptAt: Date, offline: Bool)
        case dropped(status: Int, code: String?)
    }

    static let baseBackoff: TimeInterval = 30
    static let maxBackoff: TimeInterval = 3600
    static let maxRetryAfter: TimeInterval = 86_400
    private static let maxLoops = 4

    private let outbox: Outbox
    private let client: APIClient
    private let queue = DispatchQueue(label: "io.github.monjar.snitch.upload", qos: .utility)
    private let drainScheduled = Locked(false)
    private var wakeItem: DispatchWorkItem?

    /// Injectable clock for tests.
    var now: () -> Date = { Date() }
    /// Called on the main thread with the clientReportId and what happened to it.
    var onOutcome: ((String, Outcome) -> Void)?
    /// Called on the main thread after each pass over the outbox (ends the runtime's background task).
    var onDrainFinished: (() -> Void)?

    init(outbox: Outbox, client: APIClient) {
        self.outbox = outbox
        self.client = client
    }

    /// Runs the queue soon (after an enqueue, on foreground, when the network returns).
    func run() {
        let shouldSchedule = drainScheduled.mutate { (scheduled: inout Bool) -> Bool in
            if scheduled { return false }
            scheduled = true
            return true
        }
        guard shouldSchedule else { return }
        queue.async { [weak self] in
            guard let self = self else { return }
            self.drainScheduled.set(false)
            self.drain()
        }
    }

    /// Blocks until queued work is done (tests).
    func waitUntilIdle() {
        queue.sync {}
    }

    private func drain() {
        outbox.enforceCaps(now: now())
        for report in outbox.pendingReports() {
            let state = outbox.loadState(in: report.dir)
            if state.nextAttemptAt > now().timeIntervalSince1970 { continue }
            let outcome = upload(report)
            if let callback = onOutcome {
                let id = report.id
                DispatchQueue.main.async { callback(id, outcome) }
            }
            // Offline: everything else would fail the same way; wait for the network.
            if case let .retryLater(_, offline) = outcome, offline { break }
        }
        scheduleWake()
        if let finished = onDrainFinished {
            DispatchQueue.main.async { finished() }
        }
    }

    /// Wakes the queue when the earliest backoff expires (while the process lives).
    private func scheduleWake() {
        wakeItem?.cancel()
        wakeItem = nil
        let nowSeconds = now().timeIntervalSince1970
        let next = outbox.pendingReports()
            .map { outbox.loadState(in: $0.dir).nextAttemptAt }
            .filter { $0 > nowSeconds }
            .min()
        guard let due = next else { return }
        let item = DispatchWorkItem { [weak self] in self?.run() }
        wakeItem = item
        queue.asyncAfter(deadline: .now() + max(1, due - nowSeconds), execute: item)
    }

    /// The §7.3 state machine for one report. Synchronous; runs on `queue`.
    func upload(_ report: PendingReport) -> Outcome {
        let dir = report.dir
        guard let body = outbox.reportData(in: dir), let declared = outbox.loadReport(in: dir) else {
            SDKLog.warn("Dropping unreadable outbox entry \(report.id)")
            outbox.delete(dir)
            return .dropped(status: 0, code: "corrupt")
        }
        var state = outbox.loadState(in: dir)

        for _ in 0..<Uploader.maxLoops {
            // 1. Create.
            if state.reportId == nil {
                guard let request = client.makeRequest(
                    method: "POST", path: "/api/v1/reports",
                    headers: ["Content-Type": "application/json"], body: body
                ) else { return drop(dir, status: 0, code: "bad_url") }
                let r = client.sendSync(request)
                guard r.status == 200 || r.status == 201,
                      let created = try? JSONDecoder().decode(ReportCreated.self, from: r.data) else {
                    return failure(r, dir: dir, state: &state)
                }
                state.reportId = created.reportId
                state.ticket = created.ticket
                state.uploaded = (created.attachments ?? []).filter { $0.state == "stored" }.map { $0.name }
                save(state, dir)
            }
            guard let reportId = state.reportId else { continue }

            // 2. Attachments.
            var restart = false
            for attachment in declared.attachments where !state.uploaded.contains(attachment.name) {
                let file = dir.appendingPathComponent(Outbox.fileName(for: attachment.name))
                let size: Int? = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize
                guard let fileSize = size else {
                    // The server would wait forever for a file we no longer have.
                    SDKLog.warn("Attachment \(attachment.name) of \(report.id) is missing on disk; dropping the report")
                    return drop(dir, status: 0, code: "file_missing")
                }
                guard let request = client.makeRequest(
                    method: "PUT",
                    path: "/api/v1/reports/\(reportId)/attachments/\(attachment.name)",
                    headers: [
                        "Content-Type": attachment.contentType,
                        "Content-Length": String(fileSize),
                        "X-Content-SHA256": attachment.sha256,
                    ],
                    timeout: APIClient.uploadTimeout
                ) else { return drop(dir, status: 0, code: "bad_url") }
                let r = client.sendSync(request, file: file)
                if r.status == 200 || r.status == 201 {
                    state.uploaded.append(attachment.name)
                    save(state, dir)
                    continue
                }
                if r.status == 404 {
                    state = restartState(state)
                    save(state, dir)
                    restart = true
                    break
                }
                if r.status == 409 && r.errorCode == "report_completed" {
                    return finished(dir, state: state)
                }
                return failure(r, dir: dir, state: &state)
            }
            if restart { continue }

            // 3. Complete.
            guard let request = client.makeRequest(
                method: "POST", path: "/api/v1/reports/\(reportId)/complete"
            ) else { return drop(dir, status: 0, code: "bad_url") }
            let r = client.sendSync(request)
            if r.status == 200 || r.status == 201 {
                return finished(dir, state: state)
            }
            if r.status == 409 && r.errorCode == "attachments_missing" {
                let missing = APIErrorEnvelope.missingAttachments(from: r.data) ?? declared.attachments.map { $0.name }
                state.uploaded.removeAll { missing.contains($0) }
                save(state, dir)
                continue
            }
            if r.status == 409 && r.errorCode == "report_completed" {
                return finished(dir, state: state)
            }
            if r.status == 404 {
                state = restartState(state)
                save(state, dir)
                continue
            }
            return failure(r, dir: dir, state: &state)
        }
        // Kept bouncing between steps: back off rather than spin.
        return backoff(dir: dir, state: &state, retryAfter: nil, offline: false)
    }

    // MARK: - Outcomes

    private func finished(_ dir: URL, state: OutboxState) -> Outcome {
        outbox.delete(dir)
        return .sent(ticket: state.ticket ?? "")
    }

    private func drop(_ dir: URL, status: Int, code: String?) -> Outcome {
        outbox.delete(dir)
        return .dropped(status: status, code: code)
    }

    private func failure(_ r: HTTPResponse, dir: URL, state: inout OutboxState) -> Outcome {
        let alwaysDrop: Set<Int> = [401, 403, 413, 415, 422]
        if alwaysDrop.contains(r.status) || !APIErrorEnvelope.isRetryable(status: r.status, code: r.errorCode) {
            SDKLog.once("upload.drop.\(r.status).\(r.errorCode ?? "")",
                        "The server refused a report (\(r.status) \(r.errorCode ?? "")); it was deleted")
            outbox.delete(dir)
            return .dropped(status: r.status, code: r.errorCode)
        }
        return backoff(dir: dir, state: &state, retryAfter: r.retryAfterSeconds, offline: r.status == 0)
    }

    private func backoff(dir: URL, state: inout OutboxState, retryAfter: TimeInterval?, offline: Bool) -> Outcome {
        state.attempts += 1
        let delay = Uploader.backoffDelay(attempts: state.attempts, retryAfter: retryAfter)
        let next = now().addingTimeInterval(delay)
        state.nextAttemptAt = next.timeIntervalSince1970
        save(state, dir)
        return .retryLater(nextAttemptAt: next, offline: offline)
    }

    /// min(30 s · 2^(attempts-1), 1 h), but never earlier than Retry-After.
    static func backoffDelay(attempts: Int, retryAfter: TimeInterval?) -> TimeInterval {
        let exponent = Double(max(0, attempts - 1))
        let computed = min(baseBackoff * pow(2, min(exponent, 20)), maxBackoff)
        guard let ra = retryAfter else { return computed }
        return max(computed, min(ra, maxRetryAfter))
    }

    private func restartState(_ state: OutboxState) -> OutboxState {
        var s = state
        s.reportId = nil
        s.ticket = nil
        s.uploaded = []
        return s
    }

    private func save(_ state: OutboxState, _ dir: URL) {
        do {
            try outbox.saveState(state, in: dir)
        } catch {
            SDKLog.once("upload.state", "Couldn't persist upload state: \(error)")
        }
    }
}
