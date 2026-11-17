import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Release signing.
//
// The application id and the release key are permanent. Android only updates a device
// owner with an APK signed by the same key, so losing the key (or changing the id) means
// factory-resetting every phone. The keystore never lives in this repository:
// android/scripts/make-release-key.sh creates it in ~/.config/belay/ (see docs/signing.md).
// BELAY_SIGNING_PROPERTIES can point somewhere else; the two passwords can come from
// BELAY_STORE_PASSWORD and BELAY_KEY_PASSWORD instead of the file.
val signingFile: File = providers.environmentVariable("BELAY_SIGNING_PROPERTIES").orNull?.let(::File)
    ?: File(System.getProperty("user.home"), ".config/belay/signing.properties")
val signingProps: Properties? = signingFile.takeIf { it.isFile }?.let { f ->
    Properties().apply { f.inputStream().use { load(it) } }
}

// CI's self-update test (android/scripts/ci-emulator-test.sh) installs a second debug build of
// Belay, built on the same computer (so with the same debug key) with a higher version code,
// that isn't test-only: Android never lets an app install a test-only APK through a
// PackageInstaller session (docs/platform-notes.md I5).
//   ./gradlew :app:assembleDebug -PbelayVersionCode=6 -PbelayTestOnly=false
// Never provision a phone with such a build: unprovision.sh only releases test-only builds.
val belayVersionCode: Int? = providers.gradleProperty("belayVersionCode").orNull?.toInt()
val belayTestOnly: Boolean = providers.gradleProperty("belayTestOnly").orNull?.toBooleanStrict() ?: true

android {
    namespace = "family.brooker.belay"
    compileSdk = 37

    defaultConfig {
        // Permanent: see the note above. Ask before changing it.
        applicationId = "family.brooker.belay"
        minSdk = 31
        targetSdk = 37
        versionCode = belayVersionCode ?: 6
        versionName = "0.5.0-phase5-calls"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                    ?: providers.environmentVariable("BELAY_STORE_PASSWORD").orNull
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
                    ?: providers.environmentVariable("BELAY_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        debug {
            // src/debug/AndroidManifest.xml sets android:testOnly="true", so a debug build
            // can be released as device owner without a factory reset (unprovision.sh).
            manifestPlaceholders["belayTestOnly"] = belayTestOnly.toString()
        }
        release {
            isMinifyEnabled = false
            // Never fall back to the debug key: a phone provisioned with a debug-signed
            // build could only ever be updated from that one computer. Without
            // signing.properties this produces app-release-unsigned.apk, which
            // provision.sh refuses.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkDependencies = true
    }
}

// Room writes each schema version here (checked in), for future migrations.
ksp {
    arg("room.schemaLocation", layout.projectDirectory.dir("schemas").asFile.path)
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.work.runtime)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.core)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.junit)
}
