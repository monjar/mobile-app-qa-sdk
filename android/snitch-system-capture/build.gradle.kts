// :snitch-system-capture — optional MediaProjection video source (spec §5.3).
// The core finds io.github.monjar.snitch.system.SystemCapture by name, so apps
// opt in just by adding this dependency and CAPTURE_MODE=system.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

val publishGroup: String by rootProject.extra
val publishVersion: String by rootProject.extra

android {
    namespace = "io.github.monjar.snitch.system"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
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

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

dependencies {
    api(project(":snitch"))
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = publishGroup
                artifactId = "snitch-system-capture"
                version = publishVersion
                pom {
                    name.set("Snitch system capture")
                    description.set("MediaProjection screen recording for the Snitch Android SDK.")
                    licenses { license { name.set("MIT") } }
                }
            }
        }
    }
}
