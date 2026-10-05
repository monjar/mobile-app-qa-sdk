/*
 * Serialises a ReportPayload into the exact `ReportCreate` JSON of the
 * contract (contract/fixtures/report.create.android.json): optional fields are
 * omitted rather than sent as null, `reportedAt` is ISO-8601 UTC with
 * milliseconds, and every string is clamped to the schema's limits.
 *
 * Clamping matters because the server answers an invalid body with 422, and a
 * 422 deletes the queued report (spec §7.3): a typo in the email field or an
 * over-long metadata value must never cost the tester their report. So invalid
 * optional values are dropped and over-long strings truncated here.
 */
package io.github.monjar.snitch.report

import org.json.JSONArray
import org.json.JSONObject

internal object ReportBuilder {
    private val REPORT_TYPE_ID = Regex("^[a-z0-9_-]{1,24}$")
    private val ATTACHMENT_NAME = Regex("^[a-z0-9_-]{1,32}$")
    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    /** zod 4's `z.email()` pattern, so the server never rejects an address the SDK accepted. */
    private val EMAIL = Regex("^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$")

    const val MAX_ATTACHMENTS = 5
    const val MAX_CUSTOM_KEYS = 50

    fun isValidEmail(value: String?): Boolean = value != null && value.length <= 254 && EMAIL.matches(value)

    fun isValidReportType(value: String?): Boolean = value != null && REPORT_TYPE_ID.matches(value)

    fun toJson(p: ReportPayload): JSONObject {
        val o = JSONObject()
        o.put("clientReportId", p.clientReportId.lowercase())
        o.put("type", if (isValidReportType(p.type)) p.type else "other")
        o.put("description", p.description.take(10_000))
        reporterJson(p.reporter)?.let { o.put("reporter", it) }
        o.put("reportedAt", Iso8601.format(p.reportedAtMs))
        o.put("trigger", p.trigger)
        o.put("app", appJson(p.app))
        o.put("device", deviceJson(p.device))
        o.put("sdk", sdkJson(p.sdk))
        customJson(p.custom)?.let { o.put("custom", it) }
        statsJson(p.stats)?.let { o.put("stats", it) }
        val attachments = JSONArray()
        val seen = HashSet<String>()
        for (a in p.attachments) {
            if (attachments.length() >= MAX_ATTACHMENTS) break
            if (!seen.add(a.name)) continue
            attachments.put(attachmentJson(a))
        }
        o.put("attachments", attachments)
        return o
    }

    fun attachmentJson(a: AttachmentDecl): JSONObject {
        require(ATTACHMENT_NAME.matches(a.name)) { "invalid attachment name ${a.name}" }
        require(SHA256_HEX.matches(a.sha256)) { "invalid sha256 for ${a.name}" }
        require(a.sizeBytes > 0) { "empty attachment ${a.name}" }
        val o = JSONObject()
        o.put("name", a.name)
        o.put("contentType", a.contentType)
        o.put("sizeBytes", a.sizeBytes)
        o.put("sha256", a.sha256)
        a.width?.takeIf { it in 1..20_000 }?.let { o.put("width", it) }
        a.height?.takeIf { it in 1..20_000 }?.let { o.put("height", it) }
        a.durationMs?.takeIf { it in 1..31_000 }?.let { o.put("durationMs", it) }
        return o
    }

    private fun reporterJson(r: ReporterInfo?): JSONObject? {
        if (r == null) return null
        val o = JSONObject()
        r.email?.trim()?.takeIf { isValidEmail(it) }?.let { o.put("email", it) }
        r.name?.trim()?.takeIf { it.isNotEmpty() }?.let { o.put("name", it.take(120)) }
        r.id?.takeIf { it.isNotEmpty() }?.let { o.put("id", it.take(200)) }
        return if (o.length() == 0) null else o
    }

    private fun appJson(a: AppInfo): JSONObject {
        val o = JSONObject()
        o.put("id", a.id.take(255).ifEmpty { "unknown" })
        a.name?.takeIf { it.isNotBlank() }?.let { o.put("name", it.take(120)) }
        o.put("version", a.version.take(64).ifEmpty { "0" })
        o.put("build", a.build.take(64).ifEmpty { "0" })
        o.put("releaseType", a.releaseType)
        return o
    }

