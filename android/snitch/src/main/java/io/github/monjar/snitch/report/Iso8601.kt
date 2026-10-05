/*
 * ISO-8601 UTC timestamps with milliseconds ("2026-10-07T13:55:02.120Z"), as
 * the contract's `reportedAt` requires. SimpleDateFormat rather than java.time
 * because minSdk is 24 and the SDK does not require core-library desugaring.
 */
package io.github.monjar.snitch.report

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object Iso8601 {
    private val formatter = object : ThreadLocal<SimpleDateFormat>() {
        override fun initialValue(): SimpleDateFormat =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    }

    fun format(epochMs: Long): String = formatter.get()!!.format(Date(epochMs))
}
