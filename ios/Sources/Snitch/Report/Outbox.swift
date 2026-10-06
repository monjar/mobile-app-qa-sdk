// The on-disk outbox (spec §7.2):
//   Application Support/Snitch/outbox/<clientReportId>/
//     report.json  — the ReportCreate body; written last, atomically
//     screenshot.jpg, video.mp4, logs.txt
//     state.json   — {reportId?, ticket?, attempts, nextAttemptAt, uploaded: [names]}
// A directory is only eligible for upload once report.json exists, so a crash
// mid-write never uploads half a report. Excluded from backup; file protection
// completeUntilFirstUserAuthentication so uploads can resume while locked.
// Caps: 10 reports or 100 MB — the oldest go first.

import Foundation

struct OutboxState: Codable, Equatable {
    var reportId: String?
    var ticket: String?
    var attempts: Int = 0
    /// Seconds since 1970.
    var nextAttemptAt: Double = 0
    var uploaded: [String] = []
}

struct PendingReport {
    var id: String
    var dir: URL
    var createdAt: Date
}

final class Outbox {
    static let maxReports = 10
    static let maxBytes: Int64 = 100 * 1024 * 1024
    /// Directories without report.json older than this are abandoned writes.
    static let staleStagingSeconds: TimeInterval = 600

    static let reportFile = "report.json"
    static let stateFile = "state.json"

    /// File name for each attachment name.
    static func fileName(for attachment: String) -> String {
        switch attachment {
        case "screenshot": return "screenshot.jpg"
        case "video": return "video.mp4"
        case "logs": return "logs.txt"
        default: return attachment + ".bin"
        }
    }

    let root: URL
    private let fm = FileManager.default
    private let protection = FileProtectionType.completeUntilFirstUserAuthentication

    init(root: URL) {
        self.root = root
    }

    /// Application Support/Snitch/outbox, with Snitch/ excluded from backup.
    static func makeDefault() -> Outbox? {
        let fm = FileManager.default
        guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        var snitchDir = support.appendingPathComponent("Snitch", isDirectory: true)
        do {
            try fm.createDirectory(
                at: snitchDir,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try snitchDir.setResourceValues(values)
        } catch {
            SDKLog.warn("Outbox unavailable: \(error)")
            return nil
        }
        let outbox = Outbox(root: snitchDir.appendingPathComponent("outbox", isDirectory: true))
        try? outbox.ensureRoot()
        return outbox
    }

    func ensureRoot() throws {
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: protection])
    }

    func directory(for id: String) -> URL {
        root.appendingPathComponent(id, isDirectory: true)
    }

    func createReportDirectory(id: String) throws -> URL {
        try ensureRoot()
        let dir = directory(for: id)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: protection])
        return dir
    }

    func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Writes report.json last; from this moment the report is eligible for upload.
    func commit(_ report: ReportCreate, in dir: URL) throws {
        try saveState(OutboxState(), in: dir)
        let data = try ReportJSON.encoder().encode(report)
        try write(data, to: dir.appendingPathComponent(Outbox.reportFile))
    }

    func reportData(in dir: URL) -> Data? {
        try? Data(contentsOf: dir.appendingPathComponent(Outbox.reportFile))
    }

    func loadReport(in dir: URL) -> ReportCreate? {
        guard let data = reportData(in: dir) else { return nil }
        return try? JSONDecoder().decode(ReportCreate.self, from: data)
    }

    func loadState(in dir: URL) -> OutboxState {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(Outbox.stateFile)),
              let state = try? JSONDecoder().decode(OutboxState.self, from: data) else { return OutboxState() }
        return state
    }

    func saveState(_ state: OutboxState, in dir: URL) throws {
        let data = try JSONEncoder().encode(state)
        try write(data, to: dir.appendingPathComponent(Outbox.stateFile))
    }

    func delete(_ dir: URL) {
        try? fm.removeItem(at: dir)
    }

    /// Eligible reports (report.json present), oldest first.
    func pendingReports() -> [PendingReport] {
        entries().filter { fm.fileExists(atPath: $0.dir.appendingPathComponent(Outbox.reportFile).path) }
    }

    /// Deletes abandoned staging directories, then the oldest reports beyond the caps.
    func enforceCaps(now: Date = Date()) {
        var kept: [(PendingReport, Int64)] = []
        for entry in entries() {
            let committed = fm.fileExists(atPath: entry.dir.appendingPathComponent(Outbox.reportFile).path)
            if !committed {
                if now.timeIntervalSince(entry.createdAt) > Outbox.staleStagingSeconds { delete(entry.dir) }
                continue
            }
            kept.append((entry, size(of: entry.dir)))
        }
        var total = kept.reduce(Int64(0)) { $0 + $1.1 }
        while !kept.isEmpty && (kept.count > Outbox.maxReports || total > Outbox.maxBytes) {
            let oldest = kept.removeFirst()
            total -= oldest.1
            SDKLog.warn("Outbox full; dropping the oldest unsent report \(oldest.0.id)")
            delete(oldest.0.dir)
        }
    }

    private func entries() -> [PendingReport] {
        let keys: [URLResourceKey] = [.creationDateKey, .isDirectoryKey]
        guard let urls = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            return []
        }
        var out: [PendingReport] = []
        for url in urls {
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isDirectory == true else { continue }
            out.append(PendingReport(id: url.lastPathComponent, dir: url, createdAt: values.creationDate ?? .distantPast))
        }
        return out.sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
    }

    private func size(of dir: URL) -> Int64 {
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey], options: []) else { return 0 }
        return files.reduce(Int64(0)) { sum, url in
            sum + Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
    }
}
