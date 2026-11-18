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
