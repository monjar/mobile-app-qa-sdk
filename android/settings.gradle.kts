// Snitch Android build: the core library, the optional MediaProjection module
// and an example app. android/logic-jvm is a separate build (no Android SDK).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "snitch-android"

include(":snitch")
include(":snitch-system-capture")
include(":example")
