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

/** Everything the Phase 0 agent keeps on the phone. Phase 1 moves this to Room. */
@Serializable
data class AgentState(
    val inventory: Map<String, PackageRecord> = emptyMap(),
    /** When the last full scan finished; null before the first one. */
    val lastFullScanAt: Long? = null,
    val cursor: ChangeCursor? = null,
    /** Newest last. */
    val changes: List<AppChange> = emptyList(),
    /** Newest last. */
    val heartbeats: List<Heartbeat> = emptyList(),
)

object Reconcile {
    const val MAX_CHANGES = 300
    const val MAX_HEARTBEATS = 200
    const val FULL_SCAN_INTERVAL_MS = 24L * 60 * 60 * 1000

    fun plan(state: AgentState, bootCount: Int?, now: Long): ScanPlan {
        val cursor = state.cursor
        val last = state.lastFullScanAt
        return when {
            last == null -> ScanPlan.Full("first scan")
            bootCount == null -> ScanPlan.Full("boot count unavailable")
            cursor == null -> ScanPlan.Full("no change cursor")
            cursor.bootCount != bootCount -> ScanPlan.Full("phone restarted")
            now - last >= FULL_SCAN_INTERVAL_MS || now < last -> ScanPlan.Full("daily scan")
            else -> ScanPlan.Incremental(cursor.sequence)
        }
    }

    data class Result(val state: AgentState, val changes: List<AppChange>)

    /**
     * A full scan. The very first one is a baseline: it records the inventory without
     * reporting every preinstalled app as "installed".
     */
    fun fullScan(
        state: AgentState,
        current: Map<String, PackageRecord>,
        cursor: ChangeCursor?,
        now: Long,
        newId: () -> String,
    ): Result {
        val baseline = state.lastFullScanAt == null && state.inventory.isEmpty()
        val changes = if (baseline) {
            emptyList()
        } else {
            InventoryDiff.diff(state.inventory, current, null, now, { Detection.SNAPSHOT }, newId)
        }
        val next = state.copy(
            inventory = current,
            lastFullScanAt = now,
            cursor = cursor,
            changes = (state.changes + changes).takeLast(MAX_CHANGES),
        )
        return Result(next, changes)
    }

    /**
     * A scan of only the packages in [scope]; each says which layer pointed at it.
     * [current] holds the packages of the scope that are still installed.
     */
    fun scopedScan(
        state: AgentState,
        scope: Map<String, Detection>,
        current: Map<String, PackageRecord>,
        cursor: ChangeCursor?,
        now: Long,
        newId: () -> String,
    ): Result {
        val names = scope.keys
        val changes = InventoryDiff.diff(
            state.inventory, current, names, now, { scope[it] ?: Detection.CHANGED_PACKAGES }, newId,
        )
        val next = state.copy(
            inventory = InventoryDiff.merge(state.inventory, current, names),
            cursor = cursor ?: state.cursor,
            changes = (state.changes + changes).takeLast(MAX_CHANGES),
        )
        return Result(next, changes)
    }

    fun withHeartbeat(state: AgentState, heartbeat: Heartbeat): AgentState =
        state.copy(heartbeats = (state.heartbeats + heartbeat).takeLast(MAX_HEARTBEATS))
}
