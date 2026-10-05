import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

// Kotlin 1.9.25 on purpose: the same compiler React Native 0.76 / Expo 52 use
// for these sources, so a Kotlin 2-only construct in logic/ fails here first.
plugins {
    kotlin("jvm") version "1.9.25"
}

kotlin {
    sourceSets.named("main") {
        kotlin.srcDir("../snitch/src/main/java/io/github/monjar/snitch/logic")
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        languageVersion.set(KotlinVersion.KOTLIN_1_9)
        apiVersion.set(KotlinVersion.KOTLIN_1_9)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("org.json:json:20240303")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("snitch.vectorsDir", rootProject.file("../../contract/vectors").absolutePath)
    inputs.dir(rootProject.file("../../contract/vectors"))
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
    afterSuite(
        KotlinClosure2<TestDescriptor, TestResult, Unit>({ desc, result ->
            if (desc.parent == null) {
                println(
                    "logic-jvm: ${result.resultType} — ${result.testCount} tests, " +
                        "${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped",
                )
            }
        }),
    )
}
