package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.mobiledata.WireMobileData
import family.brooker.belay.core.mobiledata.WireMobileDataStatus
import family.brooker.belay.enforce.EnforcementReport
import family.brooker.belay.inventory.Collectors
import family.brooker.belay.store.AgentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 13's mobile data on the emulator, as device owner, with a policy set in place of the
 * server's (DebugTools.policyOverride). Wi-Fi only: the test APK (an installed app with a uid of
 * its own) on the policy's list reaches Android's list for Belay (getMeteredDataDisabledPackages)
 * and the report, the phone app never does, an app that isn't installed waits quietly, and an
 * empty list clears Android's. Measuring: a step reads Android's accounting without a problem and
 * starts counting; off, Belay keeps nothing. Only the Pixel shows an app actually losing mobile
 * data (docs/phase13-checklist.md). The test puts the phone back as it was: the override cleared,
 * and a step.
 */
@RunWith(AndroidJUnit4::class)
class MobileDataInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val dpm = context.getSystemService(DevicePolicyManager::class.java)
    private val admin = DeviceOwnerSetup.admin(context)
    private val store = AgentStore.get(context)

    /** The test APK: installed, visible, not one Belay never blocks, with a uid of its own. */
    private val testApp = instrumentation.context.packageName

    @Before
    fun emulatorAndDeviceOwner() {
        assumeTrue("emulators only", shell("getprop ro.kernel.qemu").trim() == "1" || shell("getprop ro.boot.qemu").trim() == "1")
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
    }

    @After
    fun putBack() {
        DebugTools.policyOverride = null
        agentStep()
    }

    @Test
    fun theWifiOnlyAppsReachAndroidAndLeaveIt() {
        // Belay knows the test APK once a step has read it: it was installed just before the tests.
        var seen = testApp in store.loadBaseline().inventory
        repeat(10) {
            if (seen) return@repeat
            agentStep()
            Thread.sleep(1_000)
            seen = testApp in store.loadBaseline().inventory
        }
        assertTrue("Belay never saw the test APK installed", seen)
        val real = store.policy() ?: WirePolicy(version = 0)
        val listed = listOf(testApp, "com.android.phone", "com.example.not.installed")
        val on = real.copy(version = real.version + VERSION_OFFSET, mobileData = WireMobileData(wifiOnly = listed))
        DebugTools.policyOverride = on
        agentStep()
        assertEquals("Android's list for Belay", listOf(testApp), dpm.getMeteredDataDisabledPackages(admin).sorted())
        assertEquals(WireMobileDataStatus(listOf(testApp)), EnforcementReport.of(store)?.mobileData)
        val state = store.mobileDataState()
        assertNotNull("no mobile data state", state)
        assertEquals(listOf(testApp), state!!.wifiOnly.asked)
        assertEquals(emptyList<String>(), state.wifiOnly.refused)
        // Wi-Fi only collects nothing: "What your parent can see" doesn't change.
        assertTrue(Collectors.categories(on).none { it.id == DataCategories.MOBILE_DATA_ID })

        // The same step again changes nothing.
        agentStep()
        assertEquals(state, store.mobileDataState())
        assertEquals(listOf(testApp), dpm.getMeteredDataDisabledPackages(admin).sorted())

        // Nothing listed: Android lets it use mobile data again, and Belay keeps nothing.
        DebugTools.policyOverride = on.copy(version = on.version + 1, mobileData = WireMobileData())
        agentStep()
        assertEquals(emptyList<String>(), dpm.getMeteredDataDisabledPackages(admin))
        assertNull(EnforcementReport.of(store)?.mobileData)
        assertNull(store.mobileDataState())
    }

    @Test
    fun measuringReadsAndroidsAccountingAndOffKeepsNothing() {
        val real = store.policy() ?: WirePolicy(version = 0)
        val on = real.copy(version = real.version + VERSION_OFFSET + 10, mobileData = WireMobileData(measure = true))
        DebugTools.policyOverride = on
        agentStep()
        val uploads = store.mobileDataState()?.uploads
        assertNotNull("measuring didn't start", uploads?.since)
        assertNotNull("today wasn't read", uploads?.lastAt)
        assertTrue(store.applied().problems.joinToString(), store.applied().problems.none { "mobile data" in it })
        assertTrue(Collectors.categories(on).any { it.id == DataCategories.MOBILE_DATA_ID })

        DebugTools.policyOverride = on.copy(version = on.version + 1, mobileData = WireMobileData())
        agentStep()
        assertNull(store.mobileDataState())
        assertEquals(0, store.pendingMobileDataCount())
        assertTrue(Collectors.categories(DebugTools.policyOverride).none { it.id == DataCategories.MOBILE_DATA_ID })
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    /** As the shell user; its standard output. */
    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private companion object {
        /** Test policies get versions of their own, well past the server's. */
        const val VERSION_OFFSET = 3_000_000
    }
}
