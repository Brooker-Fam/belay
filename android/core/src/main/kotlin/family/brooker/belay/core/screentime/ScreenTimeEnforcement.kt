package family.brooker.belay.core.screentime

import family.brooker.belay.core.Applied
import family.brooker.belay.core.EnforcementPlan
import family.brooker.belay.core.NeverBlocked
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.PhoneRoles
import java.time.ZoneId

/**
 * Screen time on top of Phase 2's enforcement plan, so one diff against what Belay applied
 * suspends and lets go of both: the rules' input comes from what Phase 2 already knows (the
 * never-blocked packages, the clock and keyboard, the launchable apps, the pause), and the
 * decision's suspensions join the plan with their reasons.
 */
object ScreenTimeEnforcement {
    /** Phase 2's never-blocked packages on this phone, in full (the report's list is capped). */
    fun neverBlocked(roles: PhoneRoles, apps: Map<String, PackageRecord>, applied: Applied): Set<String> =
        NeverBlocked.of(roles, apps, applied.hidden).keys

    /**
     * The rules' input at [now]: [update] is the read's (null: nothing read, so nothing measured),
     * [apps] every installed package, [plan] Phase 2's plan for the same policy, [takes] the
     * self-serve minutes the kid took.
     */
    fun input(
        policy: WireScreenTime,
        now: Long,
        phoneZone: ZoneId,
        update: UsageUpdate?,
        apps: Map<String, PackageRecord>,
        roles: PhoneRoles,
        applied: Applied,
        plan: EnforcementPlan,
        takes: List<SelfServeTake>,
    ): Rules.Input = Rules.Input(
        policy = policy,
        now = now,
        phoneZone = phoneZone,
        usage = update?.usage,
        foreground = update?.foreground.orEmpty(),
        measured = update?.measured ?: false,
        apps = apps.values.filter { it.launchable }.mapTo(HashSet()) { it.packageName },
        neverBlocked = neverBlocked(roles, apps, applied),
        keepOpen = roles.pauseExempt,
        selfServe = takes,
        pause = plan.pause,
    )

    /**
     * [plan] with [decision] in it: its suspensions added, each with its reasons (ReasonCode.code,
     * after Phase 2's), its problems, its next boundary as the plan's next change (when the agent
     * sets its alarm), and its report. Null: no screen time, the plan as it is.
     */
    fun merge(plan: EnforcementPlan, decision: Decision?): EnforcementPlan {
        if (decision == null) return plan
        val reasons = sortedMapOf<String, List<String>>()
        reasons.putAll(plan.reasons)
        for ((name, suspension) in decision.suspend) {
            val codes = suspension.reasons.map { it.code.code }
            reasons[name] = (reasons[name].orEmpty() + codes).distinct()
        }
        return plan.copy(
            suspend = plan.suspend + decision.suspend.keys,
            reasons = reasons,
            problems = (plan.problems + decision.problems).distinct(),
            nextChangeAt = listOfNotNull(plan.nextChangeAt, decision.nextAt).minOrNull(),
            screenTime = decision.status(),
        )
    }
}
