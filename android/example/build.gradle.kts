// :example — a small app that exercises the SDK: a list whose rows count
// 600 ms long-presses and ACTION_CANCELs, a text field (masked in captures),
// an animated view (so frames differ) and a Report button. Its instrumented
// tests drive the three-finger gesture and the end-to-end upload in CI.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val snitchVersion: String by rootProject.extra

android {
    namespace = "io.github.monjar.snitch.example"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.monjar.snitch.example"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = snitchVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":snitch"))
    implementation(project(":snitch-system-capture"))
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.junit4)
}
