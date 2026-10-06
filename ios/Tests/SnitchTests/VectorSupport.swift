// Loads the shared contract vectors and fixtures straight from the repository
// (contract/vectors, contract/fixtures) relative to this file, so the Swift,
// Kotlin and TypeScript suites always test against the same JSON. They are
// deliberately not declared as test resources.

import Foundation
import XCTest

enum Contract {
    /// ios/Tests/SnitchTests/<this file> → repository root.
    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // SnitchTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
    }

    static func data(_ relativePath: String) throws -> Data {
        let url = repoRoot.appendingPathComponent(relativePath)
        return try Data(contentsOf: url)
    }

    static func vector(_ name: String) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: data("contract/vectors/\(name)"))
        return try XCTUnwrap(object as? [String: Any], "\(name) is not a JSON object")
    }

    static func fixture(_ name: String) throws -> Data {
        try data("contract/fixtures/\(name)")
    }

    static func fixtureObject(_ name: String) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: fixture(name))
        return try XCTUnwrap(object as? [String: Any], "\(name) is not a JSON object")
    }

    /// A JSON number as Double; nil for null/missing. (JSON booleans are not numbers here.)
    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, !(value is NSNull) else { return nil }
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
        return n.doubleValue
    }

    static func string(_ value: Any?) -> String? {
        value as? String
    }
}
