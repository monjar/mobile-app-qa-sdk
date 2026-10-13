/*
 * Remote config parsing (lenient merge over DEFAULT_SDK_CONFIG) and the
 * effective-settings rule: remote on top of static, except that remote config
 * can only restrict captureMode — and the 0.3 switches (timeline, crash
 * prompt), which are static AND remote. Also the check-in installId.
 */
package io.github.monjar.snitch.config

import io.github.monjar.snitch.SnitchCaptureMode
import io.github.monjar.snitch.SnitchOptions
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SdkConfigTest {
    private val contractDir = File(System.getProperty("snitch.contractDir") ?: "../../contract")

    @Test
    fun `the contract fixture parses to the default config`() {
        val parsed = SdkConfig.parse(JSONObject(File(contractDir, "fixtures/sdk-config.json").readText()))
        assertEquals(SdkConfig.DEFAULT, parsed)
    }

    @Test
    fun `partial and invalid fields fall back to the base`() {
        val json = JSONObject(
            """{"enabled": false, "ttlSeconds": 5, "video": {"maxSeconds": 10, "idleFps": 99, "captureMode": "warp"},
               "reportTypes": [{"id": "Bad Id", "label": "x"}], "message": "Hi", "future": {"x": 1}}""",
        )
        val c = SdkConfig.parse(json)
        assertFalse(c.enabled)
        assertEquals(3600L, c.ttlSeconds)
        assertEquals(10, c.video.maxSeconds)
        assertEquals(1.0, c.video.idleFps, 0.0)
        assertEquals("snapshot", c.video.captureMode)
        assertEquals(SdkConfig.DEFAULT.reportTypes, c.reportTypes)
        assertEquals("Hi", c.message)
        assertNull(SdkConfig.parse(JSONObject("""{"message": null}"""), c).message)
    }

    @Test
    fun `static options apply until remote config arrives`() {
        val e = EffectiveConfig.resolve(SnitchOptions(captureMode = SnitchCaptureMode.OFF, videoMaxSeconds = 12, maskTextInputs = false), null)
        assertEquals(SnitchCaptureMode.OFF, e.captureMode)
        assertEquals(12, e.videoMaxSeconds)
        assertFalse(e.maskTextInputs)
        assertEquals(EffectiveConfig.ANDROID_ACTIVE_FPS, e.activeFps, 0.0)
    }

    @Test
    fun `remote config can only restrict captureMode`() {
        fun mode(static: SnitchCaptureMode, remote: String, enabled: Boolean = true): SnitchCaptureMode {
            val r = SdkConfig.parse(JSONObject().put("video", JSONObject().put("captureMode", remote).put("enabled", enabled)))
            return EffectiveConfig.resolve(SnitchOptions(captureMode = static), r).captureMode
        }
        assertEquals(SnitchCaptureMode.SNAPSHOT, mode(SnitchCaptureMode.SNAPSHOT, "system"))
        assertEquals(SnitchCaptureMode.OFF, mode(SnitchCaptureMode.OFF, "snapshot"))
        assertEquals(SnitchCaptureMode.OFF, mode(SnitchCaptureMode.OFF, "system"))
        assertEquals(SnitchCaptureMode.SNAPSHOT, mode(SnitchCaptureMode.SYSTEM, "snapshot"))
        assertEquals(SnitchCaptureMode.SYSTEM, mode(SnitchCaptureMode.SYSTEM, "system"))
        assertEquals(SnitchCaptureMode.OFF, mode(SnitchCaptureMode.SNAPSHOT, "off"))
        assertEquals(SnitchCaptureMode.OFF, mode(SnitchCaptureMode.SYSTEM, "system", enabled = false))
    }

    @Test
    fun `remote values win for everything else`() {
        val r = SdkConfig.parse(JSONObject().put("maskTextInputs", true).put("video", JSONObject().put("maxSeconds", 20).put("activeFps", 6)))
        val e = EffectiveConfig.resolve(SnitchOptions(maskTextInputs = false, videoMaxSeconds = 5), r)
        assertEquals(20, e.videoMaxSeconds)
        assertEquals(true, e.maskTextInputs)
        assertEquals(6.0, e.activeFps, 0.0)
    }

    @Test
    fun `timeline, crashPrompt and features parse leniently`() {
        val features = org.json.JSONArray().put("resumable-upload").put("trigger-crash").put(7).put("").put("x".repeat(41))
        val json = JSONObject()
            .put("timeline", JSONObject().put("network", false).put("console", "yes"))
            .put("crashPrompt", false)
            .put("features", features)
        val c = SdkConfig.parse(json)
        assertEquals(TimelineSettings(console = true, network = false, screens = true), c.timeline)
        assertFalse(c.crashPrompt)
        assertEquals(listOf("resumable-upload", "trigger-crash"), c.features)
        assertTrue(c.hasFeature(SdkConfig.FEATURE_TRIGGER_CRASH))
        assertFalse(c.hasFeature("timeline"))
    }

    @Test
    fun `an older server's config still parses, without features`() {
        val old = JSONObject(File(contractDir, "fixtures/sdk-config.json").readText())
        old.remove("timeline")
        old.remove("crashPrompt")
        val c = SdkConfig.parse(old)
        assertEquals(SdkConfig.DEFAULT.timeline, c.timeline)
        assertTrue(c.crashPrompt)
        assertNull(c.features)
        assertFalse(c.hasFeature(SdkConfig.FEATURE_TRIGGER_CRASH))
        // features describe the answering server: never inherited from the base.
        val withFeatures = SdkConfig.parse(JSONObject().put("features", org.json.JSONArray().put("timeline")))
        assertNull(SdkConfig.parse(JSONObject(), withFeatures).features)
    }

    @Test
    fun `timeline switches and the crash prompt are static AND remote`() {
        val static = SnitchOptions()
        val local = EffectiveConfig.resolve(static, null)
        assertTrue(local.captureConsole)
        assertFalse(local.captureNetwork) // off unless the app opts in
        assertTrue(local.trackScreens)
        assertTrue(local.crashPrompt)
        assertTrue(local.features.isEmpty())

        val optIn = SnitchOptions(captureNetwork = true)
        val remoteAllOn = SdkConfig.parse(JSONObject().put("features", org.json.JSONArray().put("trigger-crash")))
        val on = EffectiveConfig.resolve(optIn, remoteAllOn)
        assertTrue(on.captureNetwork)
        assertEquals(setOf("trigger-crash"), on.features)

        val remoteOff = SdkConfig.parse(
            JSONObject().put("timeline", JSONObject().put("console", false).put("network", false).put("screens", false)).put("crashPrompt", false),
        )
        val off = EffectiveConfig.resolve(optIn, remoteOff)
        assertFalse(off.captureConsole)
        assertFalse(off.captureNetwork)
        assertFalse(off.trackScreens)
        assertFalse(off.crashPrompt)

        // The remote config can't switch on what the app left off.
        val staticOff = SnitchOptions(captureConsole = false, captureNetwork = false, trackScreens = false, crashPrompt = false)
        val stillOff = EffectiveConfig.resolve(staticOff, remoteAllOn)
        assertFalse(stillOff.captureConsole || stillOff.captureNetwork || stillOff.trackScreens || stillOff.crashPrompt)
    }

    @Test
    fun `options from a map include the timeline and crash switches`() {
        val o = SnitchOptions.fromMap(
            mapOf("captureConsole" to false, "captureNetwork" to true, "trackScreens" to false, "crashPrompt" to false, "checkInWhenInactive" to true),
        )
        assertFalse(o.captureConsole)
        assertTrue(o.captureNetwork)
        assertFalse(o.trackScreens)
        assertFalse(o.crashPrompt)
        assertTrue(o.checkInWhenInactive)
        val d = SnitchOptions.fromMap(emptyMap())
        assertEquals(SnitchOptions(), d)
        assertFalse(d.captureNetwork)
        assertFalse(d.checkInWhenInactive)
    }

    @Test
    fun `the installId is a stored UUID v4`() {
        val values = HashMap<String, String?>()
        val store = object : KeyValueStore {
            override fun getString(key: String): String? = values[key]

            override fun putString(key: String, value: String?) {
                values[key] = value
            }
        }
        val id = InstallId.getOrCreate(store)
        assertTrue(id, Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(id))
        assertEquals(id, values[InstallId.KEY])
        assertEquals(id, InstallId.getOrCreate(store))
        values[InstallId.KEY] = "not-a-uuid"
        val fresh = InstallId.getOrCreate(store)
        assertNotEquals("not-a-uuid", fresh)
        assertEquals(fresh, values[InstallId.KEY])
    }
}
