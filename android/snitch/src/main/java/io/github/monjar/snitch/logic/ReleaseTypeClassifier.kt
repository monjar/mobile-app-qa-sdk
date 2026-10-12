/*
 * Release-type classifier for Android.
 *
 * Twin of classifyAndroid in contract/src/logic/releaseType.ts (the iOS
 * classifier lives only in the Swift SDK), tested against the `android`
 * section of contract/vectors/release-type.json by android/logic-jvm.
 *
 * Returns the wire value (`debug`, `internal`, `play`, …). Signals are gathered
 * by env/ReleaseTypeDetector. Google Play's internal/closed tracks install
 * through com.android.vending exactly like production, so they classify as
 * `play`; apps distinguish them with the RELEASE_TYPE override.
 *
 * [signalsSummary] is what every check-in reports (spec §3.1), so a misdetected
 * build can be diagnosed from the dashboard and turned into a vector:
 * `debuggable=0|1;installer=<package>|none;override=<value>|none`.
 */
package io.github.monjar.snitch.logic

data class AndroidSignals(
    val debuggable: Boolean,
    val installer: String?,
    /** Manifest meta-data `io.github.monjar.snitch.RELEASE_TYPE`, if the app set one. */
    val override: String?,
)

object ReleaseTypeClassifier {
    @JvmField
    val ANDROID_STORE_INSTALLERS: List<String> = listOf(
        "com.android.vending",
        "com.google.android.feedback",
        "com.amazon.venezia",
        "com.sec.android.app.samsungapps",
        "com.huawei.appmarket",
        "com.xiaomi.market",
        "com.xiaomi.mipicks",
        "com.heytap.market",
        "com.oppo.market",
        "com.vivo.appstore",
    )

    @JvmField
    val RELEASE_TYPES: Set<String> = setOf("debug", "adhoc", "enterprise", "testflight", "appstore", "internal", "play", "unknown")

    @JvmStatic
    fun classifyAndroid(s: AndroidSignals): String {
        val o = s.override?.trim()
        if (!o.isNullOrEmpty() && o in RELEASE_TYPES) return o
        if (s.debuggable) return "debug"
        if (s.installer != null && s.installer in ANDROID_STORE_INSTALLERS) return "play"
        return "internal"
    }

    /**
     * The signals as `key=value` pairs joined by `;` (spec §3.1). Values keep only
     * package-name characters, so they can never break the format; an override the
     * classifier ignored (a typo) still shows, which is the point.
     */
    @JvmStatic
    fun signalsSummary(s: AndroidSignals): String =
        "debuggable=${if (s.debuggable) 1 else 0};installer=${clean(s.installer) ?: "none"};override=${clean(s.override) ?: "none"}"

    private fun clean(value: String?): String? =
        value?.trim()?.filter { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }
            ?.take(MAX_SIGNAL_CHARS)?.ifEmpty { null }

    private const val MAX_SIGNAL_CHARS = 100
}
