package family.brooker.belay.core

import family.brooker.belay.core.location.LostApplied
import kotlinx.serialization.Serializable

/**
 * What Belay can tell about a call now, for the screen locks that wait for one (calls/InCall.kt,
 * platform notes T20). [telecom]: a managed call Telecom has, ringing or on: one in Belay's own
 * in-call service, or, while Belay is the default dialer, any (TelecomManager.isInManagedCall:
 * carrier calls, an emergency call in the preloaded dialer, and calls through a calling account
 * the user turned on), never an app's self-managed call (the fifth review's F3: any app may place
 * one, MANAGE_OWN_CALLS being a normal permission). [carrier]: Android's audio mode is
 * MODE_IN_CALL, which only the phone's own services may set (an app can't), read only while Belay
 * isn't the dialer, when Telecom won't answer Belay. Any other audio mode (an app's
 * MODE_IN_COMMUNICATION, MODE_RINGTONE) counts for nothing: any app may set it.
 */
data class CallNow(val telecom: Boolean = false, val carrier: Boolean = false) {
    companion object {
        /**
         * From what Belay reads, each asked only when what comes before it doesn't settle it: a call
         * on Belay's own screen ([belays]); Telecom's answer whether it has a managed call
         * ([managed], TelecomManager.isInManagedCall: null while Belay isn't the default dialer,
         * since Telecom answers only the dialer, or when it refused); else whether Android's audio
         * mode is MODE_IN_CALL ([inCallMode]).
         */
        fun of(belays: Boolean, managed: () -> Boolean?, inCallMode: () -> Boolean): CallNow {
            if (belays) return CallNow(telecom = true)
            managed()?.let { return CallNow(telecom = it) }
            return CallNow(carrier = inCallMode())
        }
    }
}

/**
 * A `lock_now`'s lock that waits for a call to end, after the phone reported the command done
 * (ScreenLocks.lockNow), due in the restart that [bootCount] and [bootAt] say (core's Boots). A
 * restart locks the screen by itself, so one due from before it is dropped. No time: when it
 * became due would say when a call was on.
 */
@Serializable
data class LockDue(val bootCount: Int? = null, val bootAt: Long)

/**
 * Every screen lock Belay makes waits while a call is on, so the screen doesn't go off in the
 * middle of one, a 988 call included: a `lock_now` command (a parent's or an AI app's) and a
 * schedule that locks as it starts (Upkeep.locks) wait for a call Telecom has, and, while Belay
 * isn't the dialer, for one Android's audio mode shows, for at most [CARRIER_WAIT_MS]; lost mode's
 * one lock waits only for a call Telecom has. A lock still due when the call ends happens at the
 * next step: a lock_now's however long the call was ([lockNow]: the command was reported done
 * when the phone had it), a schedule's while that schedule is on, lost mode's while lost mode is
 * on. What the lock comes with (a pause, the schedule's or lost mode's rules) applies at once
 * either way: only the lock waits. Locking never ends a call: the screen goes off, and the call
 * goes on.
 */
object ScreenLocks {
    /** While a lock waits for a call to end, the agent looks again at least this often. */
    const val RECHECK_MS = 60_000L

    /**
     * A lock waits at most this long for a call only Android's audio mode shows (the fourth
     * review's N5): Belay can't ask Telecom then, so it can't tell how long the call has been on.
     */
    const val CARRIER_WAIT_MS = 30 * 60_000L

    /**
     * Whether a lock waits now ([waits]), and since when it has waited for a call only Android's
     * audio mode shows ([carrierSince]: null while there's none, or Telecom has the call).
     */
    data class CallWait(val waits: Boolean, val carrierSince: Long? = null)

    /**
     * Whether a lock_now or a schedule's lock waits now: during a call Telecom has; during one only
     * the audio mode shows, from the step it first waited for it ([carrierSince], which the agent
     * keeps while a lock waits and forgets at a step where none does) for [CARRIER_WAIT_MS]. A clock
     * moved back starts those 30 minutes again.
     */
    fun wait(call: CallNow, carrierSince: Long?, now: Long): CallWait {
        if (call.telecom) return CallWait(waits = true)
        if (!call.carrier) return CallWait(waits = false)
        val since = carrierSince?.takeIf { it <= now } ?: now
        return CallWait(waits = now - since < CARRIER_WAIT_MS, carrierSince = since)
    }

    /**
     * A step's part in lock_now: the commands to report now ([report]: done, or failed when the
     * lock fails), whether to lock the screen now ([lock]), the lock due after the step ([due]), and
     * why Belay can't lock the screen at all ([problem]: then each is failed in those words, without
     * a try).
     */
    data class LockNowStep(val report: List<WireCommand>, val lock: Boolean, val due: LockDue?, val problem: String? = null)

    /**
     * lock_now (the fifth review's F2): [plan]'s new lock_now commands are reported at the step
     * that first has them, a call on or not, so a result never says that a call was on, or when one
     * ended (it used to come only after the call, or as `expired` with `waited_for_call`): with no
     * call on, the screen locks now (several at once lock once); while one is on ([waits], asked
     * only when a lock is due), they're reported done and the lock is [due] until a step with no
     * call on, however long that takes. A lock due from before a restart is dropped ([bootCount],
     * [bootAt]): the restart locked the screen. Only `expired` (the phone got it too late) and
     * `failed` (the lock failed now) say the screen didn't lock; a due lock that fails later is the
     * phone's log's to say, since when it was tried would say when the call ended.
     *
     * Whether Belay can lock the screen at all is decided first ([cannotLock]: null when it can,
     * else why not, from what doesn't change with a call: Belay isn't the device owner, or
     * Android's record of its policies has no force-lock until the phone restarts, platform notes
     * S5). Then each new command is failed in those words, a call on or not, and no lock is due
     * (the sixth review's G2: on such a phone a lock_now during a call was done, where every other
     * was failed, so its result told of a call, and that done never locked).
     */
    fun lockNow(plan: CommandPlan, due: LockDue?, bootCount: Int?, bootAt: Long, cannotLock: String? = null, waits: () -> Boolean): LockNowStep {
        val stillDue = due?.takeIf { Boots.same(it.bootCount, it.bootAt, bootCount, bootAt) }
        val fresh = plan.lockNow
        if (fresh.isEmpty() && stillDue == null) return LockNowStep(emptyList(), lock = false, due = null)
        if (cannotLock != null) return LockNowStep(fresh, lock = false, due = null, problem = cannotLock)
        if (waits()) return LockNowStep(fresh, lock = false, due = stillDue ?: LockDue(bootCount, bootAt))
        return LockNowStep(fresh, lock = true, due = null)
    }

    /** Whether lost mode's one lock happens now: not before, not twice, and not during a call Telecom has ([telecom]). */
    fun lostLockNow(applied: LostApplied, telecom: Boolean): Boolean = !applied.locked && !telecom

    /** Whether lost mode's lock is due but waits for a call Telecom has to end. */
    fun lostLockWaits(applied: LostApplied?, telecom: Boolean): Boolean = applied != null && !applied.locked && telecom

    /** When to look again: soon while a lock waits for a call to end, else null. */
    fun recheckAt(waiting: Boolean, now: Long): Long? = if (waiting) now + RECHECK_MS else null
}
