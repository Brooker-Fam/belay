package family.brooker.belay.enforce

import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.BuildConfig
import family.brooker.belay.DebugTools
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.R
import family.brooker.belay.core.ActualState
import family.brooker.belay.core.AnsweredRequest
import family.brooker.belay.core.Applied
import family.brooker.belay.core.ApplyOutcome
import family.brooker.belay.core.Commands
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.EnforcementChanges
import family.brooker.belay.core.EnforcementPlan
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.KidRules
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.PolicyTooLarge
import family.brooker.belay.core.RecoveryRules
import family.brooker.belay.core.Requests
import family.brooker.belay.core.SimRules
import family.brooker.belay.core.WireEnforcement
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.screentime.Decision
import family.brooker.belay.core.screentime.KidArg
import family.brooker.belay.core.screentime.Notices
import family.brooker.belay.core.screentime.ScreenTimeEnforcement
import family.brooker.belay.core.screentime.ScreenTimeState
import family.brooker.belay.core.screentime.Stages
import family.brooker.belay.core.screentime.UsageLog
import family.brooker.belay.core.screentime.WireScreenTime
import family.brooker.belay.screentime.ScreenTimeStep
import family.brooker.belay.service.ScreenTimeNotice
import family.brooker.belay.service.WaitingNotice
import family.brooker.belay.store.AgentStore
import family.brooker.belay.ui.KidWords
import java.util.UUID

/** What the kid's screens show, from the agent's last step. */
data class KidView(
    /** Null before the first policy: Belay enforces nothing yet. */
    val policy: WirePolicy?,
    val plan: EnforcementPlan?,
    val applied: Applied,
    /** Newest first, with the parent's answers: every kind (app, more time, the agreement). */
    val requests: List<AnsweredRequest>,
    /** The Private DNS host Belay has set, if any. */
    val privateDns: String?,
    /** Names of the apps the screens mention: from their developers, so untrusted. */
    val labels: Map<String, String>,
    /** Phase 3: screen time today; null while the policy has none. */
    val screenTime: ScreenTimeView? = null,
) {
    val rules: List<KidRules.Rule> get() = KidRules.of(policy, plan, applied, privateDns)
}

/** Phase 3: what the kid's Today screen shows, as the last step decided it. */
data class ScreenTimeView(
    val policy: WireScreenTime,
    val decision: Decision,
    /** What Belay counted, up to the step's read. */
    val usage: UsageLog,
    /** When today began, as the policy counts days. */
    val todayStart: Long,
)

/**
 * The enforcement part of an agent step, on the agent thread, after the inventory is
 * reconciled: run the policy's new one-shot commands (Phase 10), plan from the stored policy
 * (with the recovery key's repair access, Phase 6), count and decide screen time on top
 * (Phase 3), apply only what changed since Belay's record, lock the screen if a command or a
 * schedule says so, make a request for each new waiting app, and record it all in one
 * transaction. Idempotent: a second run with nothing new changes nothing (a command runs once
 * per id, a notice shows once, a lock happens once).
 */
class EnforcementStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext

    /** [reportChanged]: the enforcement report the server sees has changed (a check-in tells it). */
    data class Result(val view: KidView, val reportChanged: Boolean)

    /**
     * [inventory] is everything installed, hidden apps included. Every step checks that what
     * Belay holds is still in effect (a reinstall clears a suspension, and Android's own
     * Parental Controls can lift one), so it is applied again. After a boot, a full scan or
     * a change of users ([recheckAll]) the restrictions are checked too, and Private DNS.
     */
    fun run(inventory: Map<String, PackageRecord>, recheckAll: Boolean, recheckDns: Boolean): Result {
        val now = System.currentTimeMillis()
        val before = store.applied()
        val reportBefore = lastReport ?: EnforcementReport.of(store, before)
        // The server's last policy answer was too big to read: Belay keeps the last one it read.
        val tooLarge = store.policyTooLarge()
        // With no policy, Belay enforces nothing; if it applied something before (a debug
        // build's test policy), a policy that enforces nothing takes it back. A first policy
        // too big to read is reported the same way: nothing is enforced yet.
        val policy = DebugTools.policyOverride ?: store.policy() ?: WirePolicy(version = 0).takeIf { before.policyVersion != null || tooLarge != null }
        val requests = store.requests()
        val dnsRow = store.privateDns()
        if (policy == null) {
            stopScreenTime()?.let { store.commitEnforcement(null, emptyList(), now, screenTime = it) }
            return Result(KidView(null, null, before, Requests.answered(requests, null), dnsRow?.setHost, labels(inventory, requests, null, null)), false)
        }

        val owner = DeviceOwnerSetup.isDeviceOwner(app)
        // Phase 10: one-shot commands first, once per id: removing another user changes the plan.
        // Phase 3's lock_now waits until the rest is applied.
        val log = store.commandLog()
        val commandPlan = Commands.plan(policy.commands, log.doneIds, now, CommandRunner.RUNS)
        val runner = CommandRunner(app)
        val results = runner.run(commandPlan, owner, now)
        val enforcer = Enforcer(app)
        val actual = if (owner) {
            enforcer.actual(
                suspended = before.suspended.filterTo(HashSet()) { it in inventory },
                hidden = before.hidden.filterTo(HashSet()) { it in inventory },
                locks = if (recheckAll) before.locks else emptySet(),
            )
        } else {
            ActualState()
        }
        val (applied, gone) = Enforcement.reconcile(before, inventory.keys, actual)
        if (owner) enforcer.forget(gone)
        lost(before, applied, gone)

        val roles = PhoneFacts.roles(app)
        val phase2 = Enforcement.plan(
            Enforcement.Input(
                policy, inventory, roles, applied, BuildConfig.DEBUG, Enforcer.sdkFull(), now,
                otherUsers = PhoneFacts.otherUsers(app),
                // Phase 6: the recovery key's repair access lifts debugging and factory reset.
                recoveryUntil = RecoveryRules.openUntil(store.recovery(), now),
            ),
        )
        // Phase 3: screen time counted and decided on top, so one diff applies both.
        val screenTimeStep = policy.screenTime?.let { ScreenTimeStep(app, store) }
        val read = policy.screenTime?.let { screenTimeStep?.read(it, inventory, roles, applied, phase2) }
        val plan = ScreenTimeEnforcement.merge(phase2, read?.decision)
        val changes = Enforcement.changes(plan, applied)
        val outcome = if (owner) enforcer.apply(changes) else notDeviceOwner(changes)
        var next = Enforcement.after(applied, plan, changes, outcome, now)
        if (owner) {
            val message = plan.supportMessage ?: app.getString(R.string.support_message_default)
            next = next.copy(supportMessage = enforcer.supportMessage(message, applied.supportMessage))
            PrivateDns.want(app, plan.privateDns, dnsRow, now, recheck = recheckDns || recheckAll)
        }

        // Phase 3: lock the screen for lock_now commands and for a schedule that locks as it
        // starts, now that the rest is applied; then the notices, and the usage to send.
        val lockResults = runner.lockNow(commandPlan, owner)
        val done = read?.let { screenTimeStep?.after(it) }
        var screenTimeState: ScreenTimeState? = done?.state
        if (done != null && done.locks.isNotEmpty()) {
            Log.i(Agent.TAG, "screen time: locking the screen as ${done.locks.joinToString { it.scheduleId }} starts")
            screenTimeState = screenTimeState?.copy(lockProblem = ScreenLock.lock(app, owner))
        }

        // A swapped SIM card (DISALLOW_SIM_GLOBALLY only stops new eSIMs) is reported for a week.
        val sim = SimRules.next(next.sim, PhoneFacts.sim(app), now)
        val extra = listOfNotNull(
            PrivateDns.problem(plan.privateDns, dnsRow),
            SimRules.problem(sim, now),
            tooLarge?.let { PolicyTooLarge.problem(it.tooLargeBytes) },
            screenTimeState?.lockProblem,
        )
        next = next.copy(sim = sim, problems = (next.problems + extra).distinct().take(Enforcement.MAX_PROBLEMS))

        // Belay asks for each new waiting app at once, so the parent sees it even if the kid
        // never opens Belay. The request goes behind the event that reported the install.
        val made = Requests.toMake(plan.waiting, requests) { inventory[it]?.firstInstallTime }.mapNotNull { name ->
            inventory[name]?.let { KidRequest(UUID.randomUUID().toString(), name, it.label, null, now) }
        }
        val ran = results + lockResults
        val screenTimeWrite = if (done != null && screenTimeState != null) AgentStore.ScreenTimeWrite.Save(done.ledger, screenTimeState) else stopScreenTime()
        store.commitEnforcement(
            applied = next,
            requests = made,
            at = now,
            commands = log.record(ran).takeIf { ran.isNotEmpty() },
            screenTime = screenTimeWrite,
            usage = done?.usage.orEmpty(),
            dropUsage = policy.screenTime?.measure == false && store.pendingUsageCount() > 0,
        )
        PolicyTimer.schedule(app, plan.nextChangeAt)
        log(plan, changes, made)
        // Android's screen for a held-back app can't name it: Belay's notice does.
        if (owner && made.isNotEmpty()) WaitingNotice.show(app, made.map { it.label })
        if (plan.waiting.isEmpty()) WaitingNotice.cancel(app)
        if (done != null) ScreenTimeNotice.apply(app, done.notices, words(inventory), read.now)

        val all = made + requests
        val screenTime = read?.let { ScreenTimeView(it.policy, it.decision, it.update.usage, it.decision.days.startOf(it.decision.day)) }
        val view = KidView(policy, plan, next, Requests.answered(all, policy), dnsRow?.setHost, labels(inventory, all, plan, policy), screenTime)
        // Anything in the report may have changed, here or on another thread since the last step
        // (the update, the recovery key): compare all of it but the count of apps held back, and
        // screen time's minutes, which change every minute the phone is used.
        val report = EnforcementReport.of(store, next)
        lastReport = report
        return Result(view, reportChanged = comparable(report) != comparable(reportBefore))
    }

    /**
     * The policy no longer has screen time: what Belay showed for it goes, and its record (the
     * count and the takes) is deleted. Null when there's nothing to stop.
     */
    private fun stopScreenTime(): AgentStore.ScreenTimeWrite? {
        if (!store.hasScreenTime()) return null
        ScreenTimeNotice.cancel(app, Notices.clear(store.screenTime()?.state ?: ScreenTimeState()))
        Log.i(Agent.TAG, "screen time: off, so Belay stops counting and deletes its count")
        return AgentStore.ScreenTimeWrite.Clear
    }

    private fun words(inventory: Map<String, PackageRecord>) = KidWords(app) { inventory[it]?.label ?: it }

    private fun notDeviceOwner(changes: EnforcementChanges) = ApplyOutcome(
        failedSuspend = changes.suspend,
        failedUnsuspend = changes.unsuspend,
        failedHide = changes.hide,
        failedUnhide = changes.unhide,
        failedLock = changes.lock,
        failedUnlock = changes.unlock,
        autoTimeFailed = changes.autoTime != null,
        chromeFailed = changes.chrome != null,
        frpFailed = changes.frpAccounts != null,
        problems = listOf("Belay isn't the device owner, so it can't apply any rules."),
    )

    /** Logs what something other than Belay undid, which this step applies again. */
    private fun lost(before: Applied, after: Applied, gone: Set<String>) {
        val unsuspended = before.suspended - after.suspended - gone
        val shown = before.hidden - after.hidden - gone
        val unlocked = before.locks - after.locks
        if (unsuspended.isEmpty() && shown.isEmpty() && unlocked.isEmpty()) return
        Log.w(Agent.TAG, "enforce: no longer in effect, applying again: suspended $unsuspended, hidden $shown, locks $unlocked")
    }

    private fun labels(
        inventory: Map<String, PackageRecord>,
        requests: List<KidRequest>,
        plan: EnforcementPlan?,
        policy: WirePolicy?,
    ): Map<String, String> {
        val labels = HashMap<String, String>()
        requests.filter { it.kind == WireRequestKind.APP || it.label.isNotEmpty() }.forEach { labels[it.packageName] = it.label }
        val named = requests.map { it.packageName } + plan?.waiting.orEmpty() + plan?.blocked.orEmpty() + plan?.hiddenBrowsers.orEmpty() +
            screenTimeApps(policy)
        named.forEach { name -> inventory[name]?.let { labels[name] = it.label } }
        return labels
    }

    /** Phase 3: every app the screen time rules (and the next stage's) name, for the kid's screens. */
    private fun screenTimeApps(policy: WirePolicy?): List<String> {
        val rules = listOfNotNull(policy?.screenTime, policy?.stage?.next?.screenTime)
        return rules.flatMap { st -> st.limits.flatMap { it.packages } + st.schedules.flatMap { it.allow } + st.exempt } +
            policy?.let { Stages.next(it) }.orEmpty().flatMap { change ->
                change.kidText.args.filterIsInstance<KidArg.Apps>().flatMap { it.packages }
            }
    }

    private fun log(plan: EnforcementPlan, changes: EnforcementChanges, made: List<KidRequest>) {
        if (changes.none && made.isEmpty()) return
        val parts = listOfNotNull(
            changes.suspend.takeIf { it.isNotEmpty() }?.let { "suspend ${it.sorted()}" },
            changes.hide.takeIf { it.isNotEmpty() }?.let { "hide ${it.sorted()}" },
            changes.unhide.takeIf { it.isNotEmpty() }?.let { "unhide ${it.sorted()}" },
            changes.unsuspend.takeIf { it.isNotEmpty() }?.let { "unsuspend ${it.sorted()}" },
            changes.lock.takeIf { it.isNotEmpty() }?.let { "lock $it" },
            changes.unlock.takeIf { it.isNotEmpty() }?.let { "unlock $it" },
            changes.autoTime?.let { "auto time $it" },
            changes.chrome?.let { "Chrome ${it.javaClass.simpleName.lowercase()}" },
            changes.frpAccounts?.let { "reset protection ${it.javaClass.simpleName.lowercase()}" },
            made.takeIf { it.isNotEmpty() }?.let { list -> "asked for ${list.map { it.packageName }}" },
        )
        val why = changes.suspend.sorted().joinToString { "$it: ${plan.reasons[it].orEmpty().joinToString("+")}" }
        Log.i(Agent.TAG, "enforce: policy ${plan.version}: ${parts.joinToString("; ")}" + if (why.isEmpty()) "" else " (why: $why)")
    }

    private companion object {
        /**
         * The report the last step in this process made. The first step after a start compares
         * with the report from the stored state instead, so starting alone isn't a change.
         */
        @Volatile
        var lastReport: WireEnforcement? = null

        /** The report without what changes by itself: the count of apps held back, and screen time's minutes. */
        fun comparable(report: WireEnforcement?): WireEnforcement? = report?.copy(
            suspendedCount = 0,
            screenTime = report.screenTime?.let { st -> st.copy(usedMinutes = null, limits = st.limits.map { it.copy(used = null, left = null) }) },
        )
    }
}
