package io.github.monjar.snitch.rn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Autolinked package (RN >= 0.74 `BaseReactPackage`) providing the `Snitch` TurboModule. */
class SnitchPackage : BaseReactPackage() {

    init {
        // Packages are created when React Native starts, before any view renders: register the
        // testID mask and the wrapper even if the app never touches the JS API.
        SnitchReactNative.install()
    }

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeSnitchSpec.NAME) SnitchModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
        ReactModuleInfoProvider {
            mapOf(
                NativeSnitchSpec.NAME to
                    ReactModuleInfo(
                        NativeSnitchSpec.NAME,
                        SnitchModule::class.java.name,
                        false, // canOverrideExistingModule
                        false, // needsEagerInit
                        false, // isCxxModule
                        true, // isTurboModule
                    ),
            )
        }
}
