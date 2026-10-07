/*
 * Gathers the Android release-type signals (spec §3) and hands them to the
 * pure classifier: FLAG_DEBUGGABLE, the installer package (InstallSourceInfo on
 * API 30+, getInstallerPackageName before) and the RELEASE_TYPE meta-data
 * override. Two binder calls at most, done once at start.
 */
package io.github.monjar.snitch.env

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import io.github.monjar.snitch.SnitchReleaseType
import io.github.monjar.snitch.logic.AndroidSignals
import io.github.monjar.snitch.logic.ReleaseTypeClassifier

internal object ReleaseTypeDetector {
    fun detect(context: Context, override: String?): SnitchReleaseType {
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val signals = AndroidSignals(debuggable = debuggable, installer = installer(context), override = override)
        return SnitchReleaseType.fromWire(ReleaseTypeClassifier.classifyAndroid(signals)) ?: SnitchReleaseType.UNKNOWN
    }

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
