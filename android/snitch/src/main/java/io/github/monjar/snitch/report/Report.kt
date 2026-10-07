/*
 * Plain data for one report, mirroring `ReportCreate` in contract/src/ingest.ts.
 * Nullable fields are optional on the wire and are omitted (never sent as
 * null) by ReportBuilder. Collected on device by env/DeviceInfoCollector and
 * SnitchRuntime; kept free of android.* so the JSON is unit-testable on the JVM.
 */
package io.github.monjar.snitch.report

internal data class AppInfo(
    val id: String,
    val name: String?,
    val version: String,
    val build: String,
    val releaseType: String,
)

internal data class ScreenInfo(val width: Double, val height: Double, val scale: Double, val orientation: String)

internal data class MemoryInfo(val appMB: Long?, val freeMB: Long?, val totalMB: Long?)

internal data class DeviceSnapshot(
    val osVersion: String,
    val model: String,
    val manufacturer: String? = null,
    val locale: String? = null,
    val timeZone: String? = null,
    val screen: ScreenInfo? = null,
    val memory: MemoryInfo? = null,
    val thermal: String? = null,
    val lowPower: Boolean? = null,
    val battery: Double? = null,
    val charging: Boolean? = null,
    val network: String? = null,
    val darkMode: Boolean? = null,
    val screenReader: Boolean? = null,
    val fontScale: Double? = null,
) {
    val platform: String get() = "android"
}

internal data class SdkInfo(val name: String, val version: String, val wrapper: String? = null, val wrapperVersion: String? = null)

internal data class ReporterInfo(val email: String? = null, val name: String? = null, val id: String? = null)

/** `CaptureStats` is `.strict()` in the contract: only these keys may be sent. */
internal data class StatsSnapshot(
    val captureMode: String? = null,
    val captureMsP50: Double? = null,
    val captureMsP95: Double? = null,
    val effectiveFps: Double? = null,
    val ringBytes: Long? = null,
    val bufferedSeconds: Double? = null,
    val composeMs: Double? = null,
    val framesSkipped: Long? = null,
    val uptimeSec: Double? = null,
    val crashLoopDowngrades: Long? = null,
    val videoLost: Boolean? = null,
)

internal data class AttachmentDecl(
    val name: String,
    val contentType: String,
    val sizeBytes: Long,
    val sha256: String,
    val width: Int? = null,
    val height: Int? = null,
    val durationMs: Long? = null,
) {
    /** File name inside the outbox directory. */
    val fileName: String get() = fileNameFor(name, contentType)

    companion object {
        const val SCREENSHOT = "screenshot"
        const val VIDEO = "video"
        const val LOGS = "logs"

        fun fileNameFor(name: String, contentType: String): String = name + when (contentType) {
            "image/jpeg" -> ".jpg"
            "image/png" -> ".png"
            "video/mp4" -> ".mp4"
            "text/plain" -> ".txt"
            "application/x-ndjson" -> ".ndjson"
            else -> ".bin"
        }
    }
}

internal data class ReportPayload(
    val clientReportId: String,
    val type: String,
    val description: String,
    val reporter: ReporterInfo?,
    val reportedAtMs: Long,
    val trigger: String,
    val app: AppInfo,
    val device: DeviceSnapshot,
    val sdk: SdkInfo,
    val custom: Map<String, String>?,
    val stats: StatsSnapshot?,
    val attachments: List<AttachmentDecl>,
)
