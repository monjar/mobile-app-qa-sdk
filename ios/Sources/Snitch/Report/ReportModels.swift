// Wire models for report intake (ReportCreate / ReportCreated in contract/src/ingest.ts).
//
// Optionals are omitted from the JSON when nil (synthesized Encodable uses
// encodeIfPresent), so the output has exactly the keys the contract allows —
// CaptureStats in particular is `.strict()` on the server.

import Foundation

struct ReportCreate: Codable, Equatable {
    var clientReportId: String
    var type: String
    var description: String
    var reporter: Reporter?
    var reportedAt: String
    var trigger: String
    var app: AppInfo
    var device: DeviceInfo
    var sdk: SdkInfo
    var custom: [String: String]?
    var stats: CaptureStatsBody?
    var attachments: [AttachmentDeclaration]
}

struct Reporter: Codable, Equatable {
    var email: String?
    var name: String?
    var id: String?
}

struct AppInfo: Codable, Equatable {
    var id: String
    var name: String?
    var version: String
    var build: String
    var releaseType: String
}

struct DeviceInfo: Codable, Equatable {
    struct Screen: Codable, Equatable {
        var width: Double
        var height: Double
        var scale: Double
        var orientation: String
    }

    struct Memory: Codable, Equatable {
        var appMB: Int?
        var freeMB: Int?
        var totalMB: Int?
    }

    var platform: String
    var osVersion: String
    var model: String
    var manufacturer: String?
    var locale: String?
    var timeZone: String?
    var screen: Screen?
    var memory: Memory?
    var thermal: String?
    var lowPower: Bool?
    var battery: Double?
    var charging: Bool?
    var network: String?
    var darkMode: Bool?
    var screenReader: Bool?
    var fontScale: Double?
}

struct SdkInfo: Codable, Equatable {
    var name: String
    var version: String
    var wrapper: String?
    var wrapperVersion: String?
}

struct CaptureStatsBody: Codable, Equatable {
    var captureMode: String?
    var snapshotRenderer: String?
    var captureMsP50: Double?
    var captureMsP95: Double?
    var effectiveFps: Double?
    var ringBytes: Int?
    var bufferedSeconds: Double?
    var composeMs: Double?
    var framesSkipped: Int?
    var uptimeSec: Double?
    var crashLoopDowngrades: Int?
    var videoLost: Bool?
}

struct AttachmentDeclaration: Codable, Equatable {
    var name: String
    var contentType: String
    var sizeBytes: Int
    var sha256: String
    var width: Int?
    var height: Int?
    var durationMs: Int?
}

struct ReportCreated: Codable, Equatable {
    struct Attachment: Codable, Equatable {
        var name: String
        var state: String
    }

    var reportId: String
    var ticket: String
    var number: Int?
    var state: String?
    var attachments: [Attachment]?
}

enum ReportJSON {
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }

    /// ISO-8601 UTC with milliseconds, e.g. 2026-10-07T13:55:02.120Z.
    static func timestamp(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }
}
