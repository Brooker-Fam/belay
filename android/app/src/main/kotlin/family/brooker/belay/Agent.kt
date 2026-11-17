package family.brooker.belay

import android.content.Context
import android.util.Log
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.Requests
import family.brooker.belay.core.WireDevice
import family.brooker.belay.enforce.EnforcementStep
import family.brooker.belay.enforce.KidView
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.Health
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.Reconciler
import family.brooker.belay.service.BelayService
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.StateDump
import family.brooker.belay.sync.PolicyPoll
import family.brooker.belay.sync.Sync
import family.brooker.belay.sync.SyncWork
import family.brooker.belay.work.WatchdogWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID
import java.util.concurrent.Executors

/**
 * What woke the agent. Every trigger runs the same idempotent steps. [checkin]: the sync
 * that follows checks in with the server even if a check-in isn't due yet.
 */
enum class Trigger(val label: String, val heartbeat: Boolean, val checkin: Boolean = false) {
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
    PACKAGE_BROADCAST("package broadcast", false),
    APP_OPENED("Belay opened", false),

    /** Phase 2: a new policy arrived (long-poll or check-in). */
    POLICY("new policy", false),

    /** Phase 2: a pause or repair time ended. */
    POLICY_TIMER("pause or repair time ended", false),

    /** Phase 2: the Private DNS thread finished, or its retry is due. */
    PRIVATE_DNS("Private DNS updated", false),
    PRIVATE_DNS_RETRY("Private DNS retry", false),
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
            val started = System.nanoTime()
            Log.i(TAG, "step: ${trigger.label}" + if (packages.isEmpty()) "" else " $packages")
            try {
                val store = AgentStore.get(app)
                val connection = ConnectionStore.read(app)
                if (trigger != Trigger.PACKAGE_BROADCAST) {
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
                    changed = outcome.changes.mapTo(HashSet()) { it.packageName } + packages,
                    fullScan = outcome.snapshotQueued,
                    recheckDns = trigger == Trigger.PRIVATE_DNS_RETRY,
                )
                publish(store, health, device ?: readDevice(), outcome.baseline.inventory, enforcement.view)
                DebugTools.afterStep(app) { StateDump.json(store, connection) }
                Sync.request(app, checkin = trigger.checkin)
                // The parent page shows the policy as applied once the server hears so.
                if (enforcement.reportChanged) Sync.checkinSoon(app)
                // A new connection: the long-poll asks the new server at once.
                if (trigger == Trigger.ENROLLED) PolicyPoll.kick()
            } catch (t: Throwable) {
                Log.e(TAG, "agent step failed (${trigger.label})", t)
            } finally {
                Log.i(TAG, "step done: ${trigger.label} in ${(System.nanoTime() - started) / 1_000_000} ms")
                done?.invoke()
            }
        }
    }

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
                    ?: store.requests().firstOrNull { it.packageName == packageName }?.label
                    ?: packageName
                val answered = Requests.answered(store.requests(), DebugTools.policyOverride ?: store.policy())
                val request = Requests.send(answered, packageName, label, reason, now) { UUID.randomUUID().toString() }
                store.commitEnforcement(null, listOf(request), now)
                Log.i(TAG, "asked for $packageName (request ${request.id}, send ${request.revision})")
                _view.value?.let { view ->
                    val all = store.requests()
                    _view.value = view.copy(kid = view.kid.copy(requests = Requests.answered(all, view.kid.policy)))
                }
                Sync.request(app)
            } catch (t: Throwable) {
                Log.e(TAG, "asking for $packageName failed", t)
            } finally {
                done?.invoke()
            }
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
        )
    }

    private const val SCREEN_CHANGES = 30
    private const val SCREEN_HEARTBEATS = 24
}
