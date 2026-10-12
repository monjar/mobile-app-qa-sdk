/*
 * Gathers the Android release-type signals (spec §3) and hands them to the
 * pure classifier: FLAG_DEBUGGABLE, the installer package (InstallSourceInfo on
 * API 30+, getInstallerPackageName before) and the RELEASE_TYPE meta-data
 * override. Two binder calls at most, done once at start. The signals also go
 * out with every check-in (spec §3.1), via ReleaseTypeClassifier.signalsSummary.
 */
package io.github.monjar.snitch.env

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import io.github.monjar.snitch.SnitchReleaseType
import io.github.monjar.snitch.logic.AndroidSignals
import io.github.monjar.snitch.logic.ReleaseTypeClassifier

internal object ReleaseTypeDetector {
    fun signals(context: Context, override: String?): AndroidSignals {
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        return AndroidSignals(debuggable = debuggable, installer = installer(context), override = override)
    }

    fun classify(signals: AndroidSignals): SnitchReleaseType =
        SnitchReleaseType.fromWire(ReleaseTypeClassifier.classifyAndroid(signals)) ?: SnitchReleaseType.UNKNOWN

    private fun installer(context: Context): String? = try {
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= 30) {
            pm.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(context.packageName)
        }
    } catch (e: Exception) {
        null
    }
}
