/*
 * Process-wide state the app may set before (or without) start(): the user,
 * custom metadata, the log ring, mask registrations, the wrapper name and the
 * app's runtime pause. Kept apart from SnitchRuntime so call order between the
 * autostart provider, the React Native bridge and app code never matters.
 *
 * The report timeline's recorder lives here too, so Snitch.log, setScreen and
 * the network hooks (SnitchOkHttpInterceptor may be installed before Snitch
 * starts) can reach it without a runtime. It records nothing until the runtime
 * switches it on.
 */
package io.github.monjar.snitch

import io.github.monjar.snitch.capture.MaskRegistry
import io.github.monjar.snitch.logic.TimelineRecorder
import io.github.monjar.snitch.report.LogRing

internal class UserInfo(val id: String?, val email: String?, val name: String?)

internal object SnitchState {
    const val MAX_CUSTOM_KEYS = 50

    @Volatile
    var user: UserInfo? = null
        private set

    private val metadata = LinkedHashMap<String, String>()

    val logs = LogRing(maxLines = 200, maxBytes = 256 * 1024)

    @Volatile
    var logProvider: (() -> String?)? = null

    @Volatile
    var wrapper: Pair<String, String>? = null

    /** Snitch.setEnabled: the app's own runtime pause. */
    @Volatile
    var appEnabled = true

    val masks = MaskRegistry()

    @Volatile
    var debugOverrides: SnitchDebugOverrides? = null

    val timeline = TimelineRecorder()

    /** `host:port` of the Snitch server (UrlSanitizer.origin); its requests are never recorded. */
    @Volatile
    var serverOrigin: String? = null

    /** Snitch.setScreen was called: native screen inference stops for the rest of the process. */
    @Volatile
    var appNamesScreens = false
        private set

    /** The app's latest screen name, recorded again when the runtime activates. */
    @Volatile
    var appScreen: String? = null
        private set

    fun setAppScreen(name: String?) {
        appNamesScreens = true
        val n = name?.trim()?.takeIf { it.isNotEmpty() }
        appScreen = n
        if (n == null) timeline.clearScreen() else timeline.screen(n, "app")
    }

    fun setUser(id: String?, email: String?, name: String?) {
        user = if (id == null && email == null && name == null) null else UserInfo(id, email, name)
    }

    fun setMetadata(key: String, value: String?) {
        synchronized(metadata) {
            if (value == null) {
                metadata.remove(key)
            } else if (metadata.containsKey(key) || metadata.size < MAX_CUSTOM_KEYS) {
                metadata[key] = value
            } else {
                SnitchLog.warnOnce("metadata-cap", "setMetadata: more than $MAX_CUSTOM_KEYS keys; ignoring \"$key\"")
            }
        }
    }

    fun metadataSnapshot(): Map<String, String> = synchronized(metadata) { LinkedHashMap(metadata) }
}
