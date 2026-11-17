package family.brooker.belay

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.RecoveryClock
import family.brooker.belay.core.RecoveryOutcome
import family.brooker.belay.core.RecoveryRules
import family.brooker.belay.core.RecoveryState
import family.brooker.belay.core.Requests
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.Upkeep
import family.brooker.belay.core.screentime.WireAgreementAnswer
import family.brooker.belay.enforce.EnforcementStep
import family.brooker.belay.enforce.KidView
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.Health
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.Reconciler
import family.brooker.belay.screentime.ScreenWatcher
import family.brooker.belay.service.BelayService
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.StateDump
import family.brooker.belay.sync.PolicyPoll
import family.brooker.belay.sync.Sync
import family.brooker.belay.sync.SyncWork
import family.brooker.belay.update.AgentUpdater
import family.brooker.belay.work.WatchdogWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Executors

/**
 * What woke the agent. Every trigger runs the same idempotent steps. [checkin]: the sync
 * that follows checks in with the server even if a check-in isn't due yet. [setup]: the step
 * also applies the device-owner setup again (frequent package triggers skip it).
 */
enum class Trigger(val label: String, val heartbeat: Boolean, val checkin: Boolean = false, val setup: Boolean = true) {
    ADMIN_ENABLED("device admin enabled", true),
    OWNER_CHANGED("device owner changed", true),
    PROVISIONED("provisioning finished", true),
    BOOT("phone started", true),
    AGENT_UPDATED("Belay updated", true),
    SERVICE_STARTED("service started", true, checkin = true),
    ADMIN_SERVICE_BOUND("admin service bound", true),
    WATCHDOG("periodic check", true),
    ENROLLED("enrolled", true, checkin = true),
    CAMERA_DONE("enrollment screen closed", false),
    PACKAGE_BROADCAST("package broadcast", false, setup = false),
    APP_OPENED("Belay opened", false),

    /** Phase 2: a new policy arrived (long-poll or check-in). */
    POLICY("new policy", false),

    /** Phase 2: a pause or repair time ended; Phase 3: or screen time's next boundary came. */
    POLICY_TIMER("a rule's time came", false),

    /** Phase 2: the Private DNS thread finished, or its retry is due. */
    PRIVATE_DNS("Private DNS updated", false),
    PRIVATE_DNS_RETRY("Private DNS retry", false),

    /** Phase 2: apps were unsuspended (maybe not by Belay): what Belay holds is checked again. */
    SUSPENSION_CHANGED("apps unsuspended", false, setup = false),

    /** Phase 2: a user or profile was added or removed (DeviceAdminReceiver.onUserAdded/Removed). */
    USERS_CHANGED("users changed", true),

    /** Phase 6: the update thread recorded a new state for the offered update. */
    AGENT_UPDATE("update went on", false, setup = false),

    /** Phase 6: the recovery key opened repair access. */
    RECOVERY("recovery key used", false),

    /** The server's policy answer was too big to read, or readable again. */
    POLICY_UNREADABLE("policy too big to read", false, setup = false),

    /** Phase 3: the screen came on or went off, or the phone was unlocked (ScreenWatcher). */
    SCREEN_ON("screen on", false, setup = false),
    SCREEN_OFF("screen off", false, setup = false),
    USER_PRESENT("phone unlocked", false, setup = false),

    /** Phase 3: every 60 seconds while the screen is on and the policy has screen time. */
    SCREEN_TIME_TICK("screen time", false, setup = false),

    /** Phase 3: the clock or the time zone changed. */
    CLOCK_CHANGED("clock or time zone changed", true),

    /** Phase 3: usage access for Belay was turned off or on. */
    USAGE_ACCESS_CHANGED("usage access changed", true, setup = false),

    /** Phase 3: the kid took self-serve minutes. */
    SELF_SERVE("extra minutes taken", false, setup = false),
}

