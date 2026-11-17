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
import family.brooker.belay.service.WaitingNotice
import family.brooker.belay.store.AgentStore
import java.util.UUID

/** What the kid's screens show, from the agent's last step. */
data class KidView(
    /** Null before the first policy: Belay enforces nothing yet. */
    val policy: WirePolicy?,
    val plan: EnforcementPlan?,
    val applied: Applied,
    /** Newest first, with the parent's answers. */
    val requests: List<AnsweredRequest>,
    /** The Private DNS host Belay has set, if any. */
    val privateDns: String?,
    /** Names of the apps the screens mention: from their developers, so untrusted. */
    val labels: Map<String, String>,
) {
    val rules: List<KidRules.Rule> get() = KidRules.of(policy, plan, applied, privateDns)
}

/**
 * The enforcement part of an agent step, on the agent thread, after the inventory is
 * reconciled: run the policy's new one-shot commands (Phase 10), plan from the stored policy
 * (with the recovery key's repair access, Phase 6), apply only what changed since Belay's
 * record, make a request for each new waiting app, and record it all in one transaction.
 * Idempotent: a second run with nothing new changes nothing (a command runs once per id).
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
            return Result(KidView(null, null, before, Requests.answered(requests, null), dnsRow?.setHost, labels(inventory, requests, null)), false)
        }

        val owner = DeviceOwnerSetup.isDeviceOwner(app)
        // Phase 10: one-shot commands first, once per id: removing another user changes the plan.
        val log = store.commandLog()
        val commandPlan = Commands.plan(policy.commands, log.doneIds, now, CommandRunner.RUNS)
        val results = CommandRunner(app).run(commandPlan, owner, now)
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
        val plan = Enforcement.plan(
            Enforcement.Input(
                policy, inventory, roles, applied, BuildConfig.DEBUG, Enforcer.sdkFull(), now,
                otherUsers = PhoneFacts.otherUsers(app),
                // Phase 6: the recovery key's repair access lifts debugging and factory reset.
                recoveryUntil = RecoveryRules.openUntil(store.recovery(), now),
            ),
        )
        val changes = Enforcement.changes(plan, applied)
        val outcome = if (owner) enforcer.apply(changes) else notDeviceOwner(changes)
        var next = Enforcement.after(applied, plan, changes, outcome, now)
        if (owner) {
            val message = plan.supportMessage ?: app.getString(R.string.support_message_default)
            next = next.copy(supportMessage = enforcer.supportMessage(message, applied.supportMessage))
            PrivateDns.want(app, plan.privateDns, dnsRow, now, recheck = recheckDns || recheckAll)
        }
        // A swapped SIM card (DISALLOW_SIM_GLOBALLY only stops new eSIMs) is reported for a week.
        val sim = SimRules.next(next.sim, PhoneFacts.sim(app), now)
        val extra = listOfNotNull(
            PrivateDns.problem(plan.privateDns, dnsRow),
            SimRules.problem(sim, now),
            tooLarge?.let { PolicyTooLarge.problem(it.tooLargeBytes) },
        )
        next = next.copy(sim = sim, problems = (next.problems + extra).distinct().take(Enforcement.MAX_PROBLEMS))

        // Belay asks for each new waiting app at once, so the parent sees it even if the kid
        // never opens Belay. The request goes behind the event that reported the install.
        val made = Requests.toMake(plan.waiting, requests) { inventory[it]?.firstInstallTime }.mapNotNull { name ->
            inventory[name]?.let { KidRequest(UUID.randomUUID().toString(), name, it.label, null, now) }
        }
        store.commitEnforcement(next, made, now, log.record(results).takeIf { results.isNotEmpty() })
        PolicyTimer.schedule(app, plan.nextChangeAt)
        log(plan, changes, made)
        // Android's screen for a held-back app can't name it: Belay's notice does.
        if (owner && made.isNotEmpty()) WaitingNotice.show(app, made.map { it.label })
        if (plan.waiting.isEmpty()) WaitingNotice.cancel(app)

        val all = made + requests
        val view = KidView(policy, plan, next, Requests.answered(all, policy), dnsRow?.setHost, labels(inventory, all, plan))
        // Anything in the report may have changed, here or on another thread since the last step
        // (the update, the recovery key): compare all of it but the count of apps held back.
        val report = EnforcementReport.of(store, next)
        lastReport = report
        return Result(view, reportChanged = report?.copy(suspendedCount = 0) != reportBefore?.copy(suspendedCount = 0))
    }

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

    private fun labels(inventory: Map<String, PackageRecord>, requests: List<KidRequest>, plan: EnforcementPlan?): Map<String, String> {
        val labels = HashMap<String, String>()
        requests.forEach { labels[it.packageName] = it.label }
        val named = requests.map { it.packageName } + plan?.waiting.orEmpty() + plan?.blocked.orEmpty() + plan?.hiddenBrowsers.orEmpty()
        named.forEach { name -> inventory[name]?.let { labels[name] = it.label } }
        return labels
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
        Log.i(Agent.TAG, "enforce: policy ${plan.version}: ${parts.joinToString("; ")}")
    }

    private companion object {
        /**
         * The report the last step in this process made. The first step after a start compares
         * with the report from the stored state instead, so starting alone isn't a change.
         */
        @Volatile
        var lastReport: WireEnforcement? = null
    }
}
