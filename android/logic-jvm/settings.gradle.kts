// Standalone JVM build that compiles the SDK's pure logic (snitch/src/main/java/.../logic)
// with the Kotlin 1.9 compiler and runs it against contract/vectors. It needs no
// Android SDK, so it runs anywhere: `../gradlew -p logic-jvm test` from android/.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "snitch-logic-jvm"
