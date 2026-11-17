package family.brooker.belay.core

import kotlinx.serialization.Serializable

/**
 * Where getChangedPackages left off. Its sequence number starts again from 0 at every
 * boot, so it is only meaningful together with Settings.Global.BOOT_COUNT.
 */
@Serializable
data class ChangeCursor(val bootCount: Int, val sequence: Int)

sealed interface ScanPlan {
    /** Read every package and diff against the last known inventory. */
    data class Full(val reason: String) : ScanPlan

    /** Ask getChangedPackages what changed since [since] (same boot), and read only those. */
    data class Incremental(val since: Int) : ScanPlan
}

/** A note that the agent ran, kept to see how often it gets to run (Doze, restarts). */
@Serializable
data class Heartbeat(val at: Long, val trigger: String, val note: String? = null)

/**
 * What every scan is compared with: the last known inventory, and where getChangedPackages
 * left off. The agent keeps it in Room, and updates it in the same transaction that puts
 * the changes it found in the outbox.
 */
data class Baseline(
    val inventory: Map<String, PackageRecord> = emptyMap(),
    /** When the last full scan finished; null before the first one. */
    val lastFullScanAt: Long? = null,
    val cursor: ChangeCursor? = null,
)

/**
 * The Phase 0 agent's state file (no_backup/agent-state.json). Phase 1 imports it into
 * Room once, then deletes it.
 */
@Serializable
data class AgentState(
    val inventory: Map<String, PackageRecord> = emptyMap(),
    val lastFullScanAt: Long? = null,
    val cursor: ChangeCursor? = null,
    /** Newest last. */
    val changes: List<AppChange> = emptyList(),
    /** Newest last. */
    val heartbeats: List<Heartbeat> = emptyList(),
) {
    val baseline: Baseline get() = Baseline(inventory, lastFullScanAt, cursor)
}

object Reconcile {
    /** How many changes and heartbeats the phone keeps for its own screen. */
    const val MAX_CHANGES = 300
    const val MAX_HEARTBEATS = 200
    const val FULL_SCAN_INTERVAL_MS = 24L * 60 * 60 * 1000

    /**
     * [fullScanWanted] is a reason to read everything now whatever the cursor says, such as
     * a new enrollment (the server wants a full inventory right away).
     */
    fun plan(baseline: Baseline, bootCount: Int?, now: Long, fullScanWanted: String? = null): ScanPlan {
        val cursor = baseline.cursor
        val last = baseline.lastFullScanAt
        return when {
            last == null -> ScanPlan.Full("first scan")
            fullScanWanted != null -> ScanPlan.Full(fullScanWanted)
            bootCount == null -> ScanPlan.Full("boot count unavailable")
            cursor == null -> ScanPlan.Full("no change cursor")
            cursor.bootCount != bootCount -> ScanPlan.Full("phone restarted")
            now - last >= FULL_SCAN_INTERVAL_MS || now < last -> ScanPlan.Full("daily scan")
            else -> ScanPlan.Incremental(cursor.sequence)
        }
    }

    data class Result(val baseline: Baseline, val changes: List<AppChange>)

    /**
     * A full scan. The very first one is a baseline: it records the inventory without
     * reporting every preinstalled app as "installed".
     */
    fun fullScan(
        baseline: Baseline,
        current: Map<String, PackageRecord>,
        cursor: ChangeCursor?,
        now: Long,
        newId: () -> String,
    ): Result {
        val first = baseline.lastFullScanAt == null && baseline.inventory.isEmpty()
        val changes = if (first) {
            emptyList()
        } else {
            InventoryDiff.diff(baseline.inventory, current, null, now, { Detection.SNAPSHOT }, newId)
        }
        return Result(Baseline(inventory = current, lastFullScanAt = now, cursor = cursor), changes)
    }

    /**
     * A scan of only the packages in [scope]; each says which layer pointed at it.
     * [current] holds the packages of the scope that are still installed.
     */
    fun scopedScan(
        baseline: Baseline,
        scope: Map<String, Detection>,
        current: Map<String, PackageRecord>,
        cursor: ChangeCursor?,
        now: Long,
        newId: () -> String,
    ): Result {
        val names = scope.keys
        val changes = InventoryDiff.diff(
            baseline.inventory, current, names, now, { scope[it] ?: Detection.CHANGED_PACKAGES }, newId,
        )
        val next = baseline.copy(
            inventory = InventoryDiff.merge(baseline.inventory, current, names),
            cursor = cursor ?: baseline.cursor,
        )
        return Result(next, changes)
    }
}
