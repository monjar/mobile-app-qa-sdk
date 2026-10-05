/*
 * Zero-code autostart (spec §8.2): a ContentProvider runs before
 * Application.onCreate, so Snitch can wrap the first activity's window. It only
 * starts the SDK when the app's manifest has the SERVER_URL meta-data; apps
 * that want to start from code can remove it with tools:node="remove".
 * Registration is cheap: config reads and network work happen off the main thread.
 */
package io.github.monjar.snitch

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import io.github.monjar.snitch.config.ManifestConfigReader

class SnitchInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val ctx = context ?: return true
        try {
            val md = ManifestConfigReader.metaData(ctx)
            if (md != null && md.containsKey(ManifestConfigReader.KEY_SERVER_URL)) Snitch.start(ctx)
        } catch (e: Throwable) {
            // Never crash the host app at startup.
            SnitchLog.warn("autostart failed", e)
        }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
