package family.brooker.belay.core

import family.brooker.belay.core.location.LostApplied
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Screen locks wait while a call is on (a 988 call included), and happen after it if still due:
 * for a call Telecom has, as long as it lasts; for one only Android's audio mode shows (MODE_IN_CALL,
 * while Belay isn't the dialer), 30 minutes at most (the fourth review's N5).
 */
class ScreenLocksTest {
    private val lockNow = WireCommand("c-1", WireCommand.LOCK_NOW, issuedAt = 1_000, expiresAt = 1_000 + 10 * 60_000)
    private val minute = 60_000L
    private val telecom = CallNow(telecom = true)
    private val carrier = CallNow(carrier = true)
    private val none = CallNow()

    @Test
    fun `lock_now waits during a call, stays unrun, and expires as any late command does`() {
        val plan = Commands.plan(listOf(lockNow), emptySet(), now = 2_000, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(listOf(lockNow), ScreenLocks.lockNow(plan, waits = false))
        assertEquals(emptyList(), ScreenLocks.lockNow(plan, waits = true))
        // Not run, so not in the command log: the next step after the call runs it...
        val after = Commands.plan(listOf(lockNow), CommandLog().doneIds, now = 5 * 60_000, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(listOf(lockNow), ScreenLocks.lockNow(after, waits = false))
        // ...unless the call outlasted it: then it's reported expired, never run late.
        val tooLate = Commands.plan(listOf(lockNow), emptySet(), now = 20 * 60_000, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(emptyList(), ScreenLocks.lockNow(tooLate, waits = false))
        assertEquals(listOf(WireCommandOutcome.EXPIRED), CommandLog.notRun(tooLate, 20 * 60_000).map { it.result })
    }

    @Test
    fun `an expired lock_now that waited for a call says so, and one that arrived late doesn't`() {
        val tooLate = Commands.plan(listOf(lockNow), emptySet(), now = 20 * minute, runs = setOf(WireCommand.LOCK_NOW))
        val waited = CommandLog().waiting(listOf(lockNow.id))
        val result = CommandLog.notRun(tooLate, 20 * minute, waited.waitingForCall).single()
        assertEquals(WireCommandOutcome.EXPIRED, result.result)
        assertEquals(true, result.waitedForCall)
        assertNull(CommandLog.notRun(tooLate, 20 * minute).single().waitedForCall, "it reached the phone too late")
        // Only a lock_now: another kind never waits for a call.
        val remove = WireCommand("c-2", WireCommand.REMOVE_OTHER_USERS, issuedAt = 1_000, expiresAt = 2_000)
        val expired = Commands.plan(listOf(remove), emptySet(), now = 20 * minute, runs = setOf(WireCommand.REMOVE_OTHER_USERS))
        assertNull(CommandLog.notRun(expired, 20 * minute, listOf(remove.id)).single().waitedForCall)
        // Once reported (or run), it's no longer waiting.
        assertEquals(emptyList(), waited.record(listOf(result)).waitingForCall)
        assertEquals(emptyList(), waited.waiting(emptyList()).waitingForCall)
    }

    @Test
    fun `a call Telecom has holds a lock as long as it lasts`() {
        assertEquals(ScreenLocks.CallWait(waits = true), ScreenLocks.wait(telecom, null, 0))
        assertTrue(ScreenLocks.wait(telecom, carrierSince = 0, now = 10 * 60 * minute).waits, "a whole night")
        assertEquals(ScreenLocks.CallWait(waits = false), ScreenLocks.wait(none, carrierSince = 5 * minute, now = 10 * minute))
    }

    @Test
    fun `a call only the audio mode shows holds a lock 30 minutes at most, from the step it began`() {
        val start = 21 * 60 * minute
        var since: Long? = null
        val waited = (0..40).map { m ->
            val wait = ScreenLocks.wait(carrier, since, start + m * minute)
            since = wait.carrierSince
            wait.waits
        }
        assertEquals(30, waited.count { it }, "minutes 0 to 29")
        assertTrue(waited.take(30).all { it })
        assertFalse(waited[30], "the lock happens at 30 minutes, mid-call")
        assertEquals(start, since, "counted from the first wait")
        // A clock moved back starts it again; a call Telecom has replaces it.
        assertEquals(start - minute, ScreenLocks.wait(carrier, start, start - minute).carrierSince)
        assertNull(ScreenLocks.wait(telecom, start, start + minute).carrierSince)
        assertNull(ScreenLocks.wait(none, start, start + minute).carrierSince)
    }

    @Test
    fun `lost mode locks once, and waits only for a call Telecom has`() {
        val lost = LostApplied(since = 1_000)
        assertTrue(ScreenLocks.lostLockNow(lost, telecom = false))
        assertFalse(ScreenLocks.lostLockNow(lost, telecom = true))
        assertTrue(ScreenLocks.lostLockWaits(lost, telecom = true))
        assertFalse(ScreenLocks.lostLockNow(lost.copy(locked = true), telecom = false), "once")
        assertFalse(ScreenLocks.lostLockWaits(lost.copy(locked = true), telecom = true))
        assertFalse(ScreenLocks.lostLockWaits(null, telecom = true), "no lost mode")
    }

    @Test
    fun `while a lock waits, the agent looks again within a minute`() {
        assertEquals(61_000L, ScreenLocks.recheckAt(waiting = true, now = 1_000))
        assertNull(ScreenLocks.recheckAt(waiting = false, now = 1_000))
    }
}
