// :snitch — the core SDK. No dependencies beyond the Kotlin stdlib, no
// resources (strings live in ui/Strings.kt) so the same sources can be compiled
// inside the React Native module.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

val publishGroup: String by rootProject.extra
val publishVersion: String by rootProject.extra

android {
    namespace = "io.github.monjar.snitch"
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

    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.systemProperty("snitch.contractDir", rootProject.file("../contract").absolutePath)
        }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

dependencies {
    testImplementation(libs.junit4)
    // The JVM unit tests need a real org.json (android.jar only has stubs).
    testImplementation(libs.json)
}

// SnitchVersion.kt hard-codes the version (no BuildConfig: the RN module compiles
// these sources too). Fail the build when it drifts from ../VERSION.
val checkSdkVersion by tasks.registering {
    val versionFile = rootProject.file("../VERSION")
    val sourceFile = file("src/main/java/io/github/monjar/snitch/SnitchVersion.kt")
    inputs.files(versionFile, sourceFile)
    doLast {
        val want = versionFile.readText().trim()
        val have = Regex("SDK_VERSION = \"([^\"]+)\"").find(sourceFile.readText())?.groupValues?.get(1)
        check(have == want) { "SnitchVersion.SDK_VERSION ($have) does not match VERSION ($want)" }
    }
}
tasks.named("preBuild") { dependsOn(checkSdkVersion) }

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = publishGroup
                artifactId = "snitch"
                version = publishVersion
                pom {
                    name.set("Snitch")
                    description.set("Self-hosted QA and bug reporting for Android apps.")
                    licenses { license { name.set("MIT") } }
                }
            }
        }
    }
}
