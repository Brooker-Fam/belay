package family.brooker.belay.screentime

import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.core.Applied
import family.brooker.belay.core.EnforcementPlan
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.PhoneRoles
import family.brooker.belay.core.screentime.Decision
import family.brooker.belay.core.screentime.LockNow
import family.brooker.belay.core.screentime.NoticePlan
import family.brooker.belay.core.screentime.Notices
import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.ScreenTime
import family.brooker.belay.core.screentime.ScreenTimeEnforcement
import family.brooker.belay.core.screentime.ScreenTimeState
import family.brooker.belay.core.screentime.Upkeep
import family.brooker.belay.core.screentime.UsageLedger
import family.brooker.belay.core.screentime.UsageUpdate
import family.brooker.belay.core.screentime.UsageUploads
import family.brooker.belay.core.screentime.WireScreenTime
import family.brooker.belay.core.screentime.WireUsageDay
import family.brooker.belay.store.AgentStore
import java.time.ZoneId

/**
 * Screen time's part of an enforcement step (Phase 3), on the agent thread. [read] counts what
 * Android recorded since the last step (UsageReader, into core's ledger) and decides with core's
 * Rules; EnforcementStep merges the decision into Phase 2's plan and applies both; [after] works
 * out the notices, the screen locks and the usage days to send, and what to keep. Idempotent: a
 * second step with nothing new counts nothing twice, shows nothing twice and locks nothing twice.
 */
class ScreenTimeStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext

    /** Counted and decided, before applying. [now] is when Android's events were read. */
    class Read(
        val policy: WireScreenTime,
        val now: Long,
        val zone: ZoneId,
        val update: UsageUpdate,
        val state: ScreenTimeState,
        val decision: Decision,
        val neverBlocked: Set<String>,
    )

    /** What to keep and do once the step applied the decision. */
    class Done(
        val ledger: UsageLedger,
        val state: ScreenTimeState,
        val usage: List<WireUsageDay>,
        val notices: NoticePlan,
        val locks: List<LockNow>,
    )

    fun read(
        policy: WireScreenTime,
        inventory: Map<String, PackageRecord>,
        roles: PhoneRoles,
        applied: Applied,
        plan: EnforcementPlan,
    ): Read {
        val stored = store.screenTime()
        val zone = ZoneId.systemDefault()
        val ledger = stored?.ledger ?: Upkeep.newLedger(policy, System.currentTimeMillis(), zone).also {
            Log.i(Agent.TAG, "screen time: counting from ${it.cursor}")
        }
        val state = stored?.state ?: ScreenTimeState()
        val (reading, update) = UsageReader(app).read(ledger)
        if (update.clockShift != 0L) Log.w(Agent.TAG, "screen time: the clock moved by ${update.clockShift / 1000} s")
        if (!update.measured) Log.w(Agent.TAG, "screen time: can't count (usage access is off)")
        val input = ScreenTimeEnforcement.input(policy, reading.wall, zone, update, inventory, roles, applied, plan, state.takes)
        return Read(policy, reading.wall, zone, update, state, Rules.evaluate(input), input.neverBlocked)
    }

    fun after(read: Read): Done {
        val notices = Notices.plan(read.decision, read.state, read.now)
        val (locks, locked) = Upkeep.locks(read.decision, notices.state, read.now)
        val days = read.decision.days
        val uploads = UsageUploads.plan(
            measure = read.policy.measure,
            usage = read.update.usage,
            days = days,
            now = read.now,
            state = locked.uploads,
            clockShift = read.update.clockShift,
            unlisted = read.neverBlocked,
            force = DebugTools.takeUsageUpload(),
        )
        if (uploads.days.isNotEmpty()) Log.i(Agent.TAG, "screen time: sending ${uploads.days.map { it.day + if (it.complete) " (complete)" else "" }}")
        return Done(
            ledger = ScreenTime.prune(read.update.ledger, Upkeep.keepFrom(days, read.now)),
            state = Upkeep.pruned(locked.copy(uploads = uploads.state), read.now),
            usage = uploads.days,
            notices = notices,
            locks = locks,
        )
    }
}
