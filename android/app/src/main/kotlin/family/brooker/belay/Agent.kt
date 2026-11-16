package family.brooker.belay

import android.content.Context
import android.util.Log
import family.brooker.belay.core.AgentState
import family.brooker.belay.health.Health
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.Reconciler
import family.brooker.belay.service.BelayService
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

/** Everything the main screen shows. */
data class AgentView(val state: AgentState, val health: Health)

object Agent {
    const val TAG = "Belay"

    // One thread for all agent work, so the stored state has a single writer.
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-agent") }
    private val _view = MutableStateFlow<AgentView?>(null)
    val view: StateFlow<AgentView?> = _view.asStateFlow()

    /**
     * Runs the agent's steps on its own thread:
     * 1. If Belay is device owner, apply its setup again (idempotent) and make sure the
     *    service and the periodic check are running.
     * 2. Reconcile the inventory: getChangedPackages since the last check, or a full scan
     *    after a boot and once a day.
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
            try {
                if (trigger != Trigger.PACKAGE_BROADCAST && DeviceOwnerSetup.isDeviceOwner(app)) {
                    DeviceOwnerSetup.ensure(app)
                    BelayService.start(app)
                    WatchdogWorker.schedule(app)
                }
                val state = Reconciler(app).run(trigger, packages)
                _view.value = AgentView(state, HealthReader(app).read())
            } catch (t: Throwable) {
                Log.e(TAG, "agent step failed (${trigger.label})", t)
            } finally {
                done?.invoke()
            }
        }
    }
}
