/*
 * Low-power and thermal state for the capture governor (spec §5.2) and the
 * report's device section. Values are cached from broadcasts / listeners so
 * the per-frame governor call never makes a binder call on the main thread.
 *
 * Thermal mapping (PowerManager.THERMAL_STATUS_*, API 29+):
 * NONE → nominal, LIGHT/MODERATE → fair, SEVERE → serious, CRITICAL+ → critical.
 */
package io.github.monjar.snitch.env

import android.annotation.TargetApi
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import io.github.monjar.snitch.logic.ThermalState

internal class PowerMonitor(private val context: Context, private val onChange: () -> Unit) {
    private val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager

    @Volatile
    var lowPower: Boolean = false
        private set

    @Volatile
    var thermal: ThermalState = ThermalState.NOMINAL
        private set

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            lowPower = pm?.isPowerSaveMode ?: false
            onChange()
        }
    }

    private var thermalListener: Any? = null

    fun start() {
        lowPower = pm?.isPowerSaveMode ?: false
        try {
            val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(receiver, filter)
            }
        } catch (_: Exception) {
        }
        if (Build.VERSION.SDK_INT >= 29) startThermal()
    }

    @TargetApi(29)
    private fun startThermal() {
        val pm = pm ?: return
        thermal = map(pm.currentThermalStatus)
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
            thermal = map(status)
            onChange()
        }
        try {
            pm.addThermalStatusListener(context.mainExecutor, listener)
            thermalListener = listener
        } catch (_: Exception) {
        }
    }

    fun stop() {
        try {
            context.unregisterReceiver(receiver)
        } catch (_: Exception) {
        }
        if (Build.VERSION.SDK_INT >= 29) stopThermal()
    }

    @TargetApi(29)
    private fun stopThermal() {
        val l = thermalListener as? PowerManager.OnThermalStatusChangedListener ?: return
        try {
            pm?.removeThermalStatusListener(l)
        } catch (_: Exception) {
        }
        thermalListener = null
    }

    /** Battery level 0..1 and charging, read on demand (report time only). */
    fun battery(): Pair<Double?, Boolean?> {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null to null
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }?.let { it / 100.0 }
        return level to bm.isCharging
    }

    private fun map(status: Int): ThermalState = when {
        status <= PowerManager.THERMAL_STATUS_NONE -> ThermalState.NOMINAL
        status <= PowerManager.THERMAL_STATUS_MODERATE -> ThermalState.FAIR
        status == PowerManager.THERMAL_STATUS_SEVERE -> ThermalState.SERIOUS
        else -> ThermalState.CRITICAL
    }
}
