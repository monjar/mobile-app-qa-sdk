/*
 * The SDK version, hard-coded rather than taken from BuildConfig because the
 * React Native module compiles these same sources inside its own Gradle module.
 * The :snitch build fails if this drifts from the repo-root VERSION file.
 */
package io.github.monjar.snitch

internal object SnitchVersion {
    const val SDK_VERSION = "0.1.1"
    const val SDK_NAME = "snitch-android"
}
