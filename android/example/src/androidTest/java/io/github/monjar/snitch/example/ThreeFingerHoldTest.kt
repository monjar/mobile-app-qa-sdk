/*
 * The trigger gesture end to end on a device: a still three-finger hold
 * injected through UiAutomation must open the Snitch sheet, and the rows under
 * the fingers must get ACTION_CANCEL before their 600 ms long-press fires
 * (spec §4.1: screenshot, cancel, swallow until up, show).
 */
package io.github.monjar.snitch.example

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import io.github.monjar.snitch.Snitch
import io.github.monjar.snitch.SnitchReleaseType
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ThreeFingerHoldTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: MainActivity

    @Before
    fun launch() {
        val intent = Intent(instrumentation.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent) as MainActivity
        instrumentation.waitForIdleSync()
    }

    @After
    fun finish() {
        instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(300)
        instrumentation.runOnMainSync { activity.finish() }
        instrumentation.waitForIdleSync()
    }

    @Test
    fun threeFingerHoldOpensTheSheetAndCancelsTheViews() {
        assertEquals(SnitchReleaseType.DEBUG, Snitch.releaseType)
        assertTrue("Snitch should be enabled in the debug example", Snitch.isEnabled)
        // Let a frame or two reach the ring first.
        SystemClock.sleep(1500)

        val points = listOf(
            Touches.centerOf(activity.rows[0], dx = -120f),
            Touches.centerOf(activity.rows[1], dx = 0f),
            Touches.centerOf(activity.rows[2], dx = 120f),
        )
        Touches.hold(points, landingGapMs = 20, holdMs = 900)
        // Longer than the rows' 600 ms long-press: a missed cancel would show up as a long-press.
        SystemClock.sleep(PressRow.LONG_PRESS_MS + 400)

        var cancels = 0
        var longPresses = 0
        Touches.onMain(activity) {
            cancels = it.cancels
            longPresses = it.longPresses
        }
        assertTrue("the rows under the fingers should have received ACTION_CANCEL (got $cancels)", cancels >= 1)
        assertEquals("no row may see a long-press during the gesture", 0, longPresses)
        assertTrue("the Snitch report sheet should be showing", waitForText("Send", timeoutMs = 5_000))
    }

    @Test
    fun aSingleLongPressStillWorks() {
        SystemClock.sleep(1100) // past the detector's cooldown from any earlier test
        Touches.hold(listOf(Touches.centerOf(activity.rows[3])), holdMs = PressRow.LONG_PRESS_MS + 300)
        instrumentation.waitForIdleSync()
        var longPresses = 0
        Touches.onMain(activity) { longPresses = it.longPresses }
        assertEquals(1, longPresses)
        assertTrue("the sheet must not open for one finger", !waitForText("Send", timeoutMs = 1_000))
    }

    private fun waitForText(text: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            if (root != null && root.findAccessibilityNodeInfosByText(text).any { it.text?.toString() == text }) return true
            SystemClock.sleep(100)
        }
        return false
    }
}
