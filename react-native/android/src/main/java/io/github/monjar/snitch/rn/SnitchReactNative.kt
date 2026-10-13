package io.github.monjar.snitch.rn

import android.content.Context
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import io.github.monjar.snitch.BuildConfig
import io.github.monjar.snitch.Snitch
import io.github.monjar.snitch.network.SnitchOkHttpInterceptor
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Cache
import okhttp3.OkHttpClient

/** React Native specifics of the core SDK, installed once per process. */
internal object SnitchReactNative {
    /** A view whose testID starts with this is masked in screenshots and video (spec §5.5). */
    const val MASK_TEST_ID_PREFIX = "snitch-mask"

    private val installed = AtomicBoolean(false)
    private val networkInstalled = AtomicBoolean(false)

    fun install() {
        if (!installed.compareAndSet(false, true)) return
        Snitch.setWrapper("react-native", BuildConfig.SNITCH_RN_VERSION)
        // React Native stores `testID` as a keyed view tag (BaseViewManager.setTestId).
        Snitch.addMaskPredicate { view ->
            (view.getTag(com.facebook.react.R.id.react_test_id) as? String)?.startsWith(MASK_TEST_ID_PREFIX) == true
        }
    }

    /**
     * Puts [SnitchOkHttpInterceptor] into the OkHttp clients React Native's OkHttpClientProvider
     * makes (spec §11.5): fetch / XMLHttpRequest (NetworkingModule), image loads (Fresco), and
     * libraries that start from it, such as expo/fetch. Must run before React Native creates
     * those clients, i.e. from [SnitchReactNativeInitProvider].
     *
     * An app that calls OkHttpClientProvider.setOkHttpClientFactory itself replaces this factory
     * (the last call wins); adding `SnitchOkHttpInterceptor()` to its builder (addInterceptor)
     * keeps the requests in the timeline.
     */
    fun installNetworkCapture(context: Context) {
        if (!networkInstalled.compareAndSet(false, true)) return
        OkHttpClientProvider.setOkHttpClientFactory(SnitchOkHttpClientFactory(context.applicationContext ?: context))
    }
}

/**
 * React Native's own client (OkHttpClientProvider.createClientBuilder: no timeouts, a cookie jar
 * container, the HTTP cache in cacheDir/http-cache) plus Snitch's interceptor, which records
 * nothing unless Snitch is active with network capture on. It is an application interceptor, as
 * the interceptor expects: one event per call, with its final status, cache hits included.
 *
 * A factory replaces every OkHttpClientProvider.createClient call, with or without a context, so
 * the clients made here share the one Cache the first builder creates: OkHttp must not have two
 * Cache instances on the same directory.
 */
private class SnitchOkHttpClientFactory(private val context: Context) : OkHttpClientFactory {
    private var cache: Cache? = null

    @Synchronized
    override fun createNewNetworkModuleClient(): OkHttpClient {
        val shared = cache
        val builder =
            if (shared != null) {
                OkHttpClientProvider.createClientBuilder().cache(shared)
            } else {
                OkHttpClientProvider.createClientBuilder(context)
            }
        val client = builder.addInterceptor(SnitchOkHttpInterceptor()).build()
        if (shared == null) cache = client.cache
        return client
    }
}