/** Everything the main screen shows from the agent's last step. */
data class AgentView(
    val health: Health,
    val device: WireDevice,
    val inventory: Map<String, PackageRecord>,
    /** Newest first. */
    val changes: List<AppChange>,
    /** Newest first. */
    val heartbeats: List<Heartbeat>,
    /** Phase 2: the rules, waiting apps, answers and pause, for the kid. */
    val kid: KidView,
    /** Phase 6: how the last offered update went, for About Belay. */
    val update: UpdateRecord? = null,
    /** Phase 6: the recovery key's tries and last use, for the Recovery screen. */
    val recovery: RecoveryState = RecoveryState(),
)

object Agent {
    const val TAG = "Belay"

    // One thread for all agent work, so the baseline, the log and Belay's record of what it
    // enforces have a single writer.
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-agent") }
    private val _view = MutableStateFlow<AgentView?>(null)
    val view: StateFlow<AgentView?> = _view.asStateFlow()

    /**
     * Runs the agent's steps on its own thread:
     * 1. If Belay is device owner, apply its setup again (idempotent) and make sure the
     *    service and the periodic checks are running.
     * 2. Reconcile the inventory: getChangedPackages since the last check, or a full scan
     *    after a boot, once a day and after enrolling. What it finds goes into the outbox
     *    in the same transaction.
     * 3. Enforce the stored policy (Phase 2): suspend a new app that waits for a parent in
     *    the same step that found it, and ask for it; apply only what changed.
     * 4. Publish the result for the main screen, and ask the sync thread to send (with a
     *    check-in when what Belay enforces changed, so the parent sees it applied).
     *
     * [done] runs afterwards on the agent thread; receivers pass PendingResult.finish.
     */
    fun handle(
        context: Context,
        trigger: Trigger,
        packages: Set<String> = emptySet(),
        done: (() -> Unit)? = null,
    ) {
        val app = context.applicationContext
        executor.execute {
            try {
                step(app, trigger, packages)
            } finally {
                done?.invoke()
            }
        }
    }

    /** One step, on the agent thread (see [handle]). Never throws. */
    private fun step(app: Context, trigger: Trigger, packages: Set<String>) {
        val started = System.nanoTime()
        Log.i(TAG, "step: ${trigger.label}" + if (packages.isEmpty()) "" else " $packages")
        try {
            val store = AgentStore.get(app)
            val connection = ConnectionStore.read(app)
            if (trigger.setup) {
                if (DeviceOwnerSetup.isDeviceOwner(app)) {
                    DeviceOwnerSetup.ensure(app)
                    BelayService.start(app)
                    WatchdogWorker.schedule(app)
                }
                if (connection.connected) SyncWork.scheduleCheckins(app)
            }
            val health = HealthReader(app).read()
            var device: WireDevice? = null
            val readDevice = { DeviceStatus.read(app, health).also { device = it } }
            // Set by enrollment until a full inventory is queued, so a restart can't lose it.
            val wanted = if (connection.connected && connection.inventoryWanted) "enrolled" else null
            val outcome = Reconciler(app, store).run(trigger, packages, wanted, readDevice)
            if (wanted != null && outcome.snapshotQueued) ConnectionStore.inventoryQueued(app)
            val enforcement = EnforcementStep(app, store).run(
                inventory = outcome.baseline.inventory,
                recheckAll = outcome.snapshotQueued || trigger == Trigger.USERS_CHANGED,
                recheckDns = trigger == Trigger.PRIVATE_DNS_RETRY,
            )
            publish(store, health, device ?: readDevice(), outcome.baseline.inventory, enforcement.view)
            DebugTools.afterStep(app) { StateDump.json(store, connection) }
            Sync.request(app, checkin = trigger.checkin)
            // The parent page shows the policy as applied once the server hears so.
            if (enforcement.reportChanged) Sync.checkinSoon(app)
            // A new connection: the long-poll asks the new server at once.
            if (trigger == Trigger.ENROLLED) PolicyPoll.kick()
            // Phase 6: the update thread looks at the offer the applied policy carries.
            AgentUpdater.offered(app, enforcement.view.policy?.agentUpdate)
            // Phase 3: screen time is read every minute the screen is on, while the policy has it.
            ScreenWatcher.want(app, enforcement.view.policy?.screenTime != null)
        } catch (t: Throwable) {
            Log.e(TAG, "agent step failed (${trigger.label})", t)
        } finally {
            Log.i(TAG, "step done: ${trigger.label} in ${(System.nanoTime() - started) / 1_000_000} ms")
        }
    }

