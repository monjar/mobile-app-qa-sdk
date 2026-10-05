/*
 * Remote config parsing (lenient merge over DEFAULT_SDK_CONFIG) and the
 * effective-settings rule: remote on top of static, except that remote config
 * can only restrict captureMode.
 */
package io.github.monjar.snitch.config

import io.github.monjar.snitch.SnitchCaptureMode
import io.github.monjar.snitch.SnitchOptions
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
}
