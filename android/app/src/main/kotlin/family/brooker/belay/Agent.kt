package family.brooker.belay

import android.content.Context
import android.util.Log
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.WireDevice
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.Health
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.Reconciler
import family.brooker.belay.service.BelayService
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.StateDump
import family.brooker.belay.work.WatchdogWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executors

/** What woke the agent. Every trigger runs the same idempotent steps. */
enum class Trigger(val label: String, val heartbeat: Boolean) {
    ADMIN_ENABLED("device admin enabled", true),
    OWNER_CHANGED("device owner changed", true),
    PROVISIONED("provisioning finished", true),
    BOOT("phone started", true),
    AGENT_UPDATED("Belay updated", true),
    SERVICE_STARTED("service started", true),
    ADMIN_SERVICE_BOUND("admin service bound", true),
    WATCHDOG("periodic check", true),
    PACKAGE_BROADCAST("package broadcast", false),
    APP_OPENED("Belay opened", false),
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
)

object Agent {
    const val TAG = "Belay"

    // One thread for all agent work, so the baseline and the log have a single writer.
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-agent") }
    private val _view = MutableStateFlow<AgentView?>(null)
    val view: StateFlow<AgentView?> = _view.asStateFlow()

    /**
     * Runs the agent's steps on its own thread:
     * 1. If Belay is device owner, apply its setup again (idempotent) and make sure the
     *    service and the periodic check are running.
     * 2. Reconcile the inventory: getChangedPackages since the last check, or a full scan
     *    after a boot and once a day. What it finds goes into the outbox in the same
     *    transaction.
     * 3. Publish the result for the main screen.
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
                if (trigger != Trigger.PACKAGE_BROADCAST && DeviceOwnerSetup.isDeviceOwner(app)) {
                    DeviceOwnerSetup.ensure(app)
                    BelayService.start(app)
                    WatchdogWorker.schedule(app)
                }
                val health = HealthReader(app).read()
                var device: WireDevice? = null
                val readDevice = { DeviceStatus.read(app, health).also { device = it } }
                val outcome = Reconciler(app, store).run(trigger, packages, null, readDevice)
                _view.value = AgentView(
                    health = health,
                    device = device ?: readDevice(),
                    inventory = outcome.baseline.inventory,
                    changes = store.recentChanges(SCREEN_CHANGES),
                    heartbeats = store.recentHeartbeats(SCREEN_HEARTBEATS),
                )
                DebugTools.afterStep(app) { StateDump.json(store) }
            } catch (t: Throwable) {
                Log.e(TAG, "agent step failed (${trigger.label})", t)
            } finally {
                Log.i(TAG, "step done: ${trigger.label} in ${(System.nanoTime() - started) / 1_000_000} ms")
                done?.invoke()
            }
        }
    }

    private const val SCREEN_CHANGES = 30
    private const val SCREEN_HEARTBEATS = 24
}
