package family.brooker.belay.core.calls

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CallsPlanTest {
    private val self = "family.brooker.belay"

    @Test
    fun `the block list, Belay adds what's wanted and takes off only its own`() {
        val kids = "+15555550160"
        val changes = CallsPlan.blockList(wanted = setOf("+15555550177", kids), present = setOf(kids, "+15555550161"), mine = emptySet())
        assertEquals(setOf("+15555550177"), changes.add, "the kid's own entry isn't Belay's to add")
        assertEquals(emptySet(), changes.remove)
        assertEquals(setOf("+15555550177"), changes.mine, "and never becomes Belay's")
        // A parent unblocks it: only Belay's own entry comes off; the kid's stays.
        val unblock = CallsPlan.blockList(wanted = emptySet(), present = setOf("+15555550177", kids, "+15555550161"), mine = setOf("+15555550177"))
        assertEquals(setOf("+15555550177"), unblock.remove)
        assertEquals(emptySet(), unblock.add)
        assertEquals(emptySet(), unblock.mine)
    }

    @Test
    fun `the block list, an entry the kid removed goes back on, and nothing changes when all is in step`() {
        val back = CallsPlan.blockList(wanted = setOf("+15555550177"), present = emptySet(), mine = setOf("+15555550177"))
        assertEquals(setOf("+15555550177"), back.add)
        val same = CallsPlan.blockList(wanted = setOf("+15555550177"), present = setOf("+15555550177"), mine = setOf("+15555550177"))
        assertTrue(same.none)
        assertEquals(setOf("+15555550177"), same.mine)
        // Gone already and no longer wanted: forgotten, nothing to remove.
        val gone = CallsPlan.blockList(wanted = emptySet(), present = emptySet(), mine = setOf("+15555550177"))
        assertTrue(gone.none)
        assertEquals(emptySet(), gone.mine)
    }

    @Test
    fun `the callback window lifts Belay's blocks`() {
        assertEquals(emptySet(), CallsPlan.wantedBlocked(setOf("+15555550177"), callbackWindow = true))
        assertEquals(setOf("+15555550177"), CallsPlan.wantedBlocked(setOf("+15555550177"), callbackWindow = false))
    }

    @Test
    fun `CALL_PHONE, denied to every app but Belay and the protected ones, and handed back`() {
        val requesters = setOf(self, "com.example.dialer2", "com.example.contacts", "com.android.phone", "com.example.preloaded.dialer", "com.example.gone")
        val protected = setOf("com.android.phone", "com.example.preloaded.dialer")
        val installed = requesters - "com.example.gone"
        val on = CallsPlan.callPhone(on = true, requesters, protected, installed, self, denied = emptySet())
        assertEquals(setOf("com.example.dialer2", "com.example.contacts"), on.deny)
        assertEquals(on.deny, on.denied)
        assertEquals(emptySet(), on.restore)
        // Already denied: nothing new.
        assertEquals(emptySet(), CallsPlan.callPhone(true, requesters, protected, installed, self, on.denied).deny)
        // One became the default SMS app (protected now): it gets CALL_PHONE back.
        val nowProtected = CallsPlan.callPhone(true, requesters, protected + "com.example.contacts", installed, self, on.denied)
        assertEquals(setOf("com.example.contacts"), nowProtected.restore)
        // Calls off: every app Belay denied gets it back (an uninstalled one is simply forgotten).
        val off = CallsPlan.callPhone(on = false, requesters, protected, installed - "com.example.dialer2", self, on.denied)
        assertEquals(setOf("com.example.contacts"), off.restore)
        assertEquals(emptySet(), off.denied)
        assertEquals(emptySet(), off.deny)
    }

    @Test
    fun `the dialer goes back to the one from before, if Belay recorded it and it's there`() {
        val installed = setOf(self, "com.example.dialer")
        assertEquals("com.example.dialer", CallsPlan.giveBackTo(CallsState(dialerBefore = "com.example.dialer", dialerBeforeRecorded = true), installed, self))
        assertNull(CallsPlan.giveBackTo(CallsState(dialerBefore = null, dialerBeforeRecorded = true), installed, self), "there was none")
        assertNull(CallsPlan.giveBackTo(CallsState(dialerBefore = "com.example.gone", dialerBeforeRecorded = true), installed, self), "uninstalled")
        assertNull(CallsPlan.giveBackTo(CallsState(dialerBefore = self, dialerBeforeRecorded = true), installed, self))
        assertNull(CallsPlan.giveBackTo(CallsState(dialerBefore = "com.example.dialer", dialerBeforeRecorded = false), installed, self))
    }

    @Test
    fun `asking to be the dialer waits after a refusal, unless the policy is new`() {
        val refused = CallsState(dialerRefusedAt = T0)
        assertFalse(CallsPlan.askForDialer(isDialer = true, CallsState(), T0, newPolicy = true))
        assertTrue(CallsPlan.askForDialer(isDialer = false, CallsState(), T0, newPolicy = false))
        assertFalse(CallsPlan.askForDialer(false, refused, T0 + 60_000, newPolicy = false))
        assertTrue(CallsPlan.askForDialer(false, refused, T0 + 60_000, newPolicy = true))
        assertTrue(CallsPlan.askForDialer(false, refused, T0 + CallsPlan.DIALER_RETRY_MS, newPolicy = false))
        assertTrue(CallsPlan.askForDialer(false, refused, T0 - 60_000, newPolicy = false), "the clock moved back")
    }

    @Test
    fun `the report says when calls go through the phone's own app`() {
        assertNull(CallsPlan.report(on = false, isDialer = true))
        assertEquals(WireCallsStatus(dialer = true), CallsPlan.report(on = true, isDialer = true))
        assertEquals(WireCallsStatus(dialer = false, problem = "Calls are going through the phone's own app"), CallsPlan.report(on = true, isDialer = false))
    }

    @Test
    fun `the last emergency contact is kept only while its window is open`() {
        assertEquals(T0 - HOUR, CallsPlan.emergencyContact(T0 - HOUR, null, T0))
        assertEquals(T0 - 60_000, CallsPlan.emergencyContact(T0 - HOUR, T0 - 60_000, T0), "the newest")
        assertNull(CallsPlan.emergencyContact(T0 - 3 * HOUR, null, T0), "forgotten once the window is over")
        assertNull(CallsPlan.emergencyContact(null, null, T0))
    }
}
