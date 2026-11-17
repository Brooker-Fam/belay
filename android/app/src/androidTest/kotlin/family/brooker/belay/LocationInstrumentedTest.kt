package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.location.LocationManager
import android.os.UserManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.CategoryPermissions
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.WireFixReason
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.store.AgentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Phase 4 and 7 on the phone, as device owner, while the server's policy has location on: CI's
 * Phase 4 block runs it with `am instrument -e class family.brooker.belay.LocationInstrumentedTest`
 * after `location --mode on_demand --keep-on on`, and with the point it set with `adb emu geo fix`
 * as `-e belayGeoLat … -e belayGeoLng …`. In any other run it skips itself: Android stops an app's
 * processes when it loses a granted permission (platform notes L7), and the instrumentation runs in
 * Belay's own process, so a test that turned location off would end the run. CI checks that side
 * from the shell (`--mode off`, then `dumpsys package`).
 *
 * An emulator's GNSS takes its fixes from the emulator console (`adb emu geo fix`); from inside the
 * phone only a mock provider could set one, and Belay reports mock fixes as such, so the point
 * comes from CI (platform notes L9). Made-up words only.
 */
@RunWith(AndroidJUnit4::class)
class LocationInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val store = AgentStore.get(context)
    private val args = InstrumentationRegistry.getArguments()

    @Before
    fun deviceOwnerWithLocationOn() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        assumeTrue("the server's policy has location off: CI's Phase 4 block runs this", LocationRules.collecting(store.policy()?.location))
        agentStep()
    }

    @After
    fun putBack() {
        // The override keeps location on, so clearing it never takes a permission away here.
        DebugTools.policyOverride = null
        agentStep()
    }

    @Test
    fun locationIsGrantedByPolicyWhileThePolicyHasItOn() {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(context)
        // Only location's own permissions: Phase 5's call permissions follow `calls`, not location.
        for (permission in CategoryPermissions.CATEGORY.filterValues { it == DataCategories.LOCATION_ID }.keys) {
            assertEquals("$permission isn't granted by policy", DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED, dpm.getPermissionGrantState(admin, context.packageName, permission))
        }
        assertTrue(DeviceOwnerSetup.hasLocation(context))
        assertTrue("nothing to take back while location is on", DeviceOwnerSetup.unwanted(context, CategoryPermissions.categoriesOn(store.policy(), false)).isEmpty())
        assertEquals(true, store.locationState()?.report?.permission)
    }

    @Test
    fun keepOnTurnsLocationOnAndLocksIt() {
        val um = context.getSystemService(UserManager::class.java)
        val lm = context.getSystemService(LocationManager::class.java)
        DebugTools.policyOverride = withLocation(WireLocation(mode = WireLocationMode.ON_DEMAND, keepOn = true), 1)
        agentStep()
        assertTrue("location isn't on", lm.isLocationEnabled)
        assertTrue("DISALLOW_CONFIG_LOCATION isn't set", um.hasUserRestriction(UserManager.DISALLOW_CONFIG_LOCATION))
        DebugTools.policyOverride = withLocation(WireLocation(mode = WireLocationMode.ON_DEMAND, keepOn = false), 2)
        agentStep()
        assertFalse("DISALLOW_CONFIG_LOCATION is still set", um.hasUserRestriction(UserManager.DISALLOW_CONFIG_LOCATION))
        assertTrue("Belay turned location back off by itself", lm.isLocationEnabled)
    }

    @Test
    fun locateNowTakesAFixFromTheEmulatorsGps() {
        val (lat, lng) = point() ?: run {
            assumeTrue("no -e belayGeoLat/belayGeoLng: CI sets the point with adb emu geo fix", false)
            return
        }
        val id = "test-locate-${UUID.randomUUID()}"
        val command = WireCommand(id, WireCommand.LOCATE_NOW, System.currentTimeMillis(), via = "Test app")
        DebugTools.policyOverride = withLocation(WireLocation(mode = WireLocationMode.ON_DEMAND, keepOn = true), 3).copy(commands = listOf(command))
        agentStep()
        awaitTrue("locate_now wasn't answered", 90_000) { store.commandLog().results.any { it.id == id } }
        val result = store.commandLog().results.first { it.id == id }
        assertEquals("locate_now: ${result.problem}", WireCommandOutcome.DONE, result.result)
        val last = store.locationState()?.last
        assertNotNull(last)
        assertTrue("the fix ${last!!.lat},${last.lng} isn't $lat,$lng", abs(last.lat - lat) < 0.0002 && abs(last.lng - lng) < 0.0002)
        assertFalse("the emulator's GPS isn't a mock", last.mock)
        assertEquals("the kid's list has the check, naming the app", "Test app", store.told().first { it.id == id }.via)
    }

    @Test
    fun aHelpRequestCarriesTheFixTheKidShared() {
        val sent = CountDownLatch(1)
        var id: String? = null
        Agent.askHelp(context, "Made-up words for a test", share = true) {
            id = it
            sent.countDown()
        }
        assertTrue("the help request wasn't made", sent.await(30, TimeUnit.SECONDS))
        val requestId = id!!
        awaitTrue("the shared fix never reached the help request", 90_000) {
            agentStep()
            store.requests().first { it.id == requestId }.let { it.location != null || it.shareFailed }
        }
        val help = store.requests().first { it.id == requestId }
        assertEquals(WireRequestKind.HELP, help.kind)
        val fix = help.location
        assertNotNull("Belay found nothing: is the emulator's location on?", fix)
        assertEquals(WireFixReason.HELP, fix!!.reason)
        point()?.let { (lat, lng) -> assertTrue("the fix isn't $lat,$lng", abs(fix.lat - lat) < 0.0002 && abs(fix.lng - lng) < 0.0002) }
        assertTrue("sent again with the fix", help.revision >= 1)
        // With no screen of Belay's open, the share's grant is gone at the next step (location stays on by the policy).
        agentStep()
        assertEquals(null, store.locationState()?.help)
    }

    /** The real policy with [location], under a version of its own. */
    private fun withLocation(location: WireLocation, step: Int): WirePolicy {
        val real = store.policy() ?: WirePolicy(version = 0)
        return real.copy(version = real.version + VERSION_OFFSET + step, location = location, commands = emptyList())
    }

    private fun point(): Pair<Double, Double>? {
        val lat = args.getString("belayGeoLat")?.toDoubleOrNull() ?: return null
        val lng = args.getString("belayGeoLng")?.toDoubleOrNull() ?: return null
        return lat to lng
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    private fun awaitTrue(what: String, timeoutMs: Long, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!check()) {
            check(System.currentTimeMillis() < deadline) { "$what (after ${timeoutMs / 1000} s)" }
            Thread.sleep(1_000)
        }
    }

    private companion object {
        /** Test policies get versions of their own, well past the server's. */
        const val VERSION_OFFSET = 3_000_000
    }
}
