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
}
