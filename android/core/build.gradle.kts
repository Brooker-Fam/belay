import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Pure Kotlin: no Android classes here, so everything is testable on the JVM.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
    // The archival test's pure part (docs/phase5-checklist.md, T8) is debug-only, so it lives in the
    // app's src/debug, which release builds never contain. It's plain Kotlin too: compiled into these
    // tests as well, `:core:test` covers it (ArchivalLogTest). Nothing else belongs in that directory.
    sourceSets.getByName("test").kotlin.srcDir("../app/src/debug/kotlin/family/brooker/belay/archival")
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.kotlin.test.junit)
}

// AiAlwaysTest reads docs/mcp.md's "Always included" list: a change there runs the tests again.
tasks.test {
    inputs.file(rootProject.layout.projectDirectory.file("../docs/mcp.md"))
        .withPropertyName("mcpDoc")
        .withPathSensitivity(PathSensitivity.NONE)
}
