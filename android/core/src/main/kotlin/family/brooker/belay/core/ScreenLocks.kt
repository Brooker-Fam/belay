package family.brooker.belay.core

import family.brooker.belay.core.location.LostApplied

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
 * Every screen lock Belay makes waits while a call is on, so the screen doesn't go off in the
 * middle of one, a 988 call included: a `lock_now` command (a parent's or an AI app's) and a
 * schedule that locks as it starts (Upkeep.locks) wait for a call Telecom has, and, while Belay
 * isn't the dialer, for one Android's audio mode shows, for at most [CARRIER_WAIT_MS]; lost mode's
 * one lock waits only for a call Telecom has. A lock still due when the call ends happens at the
 * next step: a lock_now until it expires (it's reported `expired` then, with `waited_for_call`, as
 * the protocol says), a schedule's while that schedule is on, lost mode's while lost mode is on.
 * What the lock comes with (a pause, the schedule's or lost mode's rules) applies at once either
 * way: only the lock waits. Locking never ends a call: the screen goes off, and the call goes on.
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

    /** The lock_now commands to run now: none while a lock waits ([waits]: they stay in the policy until they're done or expire). */
    fun lockNow(plan: CommandPlan, waits: Boolean): List<WireCommand> = if (waits) emptyList() else plan.lockNow

    /** Whether lost mode's one lock happens now: not before, not twice, and not during a call Telecom has ([telecom]). */
    fun lostLockNow(applied: LostApplied, telecom: Boolean): Boolean = !applied.locked && !telecom

    /** Whether lost mode's lock is due but waits for a call Telecom has to end. */
    fun lostLockWaits(applied: LostApplied?, telecom: Boolean): Boolean = applied != null && !applied.locked && telecom

    /** When to look again: soon while a lock waits for a call to end, else null. */
    fun recheckAt(waiting: Boolean, now: Long): Long? = if (waiting) now + RECHECK_MS else null
}
