/*
 * Optional shake trigger (spec §4.2): accelerometer at ~20 Hz while the app is
 * in the foreground; a shake is ≥ 3 direction reversals with |a| > 2.3 g
 * within 1 s.
 *
 * A "reversal" is a strong sample whose gravity-free acceleration points the
 * opposite way (negative dot product) from the previous strong sample. Gravity
 * is tracked with a low-pass filter. The counting lives in ShakeCounter, which
 * has no Android dependencies.
 */
package io.github.monjar.snitch.trigger

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.SystemClock
import kotlin.math.sqrt

internal class ShakeCounter(
    private val thresholdG: Double = 2.3,
    private val reversals: Int = 3,
    private val windowMs: Long = 1000,
    private val cooldownMs: Long = 1500,
) {
    private val gravity = DoubleArray(3)
    private var gravityReady = false
    private var lastDir: DoubleArray? = null
    private val reversalTimes = ArrayDeque<Long>()
    private var lastFire = Long.MIN_VALUE / 2

    /** [x], [y], [z] in g. Returns true when a shake completes. */
    fun onSample(t: Long, x: Double, y: Double, z: Double): Boolean {
        if (!gravityReady) {
            gravity[0] = x
            gravity[1] = y
            gravity[2] = z
            gravityReady = true
        } else {
            gravity[0] = 0.9 * gravity[0] + 0.1 * x
            gravity[1] = 0.9 * gravity[1] + 0.1 * y
            gravity[2] = 0.9 * gravity[2] + 0.1 * z
        }
        val magnitude = sqrt(x * x + y * y + z * z)
        if (magnitude <= thresholdG) return false
        val dir = doubleArrayOf(x - gravity[0], y - gravity[1], z - gravity[2])
        val prev = lastDir
        lastDir = dir
        if (prev == null || dir[0] * prev[0] + dir[1] * prev[1] + dir[2] * prev[2] >= 0) return false
        reversalTimes.addLast(t)
        while (reversalTimes.isNotEmpty() && t - reversalTimes.first() > windowMs) reversalTimes.removeFirst()
        if (reversalTimes.size >= reversals && t - lastFire >= cooldownMs) {
            reversalTimes.clear()
            lastDir = null
            lastFire = t
            return true
        }
        return false
    }
}

internal class ShakeDetector(context: Context, private val handler: Handler, private val onShake: () -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val accelerometer = sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val counter = ShakeCounter()
    private var running = false

    fun start() {
        if (running || accelerometer == null) return
        running = sensors?.registerListener(this, accelerometer, SAMPLING_US, handler) == true
    }

    fun stop() {
        if (!running) return
        running = false
        sensors?.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val g = SensorManager.GRAVITY_EARTH.toDouble()
        val v = event.values
        if (counter.onSample(SystemClock.uptimeMillis(), v[0] / g, v[1] / g, v[2] / g)) onShake()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    companion object {
        private const val SAMPLING_US = 50_000 // 20 Hz
    }
}
