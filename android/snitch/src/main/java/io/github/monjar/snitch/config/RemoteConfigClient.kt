/*
 * Remote configuration (spec §2.2): `GET {ServerURL}/api/v1/sdk/config` with
 * the ingest key, cached as {json, etag, fetchedAt, server} under the key
 * `remoteConfig` of the SharedPreferences file `snitch`.
 *
 * - 200 → parse (leniently, over DEFAULT_SDK_CONFIG) and cache with the ETag
 * - 304 → refresh fetchedAt only
 * - anything else / network error → keep the cache
 * A cache written for another server URL is ignored. Blocking; runs on the
 * SDK's I/O thread. Storage is behind KeyValueStore so this is JVM-testable.
 *
 * Every fetch is also the install's check-in (spec §11.1): the runtime adds
 * installId, appId, sdkVersion, wrapper, model, signals and active=1 to the
 * query. [ping] is the opt-in CheckInWhenInactive request of an inert SDK: the
 * same GET with active=0, whose answer is ignored and never cached.
 */
package io.github.monjar.snitch.config

import io.github.monjar.snitch.report.Endpoint
import io.github.monjar.snitch.report.SnitchLogger
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

internal interface KeyValueStore {
    fun getString(key: String): String?

    fun putString(key: String, value: String?)
}

internal class RemoteConfigClient(
    private val store: KeyValueStore,
    private val logger: SnitchLogger,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    sealed class FetchResult {
        data class Updated(val config: SdkConfig) : FetchResult()

        object NotModified : FetchResult()

        data class Failed(val status: Int) : FetchResult()
    }

    @Volatile
    var current: SdkConfig? = null
        private set

    @Volatile
    private var fetchedAt = 0L

    @Volatile
    private var etag: String? = null

    /** Loads the cached config for [serverUrl], if any. */
    fun loadCache(serverUrl: String): SdkConfig? {
        val raw = store.getString(KEY) ?: return null
        return try {
            val o = JSONObject(raw)
            if (o.optString("server") != normalize(serverUrl)) return null
            val config = SdkConfig.parse(JSONObject(o.getString("json")))
            current = config
            fetchedAt = o.optLong("fetchedAt", 0)
            etag = if (o.isNull("etag")) null else o.optString("etag").ifEmpty { null }
            config
        } catch (e: Exception) {
            logger.warn("remote config: unreadable cache; ignoring", e)
            null
        }
    }

    fun isStale(): Boolean {
        val ttlMs = (current ?: SdkConfig.DEFAULT).ttlSeconds * 1000
        return current == null || clock() - fetchedAt >= ttlMs
    }

    fun fetch(ep: Endpoint, query: Map<String, String>): FetchResult {
        var conn: HttpURLConnection? = null
        try {
            conn = open(ep, query)
            val cachedTag = etag
            if (cachedTag != null && current != null) conn.setRequestProperty("If-None-Match", cachedTag)
            return when (val status = conn.responseCode) {
                200 -> {
                    val text = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                    val config = SdkConfig.parse(JSONObject(text))
                    val tag = conn.getHeaderField("ETag")
                    save(ep.baseUrl, text, tag)
                    current = config
                    FetchResult.Updated(config)
                }
                304 -> {
                    current?.let { touch(ep.baseUrl) }
                    FetchResult.NotModified
                }
                else -> {
                    if (status == 401 || status == 403) {
                        logger.warn("remote config: HTTP $status — check the ingest key and the project's allowed app ids / release types")
                    } else {
                        logger.debug("remote config: HTTP $status; keeping the cached config")
                    }
                    FetchResult.Failed(status)
                }
            }
        } catch (e: IOException) {
            logger.debug("remote config: ${e.javaClass.simpleName}: ${e.message}")
            return FetchResult.Failed(0)
        } catch (e: org.json.JSONException) {
            logger.warn("remote config: malformed response; keeping the cached config", e)
            return FetchResult.Failed(-1)
        } finally {
            conn?.disconnect()
        }
    }

    private fun save(serverUrl: String, json: String, tag: String?) {
        fetchedAt = clock()
        etag = tag
        val o = JSONObject()
            .put("json", json)
            .put("fetchedAt", fetchedAt)
            .put("server", normalize(serverUrl))
        if (tag != null) o.put("etag", tag)
        store.putString(KEY, o.toString())
    }

    private fun touch(serverUrl: String) {
        val raw = store.getString(KEY) ?: return
        try {
            val o = JSONObject(raw)
            if (o.optString("server") != normalize(serverUrl)) return
            fetchedAt = clock()
            o.put("fetchedAt", fetchedAt)
            store.putString(KEY, o.toString())
        } catch (e: org.json.JSONException) {
            store.putString(KEY, null)
        }
    }

    companion object {
        const val KEY = "remoteConfig"
        private const val TIMEOUT_MS = 30_000

        private fun normalize(url: String) = url.trim().trimEnd('/')

        private fun open(ep: Endpoint, query: Map<String, String>): HttpURLConnection {
            val qs = query.entries.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
            val conn = URL(normalize(ep.baseUrl) + "/api/v1/sdk/config?" + qs).openConnection() as HttpURLConnection
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.useCaches = false
            conn.setRequestProperty("X-Snitch-Key", ep.ingestKey)
            conn.setRequestProperty("X-Snitch-SDK", ep.sdkHeader)
            conn.setRequestProperty("User-Agent", ep.userAgent)
            conn.setRequestProperty("Accept", "application/json")
            return conn
        }

        /** The diagnostic check-in of an inert SDK: one GET, the answer read and ignored. Blocking. */
        fun ping(ep: Endpoint, query: Map<String, String>, logger: SnitchLogger) {
            var conn: HttpURLConnection? = null
            try {
                conn = open(ep, query)
                val status = conn.responseCode
                (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() }
                logger.debug("inactive check-in: HTTP $status")
            } catch (e: IOException) {
                logger.debug("inactive check-in failed: ${e.javaClass.simpleName}")
            } finally {
                conn?.disconnect()
            }
        }
    }
}
