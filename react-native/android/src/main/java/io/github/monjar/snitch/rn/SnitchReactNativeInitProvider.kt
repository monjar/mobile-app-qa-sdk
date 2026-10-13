package io.github.monjar.snitch.rn

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * React Native's side of network capture (spec §11.5). A ContentProvider runs before
 * Application.onCreate, so React Native's OkHttp clients are built with Snitch's interceptor
 * from the first request on. It acts only when the app's manifest has
 * `io.github.monjar.snitch.CAPTURE_NETWORK` = true (the config plugin's `captureNetwork`) and
 * ENABLED isn't false; the interceptor itself stays silent until Snitch is active with network
 * capture on, so store builds never record a request.
 *
 * Starting Snitch is the core's SnitchInitProvider's job; this one never starts it.
 */
class SnitchReactNativeInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val ctx = context ?: return true
        try {
            val md = metaData(ctx)
            if (md != null && flag(md, KEY_CAPTURE_NETWORK) == true && flag(md, KEY_ENABLED) != false) {
                SnitchReactNative.installNetworkCapture(ctx)
            }
        } catch (e: Throwable) {
            // Never crash the host app at startup.
            Log.w(TAG, "network capture setup failed", e)
        }
        return true
    }

    private fun metaData(context: Context): Bundle? {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(context.packageName, PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        }
        return info.metaData
    }

    /** A boolean meta-data value, read as leniently as the core does (aapt types "true" as a Boolean). */
    @Suppress("DEPRECATION")
    private fun flag(md: Bundle, key: String): Boolean? =
        when (val v = md.get(key)) {
            is Boolean -> v
            is String -> when (v.trim().lowercase()) {
                "true", "1", "yes" -> true
                "false", "0", "no" -> false
                else -> null
            }
            is Number -> v.toInt() != 0
            else -> null
        }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    private companion object {
        const val TAG = "Snitch"
        const val KEY_ENABLED = "io.github.monjar.snitch.ENABLED"
        const val KEY_CAPTURE_NETWORK = "io.github.monjar.snitch.CAPTURE_NETWORK"
    }
}
