package family.brooker.belay.core.kid

import family.brooker.belay.core.EnforcementPlan
import family.brooker.belay.core.Lock
import family.brooker.belay.core.WireOffBelayPosition
import family.brooker.belay.core.WirePolicy

/**
 * Phase 11: Off belay, the family's last stage, on the kid's "My stage" (docs/protocol.md, "Off
 * belay"): listed last from the first day, with the family's words for when it comes; and, once
 * the phone is on it, whether Belay really blocks no app and no website any more. It never says
 * more than the plan does.
 */
object OffBelay {
    /** The family's words are at most this long (the policy's limit). */
    const val MAX_HOW = 1000

    /** What "My stage" says about the last stage. */
    data class Line(
        val position: WireOffBelayPosition,
        /** The family's words for when it comes; null when they haven't written any. */
        val how: String?,
        /** On Off belay, and Belay holds no app back, filters nothing and limits nothing. */
        val blocksNothing: Boolean,
    )

    /**
     * The line for [policy], as the agent's last [plan] enforces it; null when there's nothing to
     * say: no Off belay in the policy (an older server), or a phone on no stage whose family hasn't
     * written when it comes.
     */
    fun line(policy: WirePolicy?, plan: EnforcementPlan?): Line? {
        val off = policy?.offBelay ?: return null
        val how = off.how?.trim()?.take(MAX_HOW)?.takeIf { it.isNotEmpty() }
        if (policy.stage == null && off.position != WireOffBelayPosition.ON && how == null) return null
        return Line(off.position, how, off.position == WireOffBelayPosition.ON && blocksNothing(policy, plan))
    }

    /**
     * Whether Belay blocks no app and no website: nothing suspended or hidden (waiting, blocked,
     * paused, a limit or a schedule), no pause, no web filter or Chrome settings, no time limits or
     * schedules, and nothing kept from installing. Locked settings (like Private DNS) can remain:
     * "This phone's rules" lists them.
     */
    fun blocksNothing(policy: WirePolicy, plan: EnforcementPlan?): Boolean {
        if (plan == null) return false
        val screenTime = policy.screenTime
        return plan.suspend.isEmpty() && plan.hide.isEmpty() && plan.pause == null &&
            plan.privateDns == null && plan.chrome == null &&
            Lock.UNKNOWN_SOURCES !in plan.locks && Lock.UNKNOWN_SOURCES_REGISTERED_STORES !in plan.locks &&
            screenTime?.limits.isNullOrEmpty() && screenTime?.schedules.isNullOrEmpty()
    }
}