    /**
     * Phase 6: [typed] is tried as the recovery key, offline, against the stored policy's check
     * (core's RecoveryRules: the waits after wrong tries, and a used version never works again).
     * On the agent thread, the recovery state's only writer; a right key opens repair access in
     * the same task (the step lifts the locks) and the phone checks in soon after. [done] gets
     * the outcome (null if something went wrong) on the agent thread. The key is never logged.
     */
    fun recover(context: Context, typed: String, done: (RecoveryOutcome?) -> Unit) {
        val app = context.applicationContext
        executor.execute {
            val outcome = try {
                val store = AgentStore.get(app)
                val policy = DebugTools.policyOverride ?: store.policy()
                val clock = RecoveryClock(System.currentTimeMillis(), bootCount(app), SystemClock.elapsedRealtime())
                val before = store.recovery()
                val (state, outcome) = RecoveryRules.attempt(before, policy?.recovery, typed, clock)
                if (state != before) store.saveRecovery(state, clock.now)
                Log.i(TAG, "recovery key: ${outcome.javaClass.simpleName.lowercase()}" + if (state.wrongTries > 0) " (wrong tries: ${state.wrongTries})" else "")
                _view.value?.let { _view.value = it.copy(recovery = state) }
                outcome
            } catch (t: Throwable) {
                Log.e(TAG, "recovery key check failed", t)
                null
            }
            if (outcome is RecoveryOutcome.Opened) {
                step(app, Trigger.RECOVERY, emptySet())
                Sync.checkinSoon(app)
            }
            done(outcome)
        }
    }

