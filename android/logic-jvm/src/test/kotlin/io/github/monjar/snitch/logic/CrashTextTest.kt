/*
 * The `crash` attachment's text: uncaught exceptions with their causes, size
 * caps that never split a character, and binary tombstones reduced to their
 * printable strings.
 */
package io.github.monjar.snitch.logic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CrashTextTest {
    @Test
    fun `an uncaught exception keeps its causes`() {
        val error = IllegalStateException("outer", IllegalArgumentException("inner"))
        val text = CrashText.forThrowable("main", 2, "2026-10-13T09:00:00.000Z", 4242, error)
        assertTrue(text.startsWith("Uncaught exception in thread \"main\" (id 2)\nTime: 2026-10-13T09:00:00.000Z\nPid: 4242\n\n"))
        assertTrue(text.contains("java.lang.IllegalStateException: outer"))
        assertTrue(text.contains("Caused by: java.lang.IllegalArgumentException: inner"))
        assertTrue(text.contains("\tat "))
    }

    @Test
    fun `long text is cut on a character boundary`() {
        val text = "ü".repeat(200_000) // 400 000 bytes
        val cut = CrashText.capUtf8(text, CrashText.JAVA_MAX_BYTES)
        val bytes = cut.toByteArray(Charsets.UTF_8)
        assertTrue(bytes.size <= CrashText.JAVA_MAX_BYTES, "${bytes.size}")
        assertTrue(bytes.size > CrashText.JAVA_MAX_BYTES - 64)
        assertTrue(cut.endsWith("(cut at 256 KB)\n"))
        assertEquals(cut, String(bytes, Charsets.UTF_8))
        assertEquals("short", CrashText.capUtf8("short", 10))
        val emoji = "😀".repeat(100)
        assertFalse(CrashText.capUtf8(emoji, 100).contains('�'))
    }

    @Test
    fun `text traces are kept, binary ones reduced to printable strings`() {
        val anr = "----- pid 4242 at 2026-10-13 -----\nCmd line: com.example\n\"main\" prio=5 tid=1 Blocked\n".toByteArray()
        val anrText = CrashText.forExit("anr", "2026-10-13T09:00:00.000Z", 4242, "com.example", "user request after error: Input dispatching timed out", anr)
        assertTrue(anrText.startsWith("Application not responding (ANR)\n"))
        assertTrue(anrText.contains("Description: user request after error: Input dispatching timed out\n"))
        assertTrue(anrText.endsWith("\"main\" prio=5 tid=1 Blocked\n"))

        val tombstone = byteArrayOf(0x0A, 0x05) + "arm64".toByteArray() + byteArrayOf(0x12, 0x00, 0x01) +
            "Abort message: 'boom'".toByteArray() + byteArrayOf(0x1A, 0x02, 0x08) + "libc.so".toByteArray() + byteArrayOf(0x00, 0x7F, 0x01)
        assertFalse(CrashText.looksLikeText(tombstone))
        val native = CrashText.forExit("native", "2026-10-13T09:00:00.000Z", 4242, null, null, tombstone)
        assertTrue(native.startsWith("Native crash\n"))
        assertTrue(native.contains("(binary trace; printable strings follow)\narm64\nAbort message: 'boom'\nlibc.so\n"))
        assertFalse(native.contains('\u0000'))
    }

    @Test
    fun `printable strings need a minimum length`() {
        val bytes = "ab".toByteArray() + byteArrayOf(0) + "abcd".toByteArray() + byteArrayOf(1) + "xyz".toByteArray()
        assertEquals("abcd\n", CrashText.printableStrings(bytes))
        assertTrue(CrashText.looksLikeText("line\r\n\tindented\n".toByteArray()))
    }
}
