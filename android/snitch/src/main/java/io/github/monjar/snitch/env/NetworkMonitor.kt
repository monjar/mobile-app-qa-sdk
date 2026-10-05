/*
 * Tracks the default network with ConnectivityManager.NetworkCallback (API 24+)
 * so reports can say wifi/cellular/… and the outbox can be flushed the moment
 * the network comes back (spec §7.3 step 5). Callbacks arrive on a binder
 * thread; we only store a value and invoke the "became available" hook, which
 * the runtime forwards to its I/O thread.
 */
package io.github.monjar.snitch.env

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import io.github.monjar.snitch.SnitchLog

internal class NetworkMonitor(context: Context, private val onNetworkAvailable: () -> Unit) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    @Volatile
    var networkType: String = "unknown"
        private set

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            onNetworkAvailable()
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            val wasOffline = networkType == "none"
            networkType = classify(caps)
            if (wasOffline && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) onNetworkAvailable()
        }

        override fun onLost(network: Network) {
            networkType = "none"
        }
    }

    fun start() {
        val cm = cm ?: return
        try {
            networkType = cm.getNetworkCapabilities(cm.activeNetwork)?.let(::classify) ?: "none"
            cm.registerDefaultNetworkCallback(callback)
        } catch (e: Exception) {
            // SecurityException without ACCESS_NETWORK_STATE (manifest merge removed it), or OEM bugs.
            SnitchLog.warnOnce("network-monitor", "network monitoring unavailable", e)
        }
    }

    fun stop() {
        try {
            cm?.unregisterNetworkCallback(callback)
        } catch (_: Exception) {
        }
    }

    private fun classify(caps: NetworkCapabilities): String = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
    }
}
