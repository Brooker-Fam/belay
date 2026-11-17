package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The recovery key's test vector from RecoveryKeyTest, shared with the server. */
class RecoveryTest {
    private val key = "7KD2M8Q4ZX1HNP3RT6VWB9CF0G"
    private val check = WireRecovery(
        version = 1,
        salt = "000102030405060708090a0b0c0d0e0f",
        hash = "de01d867f9fc4097eae169b9abdf2b2b8092afa3f3e80f38c6fdc08f283a83a1",
    )
    private val wrong = "7KD2M8Q4ZX1HNP3RT6VWB9CF0H"
    private val minute = 60_000L

    private fun clock(now: Long, boot: Int? = 12, elapsed: Long = now - T0 + HOUR) = RecoveryClock(now, boot, elapsed)

    private fun RecoveryState.tryKey(typed: String, at: RecoveryClock, recovery: WireRecovery? = check) =
        RecoveryRules.attempt(this, recovery, typed, at)

    @Test
    fun `the key opens repair access for 24 hours, and its version is used up`() {
        val (state, outcome) = RecoveryState().tryKey("7kd2m-8q4zx-1hnp3-rt6vw-b9cf0g", clock(T0))
        val use = WireRecoveryUse(version = 1, usedAt = T0, until = T0 + 24 * HOUR)
        assertEquals(RecoveryOutcome.Opened(use), outcome)
        assertEquals(use, state.lastUse)
        assertEquals(listOf(1), state.usedVersions)
        assertEquals(T0 + 24 * HOUR, RecoveryRules.openUntil(state, T0 + HOUR))
        assertNull(RecoveryRules.openUntil(state, T0 + 24 * HOUR), "closed when the 24 hours are up")

        // Never again on this phone, even if the policy still has that check.
        assertEquals(RecoveryOutcome.Used, state.tryKey(key, clock(T0 + 2 * HOUR)).second)
        // A new key works.
        val next = WireRecovery(2, "0f0e0d0c0b0a09080706050403020100", RecoveryKey.hash("0f0e0d0c0b0a09080706050403020100", wrong))
        assertIs<RecoveryOutcome.Opened>(state.tryKey(wrong, clock(T0 + 3 * HOUR), next).second)
    }

    @Test
    fun `a clock set back before the use, or past its end, closes repair access`() {
        val state = RecoveryState(lastUse = WireRecoveryUse(1, usedAt = T0, until = T0 + 24 * HOUR))
        assertNull(RecoveryRules.openUntil(state, T0 - minute))
        assertNull(RecoveryRules.openUntil(state, T0 + 30 * HOUR))
        assertNull(RecoveryRules.openUntil(RecoveryState(), T0))
    }

    @Test
    fun `three wrong tries are free, then the wait is a minute, doubling`() {
        assertEquals(listOf(0L, 0, 0, 1, 2, 4, 8), (0..6).map { RecoveryRules.waitAfter(it) / minute })
        assertEquals(RecoveryRules.MAX_WAIT_MS, RecoveryRules.waitAfter(40))

        var state = RecoveryState()
        val outcomes = (1..3).map { i ->
            val (next, outcome) = state.tryKey(wrong, clock(T0 + i))
            state = next
            outcome
        }
        assertEquals(listOf(RecoveryOutcome.Wrong(2, 0), RecoveryOutcome.Wrong(1, 0), RecoveryOutcome.Wrong(0, minute)), outcomes)
        // Even the right key isn't checked during the wait.
        assertEquals(RecoveryOutcome.Wait(minute - 30_000 + 3), state.tryKey(key, clock(T0 + 30_000)).second)
        val (fourth, wrongAgain) = state.tryKey(wrong, clock(T0 + minute + 3))
        assertEquals(RecoveryOutcome.Wrong(0, 2 * minute), wrongAgain)
        assertIs<RecoveryOutcome.Wait>(fourth.tryKey(key, clock(T0 + 2 * minute)).second)
        val (opened, outcome) = fourth.tryKey(key, clock(T0 + 3 * minute + 3))
        assertIs<RecoveryOutcome.Opened>(outcome)
        assertEquals(0, opened.wrongTries, "the right key starts the count again")
    }

    @Test
    fun `the wait is kept across a restart, by the wall clock`() {
        val waiting = RecoveryState(wrongTries = 5, lastWrongAt = T0, lastWrongBoot = 12, lastWrongElapsed = 5 * minute)
        // Same boot: the time since boot counts, whatever the wall clock says.
        assertEquals(4 * minute - minute, RecoveryRules.remainingWait(waiting, RecoveryClock(T0 + 100 * HOUR, 12, 6 * minute)))
        // After a restart: the wall clock.
        assertEquals(4 * minute - 2 * minute, RecoveryRules.remainingWait(waiting, RecoveryClock(T0 + 2 * minute, 13, 10_000)))
        assertEquals(0, RecoveryRules.remainingWait(waiting, RecoveryClock(T0 + 5 * minute, 13, 10_000)))
        // No boot count on this phone: the wall clock too.
        assertEquals(4 * minute - minute, RecoveryRules.remainingWait(waiting.copy(lastWrongBoot = null), RecoveryClock(T0 + minute, null, 10_000)))
        // A wall clock set back after a restart doesn't hold the parent off.
        assertEquals(0, RecoveryRules.remainingWait(waiting, RecoveryClock(T0 - 10 * HOUR, 13, 10_000)))
    }

    @Test
    fun `what can't be a key isn't counted, and without a key nothing opens`() {
        val (state, outcome) = RecoveryState().tryKey("1234", clock(T0))
        assertEquals(RecoveryOutcome.NotAKey, outcome)
        assertEquals(RecoveryState(), state)
        assertEquals(RecoveryOutcome.NoKey, RecoveryState().tryKey(key, clock(T0), recovery = null).second)
    }

    @Test
    fun `used versions are capped`() {
        var state = RecoveryState(usedVersions = (1..RecoveryRules.MAX_USED_VERSIONS).toList())
        val newest = RecoveryRules.MAX_USED_VERSIONS + 1
        val check = WireRecovery(newest, this.check.salt, this.check.hash)
        state = state.tryKey(key, clock(T0), check).first
        assertEquals(RecoveryRules.MAX_USED_VERSIONS, state.usedVersions.size)
        assertTrue(newest in state.usedVersions)
    }
}
