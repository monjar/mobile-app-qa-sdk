// The upload queue (spec §7.3): one report at a time on a serial queue.
//
//   1. POST /api/v1/reports (report.json) unless state.reportId is known
//   2. PUT each declared attachment the server doesn't have yet
//   3. POST /api/v1/reports/{id}/complete → delete the directory
//
// Errors follow contract/src/ingest.ts#isRetryable:
//   401/403/413/415/422 and other non-retryable → drop the report (logged once)
//   409 attachments_missing → back to step 2;  409 report_completed → done
//   404 on PUT/complete → forget reportId (and chunk offsets), restart at step 1
//   429/5xx/network → attempts += 1, nextAttemptAt = now + min(30 s·2^(n-1), 1 h),
//   or later if the server sent Retry-After
// State is persisted after every step, so an app kill resumes where it stopped.
//
// Chunked, resumable attachments (spec §11.2) when the create response says
// `upload.resumable`: a file larger than one chunk goes up in Content-Range chunks
// read straight from disk (only that byte range is in memory), each with the whole
// file's X-Content-SHA256 and the chunk's X-Chunk-SHA256. The server's offset per
// attachment (`offsets`, seeded from the create response's receivedBytes) is
// persisted after every chunk:
//   202 → next chunk from receivedBytes;  201 → stored
//   409 range_mismatch → resume from details.receivedBytes (3 per pass, then back off)
//   422 hash_mismatch + details.chunk → back off, the next pass resends the chunk
//   422 hash_mismatch (whole file) → restart that attachment from 0 once; the second drops
// Small files, and servers without resumable upload, keep the single whole-file PUT.

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
    /// range_mismatch answers one pass absorbs before backing off.
    static let maxRangeMismatchesPerPass = 3
    /// Whole-file hash failures of a chunked upload tolerated before the report is dropped.
    static let maxWholeFileRestarts = 1
    private static let maxLoops = 4

    /// What uploading one attachment came to.
    private enum AttachmentStep {
        case stored
        /// The server forgot the report (404): back to step 1.
        case restart
        case finish(Outcome)
    }

    private let outbox: Outbox
    private let client: APIClient
    private let queue = DispatchQueue(label: "io.github.monjar.snitch.upload", qos: .utility)
    private let drainScheduled = Locked(false)
    private var wakeItem: DispatchWorkItem?

    /// Injectable clock for tests.
    var now: () -> Date = { Date() }
    /// SNITCH_DEBUG_CHUNK_BYTES (debug builds): caps the chunk size; set before the first run.
    var chunkBytesCap: Int?
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

    /// The §7.3 / §11.2 state machine for one report. Synchronous; runs on `queue`.
    func upload(_ report: PendingReport) -> Outcome {
        let dir = report.dir
        guard let body = outbox.reportData(in: dir), let declared = outbox.loadReport(in: dir) else {
            SDKLog.warn("Dropping unreadable outbox entry \(report.id)")
            outbox.delete(dir)
            return .dropped(status: 0, code: "corrupt")
        }
        var state = outbox.loadState(in: dir)
        var mismatches = 0

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
                applyCreated(created, to: &state)
                save(state, dir)
            }
            guard let reportId = state.reportId else { continue }

            // 2. Attachments.
            var restart = false
            attachments: for attachment in declared.attachments where !state.uploaded.contains(attachment.name) {
                let file = dir.appendingPathComponent(Outbox.fileName(for: attachment.name))
                let size: Int? = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize
                guard let fileSize = size, fileSize == attachment.sizeBytes else {
                    // The server would wait forever for a file we no longer have (or that changed).
                    SDKLog.warn("Attachment \(attachment.name) of \(report.id) is missing or changed on disk; dropping the report")
                    return drop(dir, status: 0, code: "file_missing")
                }
                let step: AttachmentStep
                if ChunkPlan.isChunked(resumable: state.resumable, size: fileSize, chunkBytes: state.chunkBytes) {
                    step = uploadChunks(attachment, file: file, size: fileSize, reportId: reportId,
                                        dir: dir, state: &state, mismatches: &mismatches)
                } else {
                    step = uploadWhole(attachment, file: file, size: fileSize, reportId: reportId, dir: dir, state: &state)
                }
                switch step {
                case .stored:
                    continue attachments
                case .restart:
                    restart = true
                    break attachments
                case let .finish(outcome):
                    return outcome
                }
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

    /// Step 1's answer: ids, what is already stored, and how the server takes uploads.
    private func applyCreated(_ created: ReportCreated, to state: inout OutboxState) {
        let attachments = created.attachments ?? []
        state.reportId = created.reportId
        state.ticket = created.ticket
        state.uploaded = attachments.filter { $0.state == "stored" }.map { $0.name }
        state.resumable = created.upload?.resumable ?? false
        state.chunkBytes = state.resumable ? ChunkPlan.chunkBytes(server: created.upload?.chunkBytes, debugCap: chunkBytesCap) : 0
        state.offsets = [:]
        if state.resumable {
            for a in attachments where a.state != "stored" {
                if let received = a.receivedBytes, received > 0 { state.offsets[a.name] = received }
            }
        }
    }

    /// One PUT with the whole file (§7.3); also replaces any partial chunked upload.
    private func uploadWhole(
        _ attachment: AttachmentDeclaration, file: URL, size: Int, reportId: String, dir: URL, state: inout OutboxState
    ) -> AttachmentStep {
        guard let request = client.makeRequest(
            method: "PUT",
            path: "/api/v1/reports/\(reportId)/attachments/\(attachment.name)",
            headers: [
                "Content-Type": attachment.contentType,
                "Content-Length": String(size),
                "X-Content-SHA256": attachment.sha256,
            ],
            timeout: APIClient.uploadTimeout
        ) else { return .finish(drop(dir, status: 0, code: "bad_url")) }
        let r = client.sendSync(request, file: file)
        if r.status == 200 || r.status == 201 {
            markStored(attachment.name, state: &state, dir: dir)
            return .stored
        }
        return nonChunkAnswer(r, dir: dir, state: &state)
    }

    /// Content-Range chunks from the server's offset until the file is stored (§11.2).
    private func uploadChunks(
        _ attachment: AttachmentDeclaration, file: URL, size: Int, reportId: String,
        dir: URL, state: inout OutboxState, mismatches: inout Int
    ) -> AttachmentStep {
        let name = attachment.name
        while true {
            guard let range = ChunkPlan.nextRange(offset: state.offsets[name] ?? 0, size: size, chunkBytes: state.chunkBytes) else {
                // The server claims every byte (or an impossible offset) yet hasn't stored the
                // file: a whole-file PUT replaces whatever partial upload it holds.
                state.offsets.removeValue(forKey: name)
                save(state, dir)
                return uploadWhole(attachment, file: file, size: size, reportId: reportId, dir: dir, state: &state)
            }
            let chunk: Data
            do {
                chunk = try Uploader.read(range, of: file)
            } catch {
                SDKLog.warn("Attachment \(name) could not be read (\(error)); dropping the report")
                return .finish(drop(dir, status: 0, code: "file_missing"))
            }
            guard chunk.count == range.count else {
                SDKLog.warn("Attachment \(name) is shorter than declared; dropping the report")
                return .finish(drop(dir, status: 0, code: "file_missing"))
            }
            guard let request = client.makeRequest(
                method: "PUT",
                path: "/api/v1/reports/\(reportId)/attachments/\(name)",
                headers: [
                    "Content-Type": attachment.contentType,
                    "Content-Length": String(chunk.count),
                    "Content-Range": ChunkPlan.contentRange(range, total: size),
                    "X-Content-SHA256": attachment.sha256,
                    "X-Chunk-SHA256": Hashing.sha256Hex(chunk),
                ],
                timeout: APIClient.uploadTimeout
            ) else { return .finish(drop(dir, status: 0, code: "bad_url")) }
            let r = client.sendSync(request, body: chunk)

            switch r.status {
            case 202:
                let partial = try? JSONDecoder().decode(AttachmentPartial.self, from: r.data)
                state.offsets[name] = partial?.receivedBytes ?? (range.upperBound + 1)
                save(state, dir)
            case 200, 201:
                markStored(name, state: &state, dir: dir)
                return .stored
            case 409 where r.errorCode == "range_mismatch":
                state.offsets[name] = max(0, APIErrorEnvelope.receivedBytes(from: r.data) ?? 0)
                save(state, dir)
                mismatches += 1
                if mismatches >= Uploader.maxRangeMismatchesPerPass {
                    return .finish(backoff(dir: dir, state: &state, retryAfter: r.retryAfterSeconds, offline: false))
                }
            case 422 where r.errorCode == "hash_mismatch":
                if APIErrorEnvelope.isChunkHashMismatch(r.data) {
                    // Nothing was appended; the bytes changed on the wire. The next pass resends.
                    return .finish(backoff(dir: dir, state: &state, retryAfter: r.retryAfterSeconds, offline: false))
                }
                // The assembled file failed verification and the server discarded it.
                guard state.restarts < Uploader.maxWholeFileRestarts else {
                    return .finish(failure(r, dir: dir, state: &state))
                }
                state.restarts += 1
                state.offsets[name] = 0
                save(state, dir)
            default:
                return nonChunkAnswer(r, dir: dir, state: &state)
            }
        }
    }

    /// The answers both upload paths share: 404 restarts, report_completed finishes, the rest per §7.3.
    private func nonChunkAnswer(_ r: HTTPResponse, dir: URL, state: inout OutboxState) -> AttachmentStep {
        if r.status == 404 {
            state = restartState(state)
            save(state, dir)
            return .restart
        }
        if r.status == 409 && r.errorCode == "report_completed" {
            return .finish(finished(dir, state: state))
        }
        return .finish(failure(r, dir: dir, state: &state))
    }

    private func markStored(_ name: String, state: inout OutboxState, dir: URL) {
        if !state.uploaded.contains(name) { state.uploaded.append(name) }
        state.offsets.removeValue(forKey: name)
        save(state, dir)
    }

    /// Exactly `range` of `file`, read without loading the rest.
    static func read(_ range: ClosedRange<Int>, of file: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(range.lowerBound))
        var data = Data()
        data.reserveCapacity(range.count)
        while data.count < range.count {
            guard let more = try handle.read(upToCount: range.count - data.count), !more.isEmpty else { break }
            data.append(more)
        }
        return data
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

    /// The server forgot the report: create it again. Chunk offsets belonged to the old one.
    private func restartState(_ state: OutboxState) -> OutboxState {
        var s = state
        s.reportId = nil
        s.ticket = nil
        s.uploaded = []
        s.offsets = [:]
        s.resumable = false
        s.chunkBytes = 0
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
