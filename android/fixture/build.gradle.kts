// A tiny app for the instrumented test in :app (FixtureEventsInstrumentedTest): installing
// it, updating it and removing it must put INSTALLED, UPDATED and REMOVED events in Belay's
// outbox. Two versions as product flavors; a made-up name, (Phase 3) one blank screen with a
// launcher icon, so screen time can count it and pause it, and (Phase 3's network logging) one
// lookup of a made-up name when a test asks, the only reason it has a permission: INTERNET.
//
//   ./gradlew :fixture:assembleV1Debug :fixture:assembleV2Debug
//   adb push fixture/build/outputs/apk/v1/debug/fixture-v1-debug.apk /data/local/tmp/belay-fixture-v1.apk
//   adb push fixture/build/outputs/apk/v2/debug/fixture-v2-debug.apk /data/local/tmp/belay-fixture-v2.apk
plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "family.brooker.belay.fixture"
    compileSdk = 37

    defaultConfig {
        applicationId = "family.brooker.belay.fixture"
        minSdk = 31
        targetSdk = 37
    }

    flavorDimensions += "version"
    productFlavors {
        create("v1") {
            dimension = "version"
            versionCode = 1
            versionName = "1.0"
        }
        create("v2") {
            dimension = "version"
            versionCode = 2
            versionName = "2.0"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
