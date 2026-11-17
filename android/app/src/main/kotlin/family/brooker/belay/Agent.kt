package family.brooker.belay

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.RecoveryClock
import family.brooker.belay.core.RecoveryOutcome
import family.brooker.belay.core.RecoveryRules
import family.brooker.belay.core.RecoveryState
import family.brooker.belay.core.Requests
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.calls.AndroidCalls
import family.brooker.belay.calls.CallsGate
import family.brooker.belay.calls.CallsStep
import family.brooker.belay.calls.CallsView
import family.brooker.belay.calls.Dialer
import family.brooker.belay.calls.EndedCall
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallsPlan
import family.brooker.belay.core.calls.CallsState
import family.brooker.belay.core.kid.Told
import family.brooker.belay.core.location.FixWant
import family.brooker.belay.core.location.HelpShare
import family.brooker.belay.core.location.LocationState
import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.WireFixReason
import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.Upkeep
import family.brooker.belay.core.screentime.WireAgreementAnswer
import family.brooker.belay.enforce.EnforcementStep
import family.brooker.belay.enforce.KidView
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.Health
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.Reconciler
import family.brooker.belay.network.NetworkLogStep
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

    /** Phase 4: the location collector finished an attempt (a fix, or none). */
    LOCATION_FIX("a location fix came", false, setup = false),

    /** Phase 4: a periodic or lost-mode fix is due (LocationTimer). */
    LOCATION_DUE("a location check is due", false, setup = false),

    /** Phase 7: the kid asked for help, or chose to share where the phone is with it. */
    HELP("help asked for", false, setup = false),

    /** Phase 7: Belay's screens closed while a help fix's grant waited for that. */
    SCREENS_CLOSED("Belay's screens closed", false, setup = false),

    /** Phase 5: a call was decided, or ended (calls/CallFlow.kt). */
    CALL("a call came or ended", false, setup = false),

    /** Phase 5: the phone's default dialer changed (calls/DialerWatcher.kt). */
    DIALER_CHANGED("the phone's calling app changed", false),

    /** Phase 3: Android has a batch of network logs ready (AdminReceiver.onNetworkLogsAvailable). */
    NETWORK_LOGS("network logs ready", false, setup = false),
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
    /** Phase 7: "What Belay told your parent", the newest first (the last 30 days). */
    val told: List<ToldEntry> = emptyList(),
    /** Phase 5: Belay's dialer; null while the policy has no calls. */
    val calls: CallsView? = null,
)

object Agent {
    const val TAG = "Belay"

    // One thread for all agent work, so the baseline, the log and Belay's record of what it
    // enforces have a single writer.
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-agent") }
    private val _view = MutableStateFlow<AgentView?>(null)
    val view: StateFlow<AgentView?> = _view.asStateFlow()

    /**
     * Phase 7: one of Belay's screens is showing (MainActivity between onStart and onStop). A help
     * fix's location grant waits until they're closed: Android restarts Belay when it loses a
     * permission, which would close the help screen.
     */
    @Volatile
    var screensVisible: Boolean = false
        private set

    /** Phase 7: a help fix's grant waits for the screens to close (as the last step saw it). */
    @Volatile
    private var sharing: Boolean = false

    fun screens(context: Context, visible: Boolean) {
        screensVisible = visible
        if (!visible && sharing) handle(context, Trigger.SCREENS_CLOSED)
    }

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
            publish(app, store, health, device ?: readDevice(), outcome.baseline.inventory, enforcement.view)
            DebugTools.afterStep(app) { StateDump.json(app, store, connection) }
            Sync.request(app, checkin = trigger.checkin)
            // The parent page shows the policy as applied once the server hears so.
            if (enforcement.reportChanged) Sync.checkinSoon(app)
            // A new connection: the long-poll asks the new server at once.
            if (trigger == Trigger.ENROLLED) PolicyPoll.kick()
            // Phase 6: the update thread looks at the offer the applied policy carries.
            AgentUpdater.offered(app, enforcement.view.policy?.agentUpdate)
            // Phase 3: screen time is read every minute the screen is on, while the policy has it.
            ScreenWatcher.want(app, enforcement.view.policy?.screenTime != null)
            sharing = store.locationState()?.help != null
            // Phase 5: calls decide from what this step applied, until the next one.
            CallsGate.publish(DebugTools.policyOverride ?: store.policy(), store.callsState())
            // Phase 5: calls went off: the dialer role goes back, and Belay's dialer is disabled.
            enforcement.calls?.let { CallsStep.after(app, it) }
            // Phase 4: last of all, a location permission Belay no longer should hold is denied
            // (Phase 5: or a call permission). Android then stops Belay's processes and starts
            // them again (platform notes L7); everything above is stored, and the sync after the
            // restart sends what waits.
            if (enforcement.revoke) DeviceOwnerSetup.revokeUnwanted(app)
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

