/*
 * Builds the report's `app` and `device` sections (contract DeviceInfo /
 * AppInfo) at send time. Memory uses ActivityManager.MemoryInfo plus the app's
 * own heap counters — deliberately not Debug.getPss(), which can take hundreds
 * of milliseconds. Screen size is in dp, like iOS points.
 */
package io.github.monjar.snitch.env

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Debug
import android.view.accessibility.AccessibilityManager
import io.github.monjar.snitch.logic.ThermalState
import io.github.monjar.snitch.report.AppInfo
import io.github.monjar.snitch.report.DeviceSnapshot
import io.github.monjar.snitch.report.MemoryInfo
import io.github.monjar.snitch.report.ScreenInfo
import java.util.Locale
import java.util.TimeZone

internal class DeviceInfoCollector(
    private val context: Context,
    private val power: PowerMonitor?,
    private val network: NetworkMonitor?,
) {
    fun app(releaseType: String): AppInfo {
        val pm = context.packageManager
        val pkg = packageInfo(pm)
        val build = if (pkg == null) {
            "0"
        } else if (Build.VERSION.SDK_INT >= 28) {
            pkg.longVersionCode.toString()
        } else {
            @Suppress("DEPRECATION")
            pkg.versionCode.toString()
        }
        val name = try {
            context.applicationInfo.loadLabel(pm).toString()
        } catch (_: Exception) {
            null
        }
        return AppInfo(
            id = context.packageName,
            name = name,
            version = pkg?.versionName?.takeIf { it.isNotBlank() } ?: "0",
            build = build,
            releaseType = releaseType,
        )
    }

    fun device(): DeviceSnapshot {
        val res = context.resources
        val metrics = res.displayMetrics
        val config = res.configuration
        val density = metrics.density.toDouble().takeIf { it > 0 } ?: 1.0
        val (battery, charging) = power?.battery() ?: (null to null)
        return DeviceSnapshot(
            osVersion = Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(),
            model = Build.MODEL ?: "unknown",
            manufacturer = Build.MANUFACTURER,
            locale = Locale.getDefault().toString(),
            timeZone = TimeZone.getDefault().id,
            screen = ScreenInfo(
                width = round1(metrics.widthPixels / density),
                height = round1(metrics.heightPixels / density),
                scale = density,
                orientation = if (config.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait",
            ),
            memory = memory(),
            thermal = power?.thermal?.let(::thermalWire),
            lowPower = power?.lowPower,
            battery = battery,
            charging = charging,
            network = network?.networkType ?: "unknown",
            darkMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES,
            screenReader = isScreenReaderOn(context),
            fontScale = config.fontScale.toDouble().takeIf { it > 0 },
        )
    }

    private fun memory(): MemoryInfo {
        val mb = 1024L * 1024L
        val rt = Runtime.getRuntime()
        val appBytes = (rt.totalMemory() - rt.freeMemory()) + Debug.getNativeHeapAllocatedSize()
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val info = ActivityManager.MemoryInfo()
        val ok = try {
            am?.getMemoryInfo(info)
            am != null
        } catch (_: Exception) {
            false
        }
        return MemoryInfo(
            appMB = appBytes / mb,
            freeMB = if (ok) info.availMem / mb else null,
            totalMB = if (ok) info.totalMem / mb else null,
        )
    }

    private fun packageInfo(pm: PackageManager): PackageInfo? = try {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, 0)
        }
    } catch (_: Exception) {
        null
    }

    private fun round1(v: Double) = Math.round(v * 10.0) / 10.0

    companion object {
        fun thermalWire(t: ThermalState): String = t.name.lowercase(Locale.ROOT)

        /** TalkBack-style screen readers turn on touch exploration; UiAutomation and other a11y services don't. */
        fun isScreenReaderOn(context: Context): Boolean {
            val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager ?: return false
            return am.isEnabled && am.isTouchExplorationEnabled
        }
    }
}
