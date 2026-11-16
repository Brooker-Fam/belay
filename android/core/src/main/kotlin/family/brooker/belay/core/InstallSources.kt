package family.brooker.belay.core

import kotlinx.serialization.Serializable

/** Where an app came from, in the words a parent would use. */
@Serializable
enum class InstallSource(val description: String) {
    PLAY_STORE("Play Store"),
    OTHER_STORE("another app store"),
    OTHER_APP("installed by another app"),
    SIDELOADED("sideloaded (an APK file)"),
    ADB("installed from a computer (adb)"),
    PREINSTALLED("preinstalled"),
    UNKNOWN("unknown"),
}

object InstallSources {
    const val PLAY_STORE_PACKAGE = "com.android.vending"
    const val SHELL_PACKAGE = "com.android.shell"

    // PackageInstaller.PACKAGE_SOURCE_* (API 33), mirrored so :core stays free of Android classes.
    const val PACKAGE_SOURCE_UNSPECIFIED = 0
    const val PACKAGE_SOURCE_OTHER = 1
    const val PACKAGE_SOURCE_STORE = 2
    const val PACKAGE_SOURCE_LOCAL_FILE = 3
    const val PACKAGE_SOURCE_DOWNLOADED_FILE = 4

    /**
     * Maps InstallSourceInfo to an [InstallSource]. What AOSP 17 records:
     * - adb install: initiating com.android.shell, installing null (unless -i), source OTHER.
     * - Preinstalled, never updated: no installer, source UNSPECIFIED (and FLAG_SYSTEM).
     * - An APK opened from Files or a browser: installer the system package installer,
     *   source LOCAL_FILE or DOWNLOADED_FILE.
     * - Play: installing com.android.vending (widely observed; not documented).
     * Phase 0 shows the raw fields next to the result, so this is checked on a real phone.
     */
    fun classify(system: Boolean, installer: InstallerInfo): InstallSource = when {
        system -> InstallSource.PREINSTALLED
        installer.installing == PLAY_STORE_PACKAGE || installer.updateOwner == PLAY_STORE_PACKAGE ->
            InstallSource.PLAY_STORE
        installer.initiating == SHELL_PACKAGE || installer.installing == SHELL_PACKAGE -> InstallSource.ADB
        installer.packageSource == PACKAGE_SOURCE_STORE -> InstallSource.OTHER_STORE
        installer.packageSource == PACKAGE_SOURCE_LOCAL_FILE ||
            installer.packageSource == PACKAGE_SOURCE_DOWNLOADED_FILE -> InstallSource.SIDELOADED
        installer.installing != null -> InstallSource.OTHER_APP
        else -> InstallSource.UNKNOWN
    }
}