    private fun deviceJson(d: DeviceSnapshot): JSONObject {
        val o = JSONObject()
        o.put("platform", d.platform)
        o.put("osVersion", d.osVersion.take(32).ifEmpty { "unknown" })
        o.put("model", d.model.take(64).ifEmpty { "unknown" })
        d.manufacturer?.takeIf { it.isNotEmpty() }?.let { o.put("manufacturer", it.take(64)) }
        d.locale?.takeIf { it.isNotEmpty() }?.let { o.put("locale", it.take(35)) }
        d.timeZone?.takeIf { it.isNotEmpty() }?.let { o.put("timeZone", it.take(64)) }
        d.screen?.let { s ->
            if (s.width > 0 && s.height > 0 && s.scale > 0 && s.scale <= 10) {
                o.put(
                    "screen",
                    JSONObject()
                        .put("width", s.width)
                        .put("height", s.height)
                        .put("scale", s.scale)
                        .put("orientation", if (s.orientation == "landscape") "landscape" else "portrait"),
                )
            }
        }
        d.memory?.let { m ->
            val mo = JSONObject()
            m.appMB?.takeIf { it >= 0 }?.let { mo.put("appMB", it) }
            m.freeMB?.takeIf { it >= 0 }?.let { mo.put("freeMB", it) }
            m.totalMB?.takeIf { it >= 0 }?.let { mo.put("totalMB", it) }
            if (mo.length() > 0) o.put("memory", mo)
        }
        d.thermal?.takeIf { it in THERMAL }?.let { o.put("thermal", it) }
        d.lowPower?.let { o.put("lowPower", it) }
        d.battery?.takeIf { it in 0.0..1.0 }?.let { o.put("battery", it) }
        d.charging?.let { o.put("charging", it) }
        d.network?.takeIf { it in NETWORK }?.let { o.put("network", it) }
        d.darkMode?.let { o.put("darkMode", it) }
        d.screenReader?.let { o.put("screenReader", it) }
        d.fontScale?.takeIf { it > 0 && it <= 10 }?.let { o.put("fontScale", it) }
        return o
    }

    private fun sdkJson(s: SdkInfo): JSONObject {
        val o = JSONObject()
        o.put("name", s.name.take(64))
        o.put("version", s.version.take(32))
        s.wrapper?.takeIf { it.isNotEmpty() }?.let { o.put("wrapper", it.take(32)) }
        s.wrapperVersion?.takeIf { it.isNotEmpty() }?.let { o.put("wrapperVersion", it.take(32)) }
        return o
    }

    private fun customJson(custom: Map<String, String>?): JSONObject? {
        if (custom.isNullOrEmpty()) return null
        val o = JSONObject()
        for ((k, v) in custom) {
            if (o.length() >= MAX_CUSTOM_KEYS) break
            val key = k.take(64)
            if (key.isEmpty() || o.has(key)) continue
            o.put(key, v.take(1000))
        }
        return if (o.length() == 0) null else o
    }

    private fun statsJson(s: StatsSnapshot?): JSONObject? {
        if (s == null) return null
        val o = JSONObject()
        s.captureMode?.let { o.put("captureMode", it) }
        putNonNegative(o, "captureMsP50", s.captureMsP50)
        putNonNegative(o, "captureMsP95", s.captureMsP95)
        putNonNegative(o, "effectiveFps", s.effectiveFps)
        s.ringBytes?.takeIf { it >= 0 }?.let { o.put("ringBytes", it) }
        putNonNegative(o, "bufferedSeconds", s.bufferedSeconds)
        putNonNegative(o, "composeMs", s.composeMs)
        s.framesSkipped?.takeIf { it >= 0 }?.let { o.put("framesSkipped", it) }
        putNonNegative(o, "uptimeSec", s.uptimeSec)
        s.crashLoopDowngrades?.takeIf { it >= 0 }?.let { o.put("crashLoopDowngrades", it) }
        s.videoLost?.let { o.put("videoLost", it) }
        return if (o.length() == 0) null else o
    }

    private fun putNonNegative(o: JSONObject, key: String, value: Double?) {
        if (value != null && !value.isNaN() && !value.isInfinite() && value >= 0) o.put(key, round3(value))
    }

    private fun round3(v: Double): Double = Math.round(v * 1000.0) / 1000.0

    private val THERMAL = setOf("nominal", "fair", "serious", "critical")
    private val NETWORK = setOf("wifi", "cellular", "ethernet", "none", "other", "unknown")
}
