package io.github.monjar.snitch.rn

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import io.github.monjar.snitch.Snitch
import io.github.monjar.snitch.SnitchLogLevel
import io.github.monjar.snitch.SnitchOptions

/**
 * The `Snitch` TurboModule (JS: `TurboModuleRegistry.get('Snitch')`), a thin
 * layer over [Snitch]. Parameters are declared nullable on purpose: a bad call
 * from JavaScript must not crash the app with a Kotlin null check.
 */
@ReactModule(name = NativeSnitchSpec.NAME)
class SnitchModule(reactContext: ReactApplicationContext) : NativeSnitchSpec(reactContext) {

    init {
        SnitchReactNative.install()
    }

    override fun start(serverUrl: String?, ingestKey: String?, options: ReadableMap?) {
        if (serverUrl == null || ingestKey == null) return
        val map: Map<String, Any?> = options?.toHashMap() ?: emptyMap()
        Snitch.start(reactApplicationContext, serverUrl, ingestKey, SnitchOptions.fromMap(map))
    }

    override fun show(type: String?) {
        Snitch.show(type)
    }

    override fun setUser(userId: String?, email: String?, name: String?) {
        Snitch.setUser(userId, email, name)
    }

    override fun setMetadata(key: String?, value: String?) {
        if (key == null) return
        Snitch.setMetadata(key, value)
    }

    override fun log(message: String?, level: String?) {
        if (message == null) return
        Snitch.log(message, logLevel(level))
    }

    override fun setEnabled(enabled: Boolean) {
        Snitch.setEnabled(enabled)
    }

    override fun isEnabled(): Boolean = Snitch.isEnabled

    override fun getReleaseType(): String = Snitch.releaseType.wireValue

    private fun logLevel(level: String?): SnitchLogLevel =
        when (level?.trim()?.lowercase()) {
            "debug", "trace", "verbose" -> SnitchLogLevel.DEBUG
            "warn", "warning" -> SnitchLogLevel.WARN
            "error", "fatal" -> SnitchLogLevel.ERROR
            else -> SnitchLogLevel.INFO
        }
}