    /**
     * Phase 7: "I need help", sent at once with no words needed; the kid's [reason] goes with it if
     * they wrote some. With [share], the kid chose to share where the phone is, once (see
     * [shareWhereThePhoneIs]). [done] gets the request's id (null if something went wrong), on the
     * agent thread.
     */
    fun askHelp(context: Context, reason: String?, share: Boolean, done: ((String?) -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            val id = try {
                val store = AgentStore.get(app)
                val now = System.currentTimeMillis()
                val request = Requests.help(reason, sharing = share, now) { UUID.randomUUID().toString() }
                store.commitEnforcement(null, listOf(request), now)
                Log.i(TAG, "asked for help (request ${request.id}${if (share) ", sharing where the phone is" else ""})")
                if (share) wantHelpFix(store, request.id, now)
                showRequests(store)
                Sync.request(app)
                request.id
            } catch (t: Throwable) {
                Log.e(TAG, "asking for help failed", t)
                null
            }
            if (id != null && share) step(app, Trigger.HELP, emptySet())
            done?.invoke(id)
        }
    }

    /**
     * Phase 7: the kid chose to share where the phone is with help request [requestId], once, even
     * if the family has location off: Belay grants itself location by policy for that one fix (and
     * turns location on for it if it's off), adds the fix to the request, and then puts both back
     * once Belay's screens are closed (platform notes L1, L7). Nothing if it's shared already.
     */
    fun shareWhereThePhoneIs(context: Context, requestId: String, done: (() -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            val started = try {
                val store = AgentStore.get(app)
                val help = store.requests().firstOrNull { it.id == requestId && it.kind == WireRequestKind.HELP }
                if (help == null || help.location != null || help.sharing || help.withdrawnAt != null) {
                    false
                } else {
                    val now = System.currentTimeMillis()
                    store.commitEnforcement(null, listOf(help.copy(sharing = true, shareFailed = false)), now)
                    wantHelpFix(store, requestId, now)
                    Log.i(TAG, "help request $requestId: sharing where the phone is")
                    showRequests(store)
                    true
                }
            } catch (t: Throwable) {
                Log.e(TAG, "sharing where the phone is failed", t)
                false
            }
            if (started) step(app, Trigger.HELP, emptySet())
            done?.invoke()
        }
    }

    /** The help fix wanted, with the grant it needs (on the agent thread, between steps). */
    private fun wantHelpFix(store: AgentStore, requestId: String, now: Long) {
        val state = store.locationState() ?: LocationState()
        val want = FixWant(WireFixReason.HELP, now, requestId = requestId)
        store.saveLocationState(
            state.copy(wants = state.wants.filter { it.key != want.key } + want, help = HelpShare(requestId, now)),
            now,
        )
        sharing = true
    }

    /** Phase 7: "Talk to my parent", with the kid's words. [done] gets whether it was sent. */
    fun talk(context: Context, reason: String, done: ((Boolean) -> Unit)? = null) {
        kidRequest(context, "talking to a parent", done) { _, now ->
            Requests.talk(reason, now) { UUID.randomUUID().toString() }
        }
    }

    /** Phase 7: the kid changes the words of the open request [id]. */
    fun editRequest(context: Context, id: String, reason: String, done: ((Boolean) -> Unit)? = null) {
        kidRequest(context, "changing request $id", done) { store, _ ->
            Requests.edit(Requests.answered(store.requests(), DebugTools.policyOverride ?: store.policy()), id, reason)
        }
    }

    /** Phase 7: the kid takes back the open request [id] (sent again with withdrawn_at). */
    fun withdraw(context: Context, id: String, done: ((Boolean) -> Unit)? = null) {
        kidRequest(context, "taking back request $id", done) { store, now ->
            Requests.withdraw(Requests.answered(store.requests(), DebugTools.policyOverride ?: store.policy()), id, now)
        }
    }

    /** One request the kid made or changed, on the agent thread: stored, queued and sent right away. */
    private fun kidRequest(context: Context, what: String, done: ((Boolean) -> Unit)?, make: (AgentStore, Long) -> KidRequest?) {
        val app = context.applicationContext
        executor.execute {
            val sent = try {
                val store = AgentStore.get(app)
                val now = System.currentTimeMillis()
                val request = make(store, now)
                if (request == null) {
                    Log.w(TAG, "$what: nothing to send")
                    false
                } else {
                    store.commitEnforcement(null, listOf(request), now)
                    Log.i(TAG, "$what (request ${request.id}, send ${request.revision})")
                    showRequests(store)
                    Sync.request(app)
                    true
                }
            } catch (t: Throwable) {
                Log.e(TAG, "$what failed", t)
                false
            }
            done?.invoke(sent)
        }
    }

