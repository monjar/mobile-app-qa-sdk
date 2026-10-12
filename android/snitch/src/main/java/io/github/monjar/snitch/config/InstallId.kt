/*
 * The check-in installId (spec §11.1): a random UUID v4 created on first
 * activation and kept in the SDK's SharedPreferences (`snitch`, key
 * `installId`). Not derived from any device identifier; a reinstall (or
 * cleared app data) gets a new one. Every config fetch and every report carries
 * it, so the server's Devices page can link an install to its reports.
 */
package io.github.monjar.snitch.config

import io.github.monjar.snitch.report.ReportBuilder
import java.util.UUID

internal object InstallId {
    const val KEY = "installId"

    /** The stored id, or a new one (stored before it is returned). Blocking prefs read: not on the main thread. */
    @Synchronized
    fun getOrCreate(store: KeyValueStore): String {
        store.getString(KEY)?.trim()?.lowercase()?.takeIf { ReportBuilder.isValidUuid(it) }?.let { return it }
        val id = UUID.randomUUID().toString()
        store.putString(KEY, id)
        return id
    }
}
