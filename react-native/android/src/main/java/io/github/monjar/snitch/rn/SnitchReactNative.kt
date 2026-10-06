package io.github.monjar.snitch.rn

import io.github.monjar.snitch.BuildConfig
import io.github.monjar.snitch.Snitch
import java.util.concurrent.atomic.AtomicBoolean

/** React Native specifics of the core SDK, installed once per process. */
internal object SnitchReactNative {
    /** A view whose testID starts with this is masked in screenshots and video (spec §5.5). */
    const val MASK_TEST_ID_PREFIX = "snitch-mask"

    private val installed = AtomicBoolean(false)

    fun install() {
        if (!installed.compareAndSet(false, true)) return
        Snitch.setWrapper("react-native", BuildConfig.SNITCH_RN_VERSION)
        // React Native stores `testID` as a keyed view tag (BaseViewManager.setTestId).
        Snitch.addMaskPredicate { view ->
            (view.getTag(com.facebook.react.R.id.react_test_id) as? String)?.startsWith(MASK_TEST_ID_PREFIX) == true
        }
    }
}
