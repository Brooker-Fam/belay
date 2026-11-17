package family.brooker.belay.inventory

import android.content.Context
import android.provider.Settings
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Baseline
import family.brooker.belay.core.ChangeCursor
import family.brooker.belay.core.Detection
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.InventoryRequest
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.Reconcile
import family.brooker.belay.core.ScanPlan
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.toWire
import family.brooker.belay.store.AgentStore
import java.util.UUID

/**
 * Change detection, layered, with the full scan as the backstop:
 * 1. Package broadcasts name the package (the service's runtime receiver, and the
 *    manifest receiver for PACKAGE_FULLY_REMOVED).
 * 2. On every wake, getChangedPackages(sequence) lists what changed since the last check.
 *    The sequence restarts at 0 on every boot, so it is stored with BOOT_COUNT.
 * 3. After a boot (boot count changed), once a day, and after enrolling, a full scan diffs
 *    everything, and queues an inventory snapshot for the server.
 *
 * Changes only come from differences between the stored inventory and what is installed,
 * so the layers can overlap without duplicates. Each change goes into the outbox in the
 * same transaction that updates the baseline. Runs on the agent thread only.
 */
class Reconciler(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext
    private val pm = app.packageManager
    private val reader = PackageReader(app)

    data class Outcome(
        val baseline: Baseline,
        val changes: List<AppChange>,
        val snapshotQueued: Boolean,
        val note: String,
    ) {
        /** Something new for the server. */
        val queued: Boolean get() = changes.isNotEmpty() || snapshotQueued
    }

    /**
     * [fullScanWanted]: a reason to scan everything now (a new enrollment). [device] gives the
     * phone's facts for a snapshot; it is only called after a full scan.
     */
    fun run(trigger: Trigger, broadcastPackages: Set<String>, fullScanWanted: String?, device: () -> WireDevice): Outcome {
        store.importPhase0()
        val now = System.currentTimeMillis()
        val bootCount = bootCount()
        val previous = store.loadBaseline()
        val result: Reconcile.Result
        val current: Map<String, PackageRecord>
        var snapshot: InventoryRequest? = null
        val note: String
        when (val plan = Reconcile.plan(previous, bootCount, now, fullScanWanted)) {
            is ScanPlan.Full -> {
                // Read the sequence first: anything that changes during the scan shows up again next time.
                val sequence = pm.getChangedPackages(0)?.sequenceNumber ?: 0
                current = reader.readAll()
                result = Reconcile.fullScan(previous, current, bootCount?.let { ChangeCursor(it, sequence) }, now, ::newId)
                snapshot = InventoryRequest(
                    snapshotId = newId(),
                    takenAt = now,
                    bootCount = bootCount,
                    device = device(),
                    packages = current.values.sortedBy { it.packageName }.take(WireLimits.MAX_PACKAGES).map { it.toWire() },
                )
                if (current.size > WireLimits.MAX_PACKAGES) {
                    Log.w(Agent.TAG, "${current.size} packages: the snapshot holds the first ${WireLimits.MAX_PACKAGES}")
                }
                note = "full scan (${plan.reason}): ${current.size} packages, ${result.changes.size} changes"
            }
            is ScanPlan.Incremental -> {
                val changed = pm.getChangedPackages(plan.since)
                val scope = LinkedHashMap<String, Detection>()
                changed?.packageNames?.forEach { scope[it] = Detection.CHANGED_PACKAGES }
                broadcastPackages.forEach { scope[it] = Detection.BROADCAST }
                val cursor = bootCount?.let { ChangeCursor(it, changed?.sequenceNumber ?: plan.since) }
                current = if (scope.isEmpty()) emptyMap() else reader.read(scope.keys)
                result = Reconcile.scopedScan(previous, scope, current, cursor, now, ::newId)
                note = if (scope.isEmpty()) "nothing changed" else "${scope.size} packages to check, ${result.changes.size} changes"
            }
        }
        result.changes.forEach { Log.i(Agent.TAG, "change: ${it.kind} ${it.packageName} by ${it.detection}") }
        store.commit(
            AgentStore.Step(
                previous = previous,
                next = result.baseline,
                changes = result.changes,
                events = result.changes.map { it.toWire(current[it.packageName]) },
                snapshot = snapshot,
                heartbeat = if (trigger.heartbeat) Heartbeat(now, trigger.label, note) else null,
                at = now,
            ),
        )
        return Outcome(result.baseline, result.changes, snapshot != null, note)
    }

    private fun bootCount(): Int? =
        Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 }

    private fun newId(): String = UUID.randomUUID().toString()
}
