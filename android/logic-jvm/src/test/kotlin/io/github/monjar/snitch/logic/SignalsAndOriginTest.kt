/*
 * The check-in signals string (spec §3.1) and the request origin used to keep
 * the Snitch server's own requests out of the timeline.
 */
package io.github.monjar.snitch.logic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SignalsAndOriginTest {
    @Test
    fun `signals list the classifier's inputs in order`() {
        assertEquals(
            "debuggable=1;installer=none;override=none",
            ReleaseTypeClassifier.signalsSummary(AndroidSignals(debuggable = true, installer = null, override = null)),
        )
        assertEquals(
            "debuggable=0;installer=com.android.vending;override=internal",
            ReleaseTypeClassifier.signalsSummary(AndroidSignals(debuggable = false, installer = "com.android.vending", override = " internal ")),
        )
        // A typo the classifier ignored still shows; separators can't sneak in.
        assertEquals(
            "debuggable=0;installer=none;override=interal",
            ReleaseTypeClassifier.signalsSummary(AndroidSignals(debuggable = false, installer = "", override = "inter;al=")),
        )
        val long = ReleaseTypeClassifier.signalsSummary(AndroidSignals(false, "a".repeat(500), "b".repeat(500)))
        assertTrue(long.length <= 300, "${long.length}")
    }

    @Test
    fun `origin is host and port with defaults filled in`() {
        assertEquals("10.0.2.2:8080", UrlSanitizer.origin("http://10.0.2.2:8080"))
        assertEquals("snitch.example.com:443", UrlSanitizer.origin("https://Snitch.Example.com/api/v1/reports?x=1"))
        assertEquals("snitch.example.com:80", UrlSanitizer.origin("http://user:pw@snitch.example.com#frag"))
        assertEquals("[::1]:8080", UrlSanitizer.origin("http://[::1]:8080/health"))
        assertEquals("[::1]:80", UrlSanitizer.origin("http://[::1]/health"))
        assertEquals("a.example:443", UrlSanitizer.origin(" https://a.example:/x "))
        assertNull(UrlSanitizer.origin("ftp://a.example"))
        assertNull(UrlSanitizer.origin("https:///nohost"))
        assertNull(UrlSanitizer.origin("not a url"))
    }
}