    /**
     * Phase 5: "Ask to add a contact", with the [name] and [number] (E.164, as AndroidCalls.key made
     * it) the kid gave and why. [done] gets whether it was sent (false: no name, or not a whole number).
     */
    fun askContact(context: Context, name: String, number: String?, reason: String?, done: ((Boolean) -> Unit)? = null) {
        kidRequest(context, "asking to add a contact", done) { _, now ->
            Requests.contact(name, number, reason, now) { UUID.randomUUID().toString() }
        }
    }

    /**
     * Phase 5: a call that ended (calls/CallFlow.kt), on the agent thread: kept in Belay's own recent
     * calls unless it's with an emergency number, 988 or a private number (core's CallRecords, which
     * makes nothing for those), and with `calls.log` also queued for POST /api/v1/calls.
     */
    fun recordCall(context: Context, call: EndedCall) {
        val app = context.applicationContext
        executor.execute {
            try {
                val store = AgentStore.get(app)
                val policy = DebugTools.policyOverride ?: store.policy()
                val calls = policy?.calls ?: return@execute
                val android = AndroidCalls.emergencyNumbers(app)
                val private = CallContacts.private(policy)
                val entry = CallRecords.entry(
                    UUID.randomUUID().toString(), call.at, call.direction, call.number, call.contact,
                    call.durationS, call.outcome, call.reason, private, android, callback = call.callback,
                )
                val record = entry?.takeIf { calls.log }?.let { CallRecords.toWire(it, private, android) }
                val now = System.currentTimeMillis()
                store.commitCall(entry, record, now)
                Log.i(TAG, "call ${call.direction.name.lowercase()}, ${call.outcome.name.lowercase()}: " + when {
                    entry == null -> "not kept (an always-allowed or private number)"
                    record != null -> "kept, and queued for the server"
                    else -> "kept on the phone"
                })
                _view.value?.let { view -> view.calls?.let { _view.value = view.copy(calls = it.copy(recents = store.calls(SCREEN_CALLS))) } }
                if (record != null) Sync.request(app)
            } catch (t: Throwable) {
                Log.e(TAG, "recording a call failed", t)
            }
        }
    }

    /**
     * Phase 5: the kid called 911, an emergency number or 988, or texted 988 through Belay, at [at]:
     * for 2 hours every caller rings. Stored on the phone only (core's CallsState), never sent, and
     * forgotten once the window is over.
     */
    fun emergencyContact(context: Context, at: Long) {
        val app = context.applicationContext
        executor.execute {
            try {
                val store = AgentStore.get(app)
                val state = store.callsState() ?: CallsState()
                val last = CallsPlan.emergencyContact(state.lastEmergencyContactAt, at, System.currentTimeMillis())
                if (last != state.lastEmergencyContactAt) {
                    store.saveCallsState(state.copy(lastEmergencyContactAt = last), System.currentTimeMillis())
                    CallsGate.publish(DebugTools.policyOverride ?: store.policy(), store.callsState())
                    Log.i(TAG, "calls: every caller rings for the next 2 hours")
                }
            } catch (t: Throwable) {
                Log.e(TAG, "storing the callback window failed", t)
            }
        }
        // The block list lifts for the window at the next step.
        handle(app, Trigger.CALL)
    }

    /**
     * Phase 3: Android has batch [token] of network logs ready (AdminReceiver.onNetworkLogsAvailable).
     * On the agent thread, at once (Android discards a batch 5 minutes after it's taken): Belay takes
     * it and any it missed, keeps only counts per app, per domain, per day, and queues the days that
     * changed; then a step, which sends them and reports whether Android paused logging.
     */
    fun networkLogs(context: Context, token: Long, done: (() -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            try {
                NetworkLogStep(app, AgentStore.get(app)).take(token, System.currentTimeMillis())
            } catch (t: Throwable) {
                Log.e(TAG, "taking network logs failed", t)
            }
            try {
                step(app, Trigger.NETWORK_LOGS, emptySet())
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

    private fun publish(app: Context, store: AgentStore, health: Health, device: WireDevice, inventory: Map<String, PackageRecord>, kid: KidView) {
        _view.value = AgentView(
            health = health,
            device = device,
            inventory = inventory,
            changes = store.recentChanges(SCREEN_CHANGES),
            heartbeats = store.recentHeartbeats(SCREEN_HEARTBEATS),
            kid = kid,
            update = store.agentUpdate(),
            recovery = store.recovery(),
            told = Told.list(store.told(), System.currentTimeMillis()),
            calls = kid.policy?.calls?.let { calls ->
                CallsView(calls, CallContacts.of(kid.policy), store.calls(SCREEN_CALLS), Dialer.isDialer(app))
            },
        )
    }

    private const val SCREEN_CHANGES = 30
    private const val SCREEN_HEARTBEATS = 24

    /** Recent calls the dialer shows. */
    private const val SCREEN_CALLS = 200
}
