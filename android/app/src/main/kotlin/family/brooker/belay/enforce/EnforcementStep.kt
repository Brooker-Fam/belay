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
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.EnforcementChanges
import family.brooker.belay.core.EnforcementPlan
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.KidRules
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.Requests
import family.brooker.belay.core.WirePolicy
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
 * reconciled: plan from the stored policy, apply only what changed since Belay's record,
 * make a request for each new waiting app, and record it all in one transaction.
 * Idempotent: a second run with nothing new changes nothing.
 */
class EnforcementStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext

    /** [reportChanged]: the enforcement report the server sees has changed (a check-in tells it). */
    data class Result(val view: KidView, val reportChanged: Boolean)

    /**
     * [inventory] is everything installed, hidden apps included; [changed] the packages this
     * step saw change. After a boot or a full scan ([fullScan]) everything Belay holds is
     * checked against the phone; otherwise only what changed, so a reinstalled app (which
     * loses its suspension) is caught at once.
     */
    fun run(inventory: Map<String, PackageRecord>, changed: Set<String>, fullScan: Boolean, recheckDns: Boolean): Result {
        val now = System.currentTimeMillis()
        val policy = DebugTools.policyOverride ?: store.policy()
        val before = store.applied()
        val requests = store.requests()
        val dnsRow = store.privateDns()
        if (policy == null) {
            return Result(KidView(null, null, before, Requests.answered(requests, null), dnsRow?.setHost, labels(inventory, requests, null)), false)
        }

        val owner = DeviceOwnerSetup.isDeviceOwner(app)
        val enforcer = Enforcer(app)
        val held = before.suspended + before.hidden
        val toCheck = (if (fullScan) held else held.intersect(changed)).filter { it in inventory }.toSet()
        val actual = if (owner) enforcer.actual(toCheck, if (fullScan) before.locks else emptySet()) else ActualState()
        val (applied, gone) = Enforcement.reconcile(before, inventory.keys, actual)
        if (owner) enforcer.forget(gone)

        val roles = PhoneFacts.roles(app)
        val plan = Enforcement.plan(
            Enforcement.Input(policy, inventory, roles, applied, BuildConfig.DEBUG, Enforcer.sdkFull(), now),
        )
        val changes = Enforcement.changes(plan, applied)
        val outcome = if (owner) enforcer.apply(changes) else notDeviceOwner(changes)
        var next = Enforcement.after(applied, plan, changes, outcome, now)
        if (owner) {
            val message = plan.supportMessage ?: app.getString(R.string.support_message_default)
            next = next.copy(supportMessage = enforcer.supportMessage(message, applied.supportMessage))
            PrivateDns.want(app, plan.privateDns, dnsRow, now, recheck = recheckDns || fullScan)
        }
        PrivateDns.problem(plan.privateDns, dnsRow)?.let {
            next = next.copy(problems = (next.problems + it).take(Enforcement.MAX_PROBLEMS))
        }

        // Belay asks for each new waiting app at once, so the parent sees it even if the kid
        // never opens Belay. The request goes behind the event that reported the install.
        val made = Requests.toMake(plan.waiting, requests).mapNotNull { name ->
            inventory[name]?.let { KidRequest(UUID.randomUUID().toString(), name, it.label, null, now) }
        }
        store.commitEnforcement(next, made, now)
        PolicyTimer.schedule(app, plan.nextChangeAt)
        log(plan, changes, made)

        val all = made + requests
        val view = KidView(policy, plan, next, Requests.answered(all, policy), dnsRow?.setHost, labels(inventory, all, plan))
        return Result(view, reportChanged = reportChanged(before, next))
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

    private fun reportChanged(before: Applied, after: Applied): Boolean {
        val a = Enforcement.report(before)
        val b = Enforcement.report(after)
        return a?.policyVersion != b?.policyVersion || a?.problems != b?.problems
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
}
