/*
 * End to end with a real server (CI: scripts/ci-start-server.sh on the host,
 * reached from the emulator at 10.0.2.2:8080). Points the SDK at it through the
 * debug overrides (spec §9), lets it record a few seconds of the animated
 * screen with some taps, then waits until the debug auto-report — screenshot +
 * up to 5 s of video, description "autoreport" — has been uploaded and
 * completed. The CI job then fetches it with scripts/ci-await-report.mjs and
 * checks the MP4 with scripts/verify-video.sh.
 *
 * The report also carries a timeline (spec §11.3): the app events, the screen
 * MainActivity names ("Example"), its log line and this test's, its one
 * request (localhost:8080/health), the taps below and this process's logcat.
 * The CI server takes chunks of 64 KiB, so the screenshot and the video go up
 * as resumable chunked uploads (spec §11.2).
 */
package io.github.monjar.snitch.example

import android.content.Intent
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import io.github.monjar.snitch.Snitch
import io.github.monjar.snitch.SnitchDebugOverrides
import org.junit.Assert.assertTrue
import org.junit.Test

class AutoReportTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun autoReportReachesTheServer() {
        val intent = Intent(instrumentation.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        val activity = instrumentation.startActivitySync(intent) as MainActivity
        instrumentation.waitForIdleSync()
        assertTrue(Snitch.isEnabled)

        Snitch.log("autoreport test starting")
        Snitch.setMetadata("ci", "android-emulator")
        Snitch.debugOverrides(
            SnitchDebugOverrides(
                serverUrl = SERVER,
                ingestKey = INGEST_KEY,
                autoReportAfterSeconds = AUTOREPORT_AFTER_S,
                // Its card would otherwise take the taps below that land at the bottom of the screen.
                hideTesterNotice = true,
            ),
        )

        // Interact while the clip is being recorded, so it has touches and changing frames.
        val until = SystemClock.uptimeMillis() + (AUTOREPORT_AFTER_S - 1) * 1000L
        var row = 0
        while (SystemClock.uptimeMillis() < until) {
            Touches.tap(Touches.centerOf(activity.rows[row % 6]))
            row++
            SystemClock.sleep(600)
        }

        assertTrue(
            "the auto-report was not uploaded to $SERVER (is the server running and reachable from the emulator?)",
            Snitch.debugAwaitIdle(UPLOAD_TIMEOUT_MS),
        )
        instrumentation.runOnMainSync { activity.finish() }
    }

    companion object {
        private const val SERVER = "http://10.0.2.2:8080"
        private const val INGEST_KEY = "snitch_pk_0123456789ABCDEFGHJKMNPQRS"
        private const val AUTOREPORT_AFTER_S = 8
        private const val UPLOAD_TIMEOUT_MS = 180_000L
    }
}
