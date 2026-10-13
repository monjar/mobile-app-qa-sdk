/*
 * The crash follow-up's uncaught-exception handler (spec §11.8): chained in
 * front of the default handler (Android's, or another crash reporter's), it
 * writes the thread name and stack trace — causes included, at most 256 KB —
 * to the crash store synchronously, then always hands the exception to the
 * previous handler, which ends the process as before.
 *
 * It never throws and never swallows the crash: whatever happens while writing,
 * the previous handler runs. Installed once per process; while Snitch is off
 * (or the crash prompt is), `store` is null and it only forwards.
 */
package io.github.monjar.snitch.crash

import android.os.Process
import io.github.monjar.snitch.logic.CrashText
import io.github.monjar.snitch.report.Iso8601
import kotlin.system.exitProcess

internal class CrashHandler private constructor(private val previous: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
    /** Where to save crashes; null while not recording. */
    @Volatile
    var store: CrashStore? = null

    override fun uncaughtException(thread: Thread, error: Throwable) {
        try {
            val s = store
            if (s != null) {
                val now = System.currentTimeMillis()
                val pid = Process.myPid()
                @Suppress("DEPRECATION") // Thread.getId: deprecated in newer JDKs, but threadId() is missing on older Android.
                val threadId = thread.id
                s.add(KIND_JAVA, now, pid, CrashText.forThrowable(thread.name, threadId, Iso8601.format(now), pid, error))
            }
        } catch (_: Throwable) {
            // Never let the report get in the way of the crash.
        } finally {
            val p = previous
            if (p != null) {
                p.uncaughtException(thread, error)
            } else {
                // What Android's own default handler does.
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }
        }
    }

    companion object {
        const val KIND_JAVA = "java"

        @Volatile
        private var installed: CrashHandler? = null

        /** Chains the handler in front of the current default one, once per process. */
        fun install(): CrashHandler = synchronized(this) {
            installed ?: CrashHandler(Thread.getDefaultUncaughtExceptionHandler()).also {
                Thread.setDefaultUncaughtExceptionHandler(it)
                installed = it
            }
        }
    }
}