    private fun bootCount(app: Context): Int? =
        Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 }

    /**
     * The kid asks a parent for [packageName], with [reason] (their own words, or none), from
     * Belay's screen. On the agent thread like every other write: the open request for the app
     * gets the new reason (the server updates it by id), or a new request is made. Queued in
     * the outbox and sent right away.
     */
    fun ask(context: Context, packageName: String, reason: String?, done: (() -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            try {
                val store = AgentStore.get(app)
                val now = System.currentTimeMillis()
                val label = store.loadBaseline().inventory[packageName]?.label
                    ?: store.requests().firstOrNull { it.kind == WireRequestKind.APP && it.packageName == packageName }?.label
                    ?: packageName
                val answered = Requests.answered(store.requests(), DebugTools.policyOverride ?: store.policy())
                val request = Requests.send(answered, packageName, label, reason, now) { UUID.randomUUID().toString() }
                store.commitEnforcement(null, listOf(request), now)
                Log.i(TAG, "asked for $packageName (request ${request.id}, send ${request.revision})")
                showRequests(store)
                Sync.request(app)
            } catch (t: Throwable) {
                Log.e(TAG, "asking for $packageName failed", t)
            } finally {
                done?.invoke()
            }
        }
    }

    /**
     * Phase 3: the kid asks a parent for [minutes] more for the limit [limitId] today, from the
     * app [packageName] (a time's-up notification) or Belay's screen, with [reason] (their own
     * words, or none). Like [ask]: on the agent thread, queued and sent right away. While the
     * request for that limit today is open, asking again sends only the new reason.
     */
    fun askMoreTime(context: Context, limitId: String, minutes: Int, packageName: String?, reason: String?, done: (() -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            try {
                val store = AgentStore.get(app)
                val policy = DebugTools.policyOverride ?: store.policy()
                val screenTime = policy?.screenTime
                if (screenTime == null) {
                    Log.w(TAG, "more time asked for, but the policy has no screen time")
                    return@execute
                }
                val now = System.currentTimeMillis()
                val days = Rules.dayClock(screenTime, ZoneId.systemDefault())
                val label = packageName?.let { store.loadBaseline().inventory[it]?.label }
                val answered = Requests.answered(store.requests(), policy)
                val request = Requests.moreTime(answered, limitId, minutes, packageName, label, reason, now, days.startOf(days.dayAt(now))) {
                    UUID.randomUUID().toString()
                }
                store.commitEnforcement(null, listOf(request), now)
                Log.i(TAG, "asked for ${request.minutes} more minutes for $limitId (request ${request.id}, send ${request.revision})")
                showRequests(store)
                Sync.request(app)
            } catch (t: Throwable) {
                Log.e(TAG, "asking for more time failed", t)
            } finally {
                done?.invoke()
            }
        }
    }

    /**
     * Phase 3: the kid takes self-serve minutes for the limit [limitId] (only for [packageName]
     * when given), as the policy's self_serve allows. [id] is made once per tap on the screen, so
     * a double tap takes once. A step follows at once, so the app opens again. [done] gets
     * whether it was taken, on the agent thread.
     */
    fun takeMinutes(context: Context, limitId: String, packageName: String?, id: String, done: ((Boolean) -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            val taken = try {
                val store = AgentStore.get(app)
                val policy = (DebugTools.policyOverride ?: store.policy())?.screenTime
                val state = store.screenTime()?.state
                val now = System.currentTimeMillis()
                val result = if (policy == null || state == null) null else Upkeep.take(policy, state, now, ZoneId.systemDefault(), id, limitId, packageName)
                if (result == null) {
                    Log.w(TAG, "self-serve minutes for $limitId not taken: the rule doesn't allow it now")
                    false
                } else {
                    Log.i(TAG, "self-serve: ${result.first.minutes} minutes for $limitId taken")
                    store.saveScreenTimeState(result.second, now)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "taking self-serve minutes failed", t)
                false
            }
            if (taken) step(app, Trigger.SELF_SERVE, emptySet())
            done?.invoke(taken)
        }
    }

    /**
     * Phase 3: the kid's [answer] to version [version] of the family agreement, with [reason]
     * (their own words, or none). Like [ask]: queued and sent right away.
     */
    fun answerAgreement(context: Context, version: Int, answer: WireAgreementAnswer, reason: String?, done: (() -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            try {
                val store = AgentStore.get(app)
                val now = System.currentTimeMillis()
                val answered = Requests.answered(store.requests(), DebugTools.policyOverride ?: store.policy())
                val request = Requests.agreement(answered, version, answer, reason, now) { UUID.randomUUID().toString() }
                store.commitEnforcement(null, listOf(request), now)
                Log.i(TAG, "answered agreement version $version (request ${request.id}, send ${request.revision})")
                showRequests(store)
                Sync.request(app)
            } catch (t: Throwable) {
                Log.e(TAG, "answering the agreement failed", t)
            } finally {
                done?.invoke()
            }
        }
    }

    /** The kid's screens show a new request at once, without waiting for a step. */
    private fun showRequests(store: AgentStore) {
        _view.value?.let { view ->
            _view.value = view.copy(kid = view.kid.copy(requests = Requests.answered(store.requests(), view.kid.policy)))
        }
    }

    private fun publish(store: AgentStore, health: Health, device: WireDevice, inventory: Map<String, PackageRecord>, kid: KidView) {
        _view.value = AgentView(
            health = health,
            device = device,
            inventory = inventory,
            changes = store.recentChanges(SCREEN_CHANGES),
            heartbeats = store.recentHeartbeats(SCREEN_HEARTBEATS),
            kid = kid,
            update = store.agentUpdate(),
            recovery = store.recovery(),
        )
    }

    private const val SCREEN_CHANGES = 30
    private const val SCREEN_HEARTBEATS = 24
}
