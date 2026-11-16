package family.brooker.belay.core

import family.brooker.belay.core.InstallSources.PACKAGE_SOURCE_DOWNLOADED_FILE
import family.brooker.belay.core.InstallSources.PACKAGE_SOURCE_LOCAL_FILE
import family.brooker.belay.core.InstallSources.PACKAGE_SOURCE_STORE
import family.brooker.belay.core.InstallSources.PACKAGE_SOURCE_UNSPECIFIED
import family.brooker.belay.core.InstallSources.PLAY_STORE_PACKAGE
import family.brooker.belay.core.InstallSources.SHELL_PACKAGE
import kotlin.test.Test
import kotlin.test.assertEquals

class InstallSourcesTest {
    private fun classify(system: Boolean = false, info: InstallerInfo) = InstallSources.classify(system, info)

    @Test
    fun `system apps are preinstalled even when Play updates them`() {
        assertEquals(InstallSource.PREINSTALLED, classify(system = true, info = InstallerInfo(installing = PLAY_STORE_PACKAGE)))
    }

    @Test
    fun `Play Store as installer or update owner`() {
        assertEquals(InstallSource.PLAY_STORE, classify(info = InstallerInfo(installing = PLAY_STORE_PACKAGE, packageSource = PACKAGE_SOURCE_STORE)))
        assertEquals(InstallSource.PLAY_STORE, classify(info = InstallerInfo(updateOwner = PLAY_STORE_PACKAGE)))
    }

    @Test
    fun `installed from a computer over adb`() {
        assertEquals(InstallSource.ADB, classify(info = InstallerInfo(initiating = SHELL_PACKAGE, packageSource = PACKAGE_SOURCE_UNSPECIFIED)))
    }

    @Test
    fun `APK files are sideloaded`() {
        assertEquals(InstallSource.SIDELOADED, classify(info = InstallerInfo(installing = "com.example.files", packageSource = PACKAGE_SOURCE_LOCAL_FILE)))
        assertEquals(InstallSource.SIDELOADED, classify(info = InstallerInfo(installing = "com.example.browser", packageSource = PACKAGE_SOURCE_DOWNLOADED_FILE)))
    }

    @Test
    fun `another store`() {
        assertEquals(InstallSource.OTHER_STORE, classify(info = InstallerInfo(installing = "org.example.store", packageSource = PACKAGE_SOURCE_STORE)))
    }

    @Test
    fun `adb as AOSP 17 records it`() {
        assertEquals(InstallSource.ADB, classify(info = InstallerInfo(initiating = SHELL_PACKAGE, packageSource = InstallSources.PACKAGE_SOURCE_OTHER)))
    }

    @Test
    fun `an installer that isn't a store`() {
        assertEquals(InstallSource.OTHER_APP, classify(info = InstallerInfo(installing = "com.example.updater", initiating = "com.example.updater", packageSource = InstallSources.PACKAGE_SOURCE_OTHER)))
    }

    @Test
    fun `nothing known is unknown`() {
        assertEquals(InstallSource.UNKNOWN, classify(info = InstallerInfo()))
    }
}
