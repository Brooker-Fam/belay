package family.brooker.belay.core

import family.brooker.belay.core.location.LostApplied

/**
 * Every screen lock Belay makes waits while a call is on: a `lock_now` command (a parent's or an AI
 * app's), a schedule that locks as it starts (Upkeep.locks), and lost mode's one lock. A call is
 * the phone's own, ringing or going on, or one in an app (the phone reads Android's audio mode,
 * platform notes T20), so the screen never goes off in the middle of a call, a 988 call included.
 * A lock still due when the call ends happens at the next step: a lock_now until it expires (it's
 * reported `expired` then, as the protocol says for any command that arrives too late), a
 * schedule's while that schedule is on, lost mode's while lost mode is on. What the lock comes with
 * (a pause, the schedule's or lost mode's rules) applies at once either way: only the lock waits.
 */
object ScreenLocks {
    /** While a lock waits for a call to end, the agent looks again at least this often. */
    const val RECHECK_MS = 60_000L

    /** The lock_now commands to run now: none while a call is on (they stay in the policy until they're done or expire). */
    fun lockNow(plan: CommandPlan, callOn: Boolean): List<WireCommand> = if (callOn) emptyList() else plan.lockNow

    /** Whether lost mode's one lock happens now: not before, not twice, and not during a call. */
    fun lostLockNow(applied: LostApplied, callOn: Boolean): Boolean = !applied.locked && !callOn

    /** Whether lost mode's lock is due but waits for a call to end. */
    fun lostLockWaits(applied: LostApplied?, callOn: Boolean): Boolean = applied != null && !applied.locked && callOn

    /** When to look again: soon while a lock waits for a call to end, else null. */
    fun recheckAt(waiting: Boolean, now: Long): Long? = if (waiting) now + RECHECK_MS else null
}
