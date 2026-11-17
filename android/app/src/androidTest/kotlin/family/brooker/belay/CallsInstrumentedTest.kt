package family.brooker.belay

import android.app.admin.DevicePolicyManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.calls.Dialer
import family.brooker.belay.core.CategoryPermissions
import family.brooker.belay.core.DataCategories
import family.brooker.belay.store.AgentStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 5 on the phone, as device owner, while the server's policy has calls on: CI's calls block
 * runs it with `am instrument -e class family.brooker.belay.CallsInstrumentedTest` after `calls
 * --mode contacts …`. In any other run it skips itself: turning calls off denies Belay's call
 * permissions by policy, and Android then stops Belay's processes (platform notes L7), where this
 * instrumentation runs; CI checks that side from the shell (`calls --off`, then `telecom
 * get-default-dialer`). Losing the dialer role doesn't stop Belay (its call permissions are fixed
 * by policy, which the role can't revoke: T10), so the test gives the role away and takes it back.
 */
@RunWith(AndroidJUnit4::class)
class CallsInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val store = AgentStore.get(context)

    @Before
    fun deviceOwnerWithCallsOn() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        assumeTrue("this phone has no telephony", Dialer.hasTelephony(context))
        assumeTrue("the server's policy has calls off: CI's calls block runs this", store.policy()?.calls != null)
        agentStep()
    }

    @Test
    fun belayIsTheDefaultDialerWhileThePolicyHasCalls() {
        assertTrue("Belay isn't the default dialer (it's ${Dialer.defaultDialer(context)})", Dialer.isDialer(context))
        assertTrue("Belay's dialer isn't enabled", Dialer.componentsEnabled(context))
        assertEquals(true, store.callsState()?.report?.dialer)
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(context)
        for (permission in CategoryPermissions.CATEGORY.filterValues { it == DataCategories.CALLS_ID }.keys) {
            assertEquals("$permission isn't granted by policy", DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED, dpm.getPermissionGrantState(admin, context.packageName, permission))
        }
    }

    @Test
    fun belayGivesTheDialerBackAndTakesItAgain() {
        val before = store.callsState()?.dialerBefore
        assumeTrue("there was no dialer before Belay (the ATD image has none)", before != null && before != context.packageName)
        // What CallsStep.after does when calls goes off.
        assertEquals(null, Dialer.makeDefault(context, checkNotNull(before)))
        assertEquals(before, Dialer.defaultDialer(context))
        // The next step, with calls still on, makes Belay the dialer again.
        agentStep()
        awaitDialer()
        assertTrue("Belay didn't take the dialer back", Dialer.isDialer(context))
    }

    @Test
    fun otherAppsThatAskForCallPhoneAreDeniedIt() {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(context)
        val denied = store.callsState()?.callPhoneDenied.orEmpty()
        assertTrue("Belay denied itself CALL_PHONE", context.packageName !in denied)
        Dialer.systemDialer(context)?.let { assertTrue("the preloaded dialer lost CALL_PHONE", it !in denied) }
        for (name in denied) {
            assertEquals("$name still has CALL_PHONE", DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED, dpm.getPermissionGrantState(admin, name, CategoryPermissions.CALL_PHONE))
        }
    }

    private fun awaitDialer() {
        val until = System.currentTimeMillis() + 30_000
        while (!Dialer.isDialer(context) && System.currentTimeMillis() < until) Thread.sleep(500)
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.POLICY) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(90, TimeUnit.SECONDS))
    }
}
