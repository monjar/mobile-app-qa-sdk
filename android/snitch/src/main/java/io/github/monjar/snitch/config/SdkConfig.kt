/*
 * The remote `SdkConfig` (contract/src/ingest.ts, fixture
 * contract/fixtures/sdk-config.json) and its lenient parser.
 *
 * Parsing mirrors `mergeSdkConfig`: every field the server sent and that is
 * valid overrides the base (DEFAULT_SDK_CONFIG), nested objects merge by key,
 * and anything missing or out of range keeps the base value — a server one
 * version ahead never breaks the SDK. Pure Kotlin + org.json.
 */
package io.github.monjar.snitch.config

import org.json.JSONObject

internal data class ReportTypeOption(val id: String, val label: String)

internal data class VideoSettings(
    val enabled: Boolean,
    val maxSeconds: Int,
    val captureMode: String,
    val snapshotRenderer: String,
    val idleFps: Double,
    val activeFps: Double,
    val systemFps: Double,
    val mainThreadBudgetPct: Double,
)

internal data class SdkConfig(
    val enabled: Boolean,
    val ttlSeconds: Long,
    val reportTypes: List<ReportTypeOption>,
    val screenshotEnabled: Boolean,
    val video: VideoSettings,
    val maskTextInputs: Boolean,
    val screenshotPrompt: Boolean,
    val message: String?,
) {
    companion object {
        /** contract/src/ingest.ts DEFAULT_SDK_CONFIG. */
        val DEFAULT = SdkConfig(
            enabled = true,
            ttlSeconds = 3600,
            reportTypes = listOf(ReportTypeOption("bug", "Bug"), ReportTypeOption("idea", "Idea"), ReportTypeOption("other", "Other")),
            screenshotEnabled = true,
            video = VideoSettings(
                enabled = true,
                maxSeconds = 30,
                captureMode = "snapshot",
                snapshotRenderer = "drawHierarchy",
                idleFps = 1.0,
                activeFps = 4.0,
                systemFps = 10.0,
                mainThreadBudgetPct = 3.0,
            ),
            maskTextInputs = true,
            screenshotPrompt = true,
            message = null,
        )

        private val TYPE_ID = Regex("^[a-z0-9_-]{1,24}$")
        private val CAPTURE_MODES = setOf("snapshot", "system", "off")
        private val RENDERERS = setOf("drawHierarchy", "layerRender")

        fun parse(json: JSONObject, base: SdkConfig = DEFAULT): SdkConfig {
            val v = json.optJSONObject("video")
            val bv = base.video
            val video = if (v == null) {
                bv
            } else {
                VideoSettings(
                    enabled = bool(v, "enabled") ?: bv.enabled,
                    maxSeconds = num(v, "maxSeconds", 1.0, 30.0)?.toInt() ?: bv.maxSeconds,
                    captureMode = str(v, "captureMode")?.takeIf { it in CAPTURE_MODES } ?: bv.captureMode,
                    snapshotRenderer = str(v, "snapshotRenderer")?.takeIf { it in RENDERERS } ?: bv.snapshotRenderer,
                    idleFps = num(v, "idleFps", 0.2, 10.0) ?: bv.idleFps,
                    activeFps = num(v, "activeFps", 0.2, 15.0) ?: bv.activeFps,
                    systemFps = num(v, "systemFps", 1.0, 15.0) ?: bv.systemFps,
                    mainThreadBudgetPct = num(v, "mainThreadBudgetPct", 0.5, 20.0) ?: bv.mainThreadBudgetPct,
                )
            }
            val types = json.optJSONArray("reportTypes")?.let { arr ->
                (0 until arr.length()).mapNotNull { i ->
                    val t = arr.optJSONObject(i) ?: return@mapNotNull null
                    val id = str(t, "id")?.takeIf { TYPE_ID.matches(it) } ?: return@mapNotNull null
                    val label = str(t, "label")?.takeIf { it.isNotEmpty() && it.length <= 40 } ?: return@mapNotNull null
                    ReportTypeOption(id, label)
                }.take(8)
            }
            val message = when {
                !json.has("message") -> base.message
                json.isNull("message") -> null
                else -> str(json, "message")?.take(500)?.ifBlank { null }
            }
            return SdkConfig(
                enabled = bool(json, "enabled") ?: base.enabled,
                ttlSeconds = num(json, "ttlSeconds", 60.0, 86_400.0)?.toLong() ?: base.ttlSeconds,
                reportTypes = if (types.isNullOrEmpty()) base.reportTypes else types,
                screenshotEnabled = json.optJSONObject("screenshot")?.let { bool(it, "enabled") } ?: base.screenshotEnabled,
                video = video,
                maskTextInputs = bool(json, "maskTextInputs") ?: base.maskTextInputs,
                screenshotPrompt = bool(json, "screenshotPrompt") ?: base.screenshotPrompt,
                message = message,
            )
        }

        private fun bool(o: JSONObject, key: String): Boolean? = if (!o.isNull(key)) o.opt(key) as? Boolean else null

        private fun str(o: JSONObject, key: String): String? = if (!o.isNull(key)) o.opt(key) as? String else null

        private fun num(o: JSONObject, key: String, min: Double, max: Double): Double? {
            if (o.isNull(key)) return null
            val d = (o.opt(key) as? Number)?.toDouble() ?: return null
            return if (d.isNaN() || d < min || d > max) null else d
        }
    }
}
