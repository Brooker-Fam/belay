package family.brooker.belay.inventory

import android.content.Context
import android.provider.Settings
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import family.brooker.belay.core.AgentState
import family.brooker.belay.core.ChangeCursor
import family.brooker.belay.core.Detection
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.Reconcile
import family.brooker.belay.core.ScanPlan
import family.brooker.belay.store.StateStore
import java.util.UUID

/**
 * Change detection, layered, with the full scan as the backstop:
 * 1. Package broadcasts name the package (the service's runtime receiver, and the
 *    manifest receiver for PACKAGE_FULLY_REMOVED).
 * 2. On every wake, getChangedPackages(sequence) lists what changed since the last check.
 *    The sequence restarts at 0 on every boot, so it is stored with BOOT_COUNT.
 * 3. After a boot (boot count changed) and once a day, a full scan diffs everything.
 *
 * Changes only come from differences between the stored inventory and what is installed,
 * so the layers can overlap without duplicates. Runs on the agent thread only.
 */
class Reconciler(context: Context) {
    private val app = context.applicationContext
    private val pm = app.packageManager
    private val store = StateStore(app)
    private val reader = PackageReader(app)

    fun run(trigger: Trigger, broadcastPackages: Set<String>): AgentState {
        val now = System.currentTimeMillis()
        val bootCount = bootCount()
        val loaded = store.load()
        var state = loaded
        val note: String
        when (val plan = Reconcile.plan(state, bootCount, now)) {
            is ScanPlan.Full -> {
                // Read the sequence first: anything that changes during the scan shows up again next time.
                val sequence = pm.getChangedPackages(0)?.sequenceNumber ?: 0
                val current = reader.readAll()
                val result = Reconcile.fullScan(state, current, bootCount?.let { ChangeCursor(it, sequence) }, now, ::newId)
                state = result.state
                note = "full scan (${plan.reason}): ${current.size} packages, ${result.changes.size} changes"
                result.changes.forEach { Log.i(Agent.TAG, "change: ${it.kind} ${it.packageName} by ${it.detection}") }
            }
            is ScanPlan.Incremental -> {
                val changed = pm.getChangedPackages(plan.since)
                val scope = LinkedHashMap<String, Detection>()
                changed?.packageNames?.forEach { scope[it] = Detection.CHANGED_PACKAGES }
                broadcastPackages.forEach { scope[it] = Detection.BROADCAST }
                val cursor = bootCount?.let { ChangeCursor(it, changed?.sequenceNumber ?: plan.since) }
                if (scope.isEmpty()) {
                    state = state.copy(cursor = cursor ?: state.cursor)
                    note = "nothing changed"
                } else {
                    val result = Reconcile.scopedScan(state, scope, reader.read(scope.keys), cursor, now, ::newId)
                    state = result.state
                    note = "${scope.size} packages to check, ${result.changes.size} changes"
                    result.changes.forEach { Log.i(Agent.TAG, "change: ${it.kind} ${it.packageName} by ${it.detection}") }
                }
            }
        }
        if (trigger.heartbeat) state = Reconcile.withHeartbeat(state, Heartbeat(now, trigger.label, note))
        if (state != loaded) store.save(state)
        return state
    }

    private fun bootCount(): Int? =
        Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 }

    private fun newId(): String = UUID.randomUUID().toString()
}
