package family.brooker.belay

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.calls.CallsGate
import family.brooker.belay.calls.LockedCalls
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.calls.CallsState
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.WireCallMode
import family.brooker.belay.core.calls.WireCalls
import family.brooker.belay.store.AgentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase 5, before the first unlock after a restart: the time OutgoingCallReceiver keeps when the
 * kid calls 911 from the lock screen, in device-protected storage (calls/LockedCalls.kt), and
 * CallsGate reading it into the 2-hour callback window once the phone is unlocked. The locked
 * state itself only a real phone shows (docs/phase5-checklist.md). Nothing is dialed.
 */
@RunWith(AndroidJUnit4::class)
class LockedCallsInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val android = EmergencyNumbers { it == "911" }

    @After
    fun putBack() {
        LockedCalls.forget(context)
        // What calls decide from, as the agent's last step left it.
        val store = AgentStore.get(context)
        CallsGate.publish(DebugTools.policyOverride ?: store.policy(), store.callsState())
    }

    @Test
    fun theTimeIsKeptInDeviceProtectedStorageAndOnlyTheNewest() {
        LockedCalls.forget(context)
        assertNull(LockedCalls.emergencyContactAt(context))
        val now = System.currentTimeMillis()
        LockedCalls.record(context, now - 60_000)
        LockedCalls.record(context, now - 120_000)
        assertEquals(now - 60_000, LockedCalls.emergencyContactAt(context))
        val file = File(context.createDeviceProtectedStorageContext().noBackupFilesDir, "calls-before-unlock")
        assertTrue("not in device-protected storage", file.exists())
        assertEquals("only the time", (now - 60_000).toString(), file.readText().trim())
        LockedCalls.forget(context)
        assertNull(LockedCalls.emergencyContactAt(context))
    }

    @Test
    fun afterTheUnlockItOpensTheCallbackWindow() {
        val now = System.currentTimeMillis()
        val policy = WirePolicy(version = 1, calls = WireCalls(mode = WireCallMode.CONTACTS))
        CallsGate.publish(policy, CallsState())
        assertNull(CallsGate.now(context, now, android, readLog = false).lastEmergencyContactAt)
        LockedCalls.record(context, now - 10 * 60_000)
        assertEquals(now - 10 * 60_000, CallsGate.now(context, now, android, readLog = false).lastEmergencyContactAt)
        // With calls off, Belay decides nothing, and the time means nothing.
        CallsGate.publish(WirePolicy(version = 1), CallsState())
        assertNull(CallsGate.now(context, now, android, readLog = false).lastEmergencyContactAt)
    }
}
