package family.brooker.belay

import android.content.pm.ApplicationInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.InstallSource
import family.brooker.belay.core.PackagePresence
import family.brooker.belay.core.SensitivePermissions
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.PackageReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs on the emulator in CI after android/scripts/provision.sh, and on any test phone
 * (`adb shell am instrument -w family.brooker.belay.test/androidx.test.runner.AndroidJUnitRunner`).
 * Device-owner checks are skipped when Belay isn't device owner.
 */
@RunWith(AndroidJUnit4::class)
class InventoryInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun inventoryIncludesBelayItself() {
        val self = PackageReader(context).read(listOf(context.packageName))[context.packageName]
        assertNotNull(self)
        self!!
        assertEquals(BuildConfig.VERSION_CODE.toLong(), self.versionCode)
        assertEquals(BuildConfig.VERSION_NAME, self.versionName)
        assertFalse(self.system)
        assertTrue(self.launchable)
        assertTrue(self.firstInstallTime > 0)
        assertTrue(self.lastUpdateTime >= self.firstInstallTime)
        assertEquals(37, self.targetSdk)
        assertEquals("Belay", self.label)
        // Installed over adb by provision.sh (or by the test runner): never a store.
        assertTrue(self.source in setOf(InstallSource.ADB, InstallSource.UNKNOWN))
    }

    @Test
    fun coresMirroredInstalledFlagIsAndroids() {
        assertEquals(ApplicationInfo.FLAG_INSTALLED, PackagePresence.FLAG_INSTALLED)
    }

    @Test
    fun fullScanSeesEveryPackageAndMarksSystemApps() {
        val all = PackageReader(context).readAll()
        assertTrue("QUERY_ALL_PACKAGES: only ${all.size} packages visible", all.size > 50)
        val framework = all["android"]
        assertNotNull(framework)
        assertTrue(framework!!.system)
        assertEquals(InstallSource.PREINSTALLED, framework.source)
        assertTrue(context.packageName in all)
    }

    @Test
    fun sensitivePermissionsAreRead() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        DeviceOwnerSetup.ensure(context)
        val self = PackageReader(context).read(listOf(context.packageName)).getValue(context.packageName)
        // A device owner is an active device admin, and holds ACCESS_LOCAL_NETWORK by policy;
        // its camera is denied by policy outside the enrollment screen.
        assertTrue(SensitivePermissions.DEVICE_ADMIN in self.permissions)
        assertTrue(SensitivePermissions.NEARBY_DEVICES in self.permissions)
        assertFalse(SensitivePermissions.CAMERA in self.permissions)
    }

    @Test
    fun deviceOwnerSetupIsApplied() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        assertTrue(DeviceOwnerSetup.ensure(context).isEmpty())
        val health = HealthReader(context).read()
        assertEquals(true, health.uninstallBlocked)
        assertTrue(health.permissions.isNotEmpty())
        val neverGranted = DeviceOwnerSetup.NEVER_GRANTED.map { it.substringAfterLast('.') }
        health.permissions.forEach {
            if (it.name in neverGranted) {
                // CAMERA: never granted by policy, and denied by policy outside the enrollment screen.
                assertFalse("${it.name} is granted", it.granted)
                assertTrue("${it.name} not denied by policy", it.fixedByPolicy)
            } else {
                assertTrue("${it.name} not granted by policy", it.granted && it.fixedByPolicy)
            }
        }
        assertTrue("CAMERA isn't reported", "CAMERA" in health.permissions.map { it.name })
        assertTrue("managed notice can't show", health.notificationsShown)
    }

    @Test
    fun deviceStatusIsComplete() {
        val device = DeviceStatus.read(context, HealthReader(context).read())
        assertEquals(37, device.sdk)
        assertTrue(device.sdkFull.startsWith("37"))
        assertTrue(device.timezone.isNotEmpty())
        assertTrue(device.storageTotalBytes!! > 0)
        assertTrue(device.storageFreeBytes!! in 0..device.storageTotalBytes!!)
        assertEquals(BuildConfig.VERSION_NAME, device.agentVersionName)
    }
}
