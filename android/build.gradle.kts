import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
}

/** The repo-root VERSION file is the single source of truth for the SDK version. */
val snitchVersion: String = rootProject.file("../VERSION").readText().trim()

// JitPack (JITPACK=true) serves artifacts as com.github.<user>.<repo>:<module>:<tag>.
// Publishing under those coordinates keeps the POM of snitch-system-capture
// pointing at a `snitch` artifact JitPack can actually resolve.
val onJitPack = System.getenv("JITPACK") == "true"
extra["snitchVersion"] = snitchVersion
extra["publishGroup"] =
    if (onJitPack) "${System.getenv("GROUP") ?: "com.github.monjar"}.${System.getenv("ARTIFACT") ?: "mobile-app-qa-sdk"}"
    else "io.github.monjar.snitch"
extra["publishVersion"] = if (onJitPack) (System.getenv("VERSION") ?: snitchVersion) else snitchVersion

subprojects {
    // Project coordinates = published coordinates, so project(":snitch") in the
    // snitch-system-capture POM points at the artifact published next to it.
    group = rootProject.extra["publishGroup"] as String
    version = rootProject.extra["publishVersion"] as String

    // Sources must stay compilable by Kotlin 1.9.24+ (RN 0.76 / Expo 52 build them too).
    plugins.withId("org.jetbrains.kotlin.android") {
        tasks.withType<KotlinCompile>().configureEach {
            compilerOptions {
                jvmTarget.set(JvmTarget.JVM_17)
                languageVersion.set(KotlinVersion.KOTLIN_1_9)
                apiVersion.set(KotlinVersion.KOTLIN_1_9)
            }
        }
    }
}
