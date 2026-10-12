/*
 * Exits the system recorded for this app (spec §11.8), API 30+:
 * ActivityManager.getHistoricalProcessExitReasons, keeping native crashes
 * (REASON_CRASH_NATIVE) and ANRs (REASON_ANR) newer than the last one handled.
 * Java crashes are not taken from here: the uncaught-exception handler already
 * saved them with their stack trace.
 *
 * Each becomes the description plus the first 512 KB of traceInputStream: the
 * ANR's thread dump, or on Android 12+ the native crash's tombstone (protobuf,
 * reduced to its printable strings by CrashText). One binder call at launch,
 * on the SDK's I/O thread.
 */
package io.github.monjar.snitch.crash

import android.annotation.TargetApi
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import io.github.monjar.snitch.SnitchLog
import io.github.monjar.snitch.logic.CrashText
import io.github.monjar.snitch.report.Iso8601
import java.io.IOException
import java.io.InputStream

internal object ExitReasons {
    class Exit(val kind: String, val time: Long, val pid: Int, val text: String)

    private const val MAX_EXITS = 16

    /** Native crashes and ANRs recorded after [since] (epoch ms), newest first; empty before API 30. */
    fun newerThan(context: Context, since: Long): List<Exit> =
        if (Build.VERSION.SDK_INT >= 30) read30(context, since) else emptyList()

    @TargetApi(30)
    private fun read30(context: Context, since: Long): List<Exit> {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return emptyList()
        val infos = try {
            am.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS)
        } catch (e: RuntimeException) {
            SnitchLog.warnOnce("exit-reasons", "cannot read the app's exit reasons", e)
            return emptyList()
        }
        val out = ArrayList<Exit>()
        for (info in infos) {
            if (info.timestamp <= since) continue
            val kind = when (info.reason) {
                ApplicationExitInfo.REASON_CRASH_NATIVE -> "native"
                ApplicationExitInfo.REASON_ANR -> "anr"
                else -> continue
            }
            val trace = try {
                info.traceInputStream?.use { readUpTo(it, CrashText.TRACE_MAX_BYTES) }
            } catch (e: IOException) {
                null
            }
            val text = CrashText.forExit(kind, Iso8601.format(info.timestamp), info.pid, info.processName, info.description, trace)
            out.add(Exit(kind, info.timestamp, info.pid, text))
        }
        return out
    }

    private fun readUpTo(input: InputStream, max: Int): ByteArray {
        val buf = ByteArray(max)
        var n = 0
        while (n < max) {
            val r = input.read(buf, n, max - n)
            if (r < 0) break
            n += r
        }
        return buf.copyOf(n)
    }
}
