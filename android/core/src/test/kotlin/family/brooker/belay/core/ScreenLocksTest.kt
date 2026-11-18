package family.brooker.belay.core

import family.brooker.belay.core.location.LostApplied
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Screen locks wait while a call is on (a 988 call included), and happen after it if still due. */
class ScreenLocksTest {
    private val lockNow = WireCommand("c-1", WireCommand.LOCK_NOW, issuedAt = 1_000, expiresAt = 1_000 + 10 * 60_000)

    @Test
    fun `lock_now waits during a call, stays unrun, and expires as any late command does`() {
        val plan = Commands.plan(listOf(lockNow), emptySet(), now = 2_000, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(listOf(lockNow), ScreenLocks.lockNow(plan, callOn = false))
        assertEquals(emptyList(), ScreenLocks.lockNow(plan, callOn = true))
        // Not run, so not in the command log: the next step after the call runs it...
        val after = Commands.plan(listOf(lockNow), CommandLog().doneIds, now = 5 * 60_000, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(listOf(lockNow), ScreenLocks.lockNow(after, callOn = false))
        // ...unless the call outlasted it: then it's reported expired, never run late.
        val tooLate = Commands.plan(listOf(lockNow), emptySet(), now = 20 * 60_000, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(emptyList(), ScreenLocks.lockNow(tooLate, callOn = false))
        assertEquals(listOf(WireCommandOutcome.EXPIRED), CommandLog.notRun(tooLate, 20 * 60_000).map { it.result })
    }

    @Test
    fun `lost mode locks once, and not during a call`() {
        val lost = LostApplied(since = 1_000)
        assertTrue(ScreenLocks.lostLockNow(lost, callOn = false))
        assertFalse(ScreenLocks.lostLockNow(lost, callOn = true))
        assertTrue(ScreenLocks.lostLockWaits(lost, callOn = true))
        assertFalse(ScreenLocks.lostLockNow(lost.copy(locked = true), callOn = false), "once")
        assertFalse(ScreenLocks.lostLockWaits(lost.copy(locked = true), callOn = true))
        assertFalse(ScreenLocks.lostLockWaits(null, callOn = true), "no lost mode")
    }

    @Test
    fun `while a lock waits, the agent looks again within a minute`() {
        assertEquals(61_000L, ScreenLocks.recheckAt(waiting = true, now = 1_000))
        assertNull(ScreenLocks.recheckAt(waiting = false, now = 1_000))
    }
}
