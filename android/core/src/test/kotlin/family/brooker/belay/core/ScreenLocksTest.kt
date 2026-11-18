package family.brooker.belay.core

import family.brooker.belay.core.location.LostApplied
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Screen locks wait while a call is on (a 988 call included), and happen after it if still due:
 * for a managed call Telecom has, as long as it lasts; for one only Android's audio mode shows
 * (MODE_IN_CALL, while Belay isn't the dialer), 30 minutes at most (the fourth review's N5); never
 * for an app's own call (the fifth's F3). A lock_now is reported when the phone has it, a call on
 * or not, so its result never tells of a call (the fifth's F2).
 */
class ScreenLocksTest {
    private val lockNow = WireCommand("c-1", WireCommand.LOCK_NOW, issuedAt = 1_000, expiresAt = 1_000 + 10 * 60_000)
    private val minute = 60_000L
    private val telecom = CallNow(telecom = true)
    private val carrier = CallNow(carrier = true)
    private val none = CallNow()
    private val bootAt = 500L

    private fun plan(now: Long, done: Set<String> = emptySet(), commands: List<WireCommand> = listOf(lockNow)) =
        Commands.plan(commands, done, now = now, runs = setOf(WireCommand.LOCK_NOW))

    @Test
    fun `lock_now is reported at the step that has it, during a call too, and the lock waits for the call`() {
        // No call: the screen locks now, and the command is reported.
        val quiet = ScreenLocks.lockNow(plan(2_000), due = null, bootCount = 7, bootAt = bootAt) { false }
        assertEquals(ScreenLocks.LockNowStep(listOf(lockNow), lock = true, due = null), quiet)
        // A call on: reported all the same (done), and the lock is due, with no time kept.
        val during = ScreenLocks.lockNow(plan(2_000), due = null, bootCount = 7, bootAt = bootAt) { true }
        assertEquals(ScreenLocks.LockNowStep(listOf(lockNow), lock = false, due = LockDue(7, bootAt)), during)
        assertEquals(during.report, quiet.report, "the same report either way")
        // Reported, so done in the log: later steps don't report it again, whatever the call does.
        val log = CommandLog().record(during.report.map { CommandLog.done(it, 2_000) }).due(during.due)
        val later = plan(5 * minute, log.doneIds)
        assertEquals(emptyList(), later.lockNow)
        assertEquals(emptyList(), later.expired)
        // Still on: still due. The call ends, well after the command's 10 minutes: the screen locks then.
        assertEquals(ScreenLocks.LockNowStep(emptyList(), lock = false, due = log.lockDue), ScreenLocks.lockNow(later, log.lockDue, 7, bootAt) { true })
        val ended = ScreenLocks.lockNow(plan(3 * 60 * minute, log.doneIds), log.lockDue, 7, bootAt) { false }
        assertEquals(ScreenLocks.LockNowStep(emptyList(), lock = true, due = null), ended)
        // Nothing due and nothing new: the call isn't asked about.
        assertEquals(ScreenLocks.LockNowStep(emptyList(), lock = false, due = null), ScreenLocks.lockNow(later, null, 7, bootAt) { error("not asked") })
    }

    @Test
    fun `a lock due from before a restart is dropped, since the restart locked the screen`() {
        val due = LockDue(7, bootAt)
        val empty = plan(2_000, commands = emptyList())
        assertEquals(ScreenLocks.LockNowStep(emptyList(), lock = false, due = null), ScreenLocks.lockNow(empty, due, 8, bootAt + 60 * minute) { error("not asked") })
        // Without a boot count, by when the phone started.
        val noCount = LockDue(null, bootAt)
        assertEquals(ScreenLocks.LockNowStep(emptyList(), lock = true, due = null), ScreenLocks.lockNow(empty, noCount, null, bootAt + minute) { false })
        assertEquals(ScreenLocks.LockNowStep(emptyList(), lock = false, due = null), ScreenLocks.lockNow(empty, noCount, null, bootAt + 60 * minute) { error("not asked") })
        // A new lock_now in the new restart, during a call: due in that restart.
        assertEquals(LockDue(8, bootAt + 60 * minute), ScreenLocks.lockNow(plan(2_000), due, 8, bootAt + 60 * minute) { true }.due)
    }

    @Test
    fun `a lock_now expires only when it reached the phone too late, never for a call`() {
        val tooLate = plan(20 * minute)
        assertEquals(listOf(lockNow), tooLate.expired)
        assertEquals(emptyList(), tooLate.lockNow)
        assertEquals(listOf(WireCommandResult(lockNow.id, WireCommandOutcome.EXPIRED, 20 * minute)), CommandLog.notRun(tooLate, 20 * minute))
        // Several at once are reported together, and lock once.
        val second = lockNow.copy(id = "c-2")
        assertEquals(listOf(lockNow, second), ScreenLocks.lockNow(plan(2_000, commands = listOf(lockNow, second)), null, 7, bootAt) { true }.report)
        // Nothing in a result says a call was on: what's sent is id, outcome, time and the phone's words.
        val sent = Wire.json.encodeToString(WireCommandResult.serializer(), CommandLog.done(lockNow, 2_000))
        assertEquals("""{"id":"c-1","result":"done","at":2000}""", sent)
    }

    @Test
    fun `only a managed call holds a lock while Belay is the dialer, never an app's own call`() {
        // While Belay is the dialer Telecom answers isInManagedCall, which leaves self-managed calls
        // out (platform notes T20): an app's call left open all night is no call to Belay, and the
        // audio mode isn't asked then.
        val appsOwnCall = CallNow.of(belays = false, managed = { false }) { error("the audio mode isn't asked while Telecom answers") }
        assertEquals(none, appsOwnCall)
        assertFalse(ScreenLocks.wait(appsOwnCall, carrierSince = null, now = 0).waits)
        // A carrier call, or an emergency call in the preloaded dialer: Telecom has it.
        assertEquals(telecom, CallNow.of(belays = false, managed = { true }) { error("not asked") })
        // A call on Belay's own screen: Telecom isn't asked either.
        assertEquals(telecom, CallNow.of(belays = true, managed = { error("not asked") }) { error("not asked") })
        // Belay isn't the dialer, or Telecom refused: only the audio mode's MODE_IN_CALL, 30 minutes at most.
        assertEquals(carrier, CallNow.of(belays = false, managed = { null }) { true })
        assertEquals(none, CallNow.of(belays = false, managed = { null }) { false })
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
