pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
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

rootProject.name = "belay-android"

// :core is plain Kotlin (models, inventory diffing, events, protocol types), tested on the JVM.
// :app is the device-owner agent: receivers, service, workers and UI.
// :fixture is a tiny app that :app's instrumented test installs, updates and removes.
include(":core", ":app", ":fixture")
