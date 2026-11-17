package family.brooker.belay.store

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.AgentState
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Applied
import family.brooker.belay.core.Baseline
import family.brooker.belay.core.ChangeCursor
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.InventoryRequest
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.PolicyRules
import family.brooker.belay.core.Reconcile
import family.brooker.belay.core.Requests
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireEvent
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import java.io.File

/**
 * The agent's storage, on top of Room. The agent thread is the only writer of the baseline,
 * the change log, the heartbeats, what Belay applied and the kid's requests, and the only
 * one that adds to the outbox; the sync thread marks outbox items sent, failed or dropped;
 * the long-poll and the sync thread store the policy; the Private DNS thread writes its own
 * row. SQLite transactions keep all of them safe.
 */
class AgentStore internal constructor(private val db: BelayDatabase, private val noBackupDir: File) {
    private val inventory = db.inventory()
    private val log = db.log()
    private val outbox = db.outbox()
    private val enforcement = db.enforcement()

    /** What one agent step found, written in one transaction. */
    data class Step(
        val previous: Baseline,
        val next: Baseline,
        val changes: List<AppChange>,
        /** The changes as events for the server, in the same order. */
        val events: List<WireEvent>,
        /** Queued after every full scan. */
        val snapshot: InventoryRequest?,
        val heartbeat: Heartbeat?,
        val at: Long,
    )

    fun loadBaseline(): Baseline {
        val state = inventory.scanState()
        val packages = inventory.packages().mapNotNull { row ->
            try {
                json.decodeFromString(PackageRecord.serializer(), row.record)
            } catch (e: IllegalArgumentException) {
                // Unreadable: leaving it out makes the next scan see the package as new.
                Log.e(Agent.TAG, "stored record unreadable: ${row.packageName}", e)
                null
            }
        }.associateBy { it.packageName }
        val cursor = if (state?.cursorBootCount != null && state.cursorSequence != null) {
            ChangeCursor(state.cursorBootCount, state.cursorSequence)
        } else {
            null
        }
        return Baseline(packages, state?.lastFullScanAt, cursor)
    }

    /**
     * Updates the baseline and queues what the step found, together: if the phone dies
     * halfway, neither happened, and the next scan finds the same changes again.
     */
    fun commit(step: Step) {
        db.runInTransaction {
            val before = step.previous.inventory
            val after = step.next.inventory
            val changed = after.values.filter { before[it.packageName] != it }
            if (changed.isNotEmpty()) {
                inventory.upsertPackages(changed.map { PackageRow(it.packageName, json.encodeToString(PackageRecord.serializer(), it)) })
            }
            (before.keys - after.keys).toList().chunked(CHUNK).forEach { inventory.deletePackages(it) }
            inventory.setScanState(
                ScanStateRow(
                    lastFullScanAt = step.next.lastFullScanAt,
                    lastScanAt = step.at,
                    cursorBootCount = step.next.cursor?.bootCount,
                    cursorSequence = step.next.cursor?.sequence,
                ),
            )
            if (step.changes.isNotEmpty()) {
                log.insertChanges(
                    step.changes.map { ChangeRow(changeId = it.id, packageName = it.packageName, change = json.encodeToString(AppChange.serializer(), it)) },
                )
                log.pruneChanges(Reconcile.MAX_CHANGES)
            }
            val queued = step.events.map { event ->
                OutboxRow(
                    type = OutboxRow.TYPE_EVENT,
                    itemId = event.id,
                    packageName = event.packageName,
                    payload = Wire.json.encodeToString(WireEvent.serializer(), event),
                    createdAt = step.at,
                )
            } + listOfNotNull(
                step.snapshot?.let { snapshot ->
                    OutboxRow(
                        type = OutboxRow.TYPE_SNAPSHOT,
                        itemId = snapshot.snapshotId,
                        packageName = null,
                        payload = Wire.json.encodeToString(InventoryRequest.serializer(), snapshot),
                        createdAt = step.at,
                    )
                },
            )
            if (queued.isNotEmpty()) {
                outbox.insert(queued)
                capOutbox()
            }
            step.heartbeat?.let {
                log.insertHeartbeats(listOf(HeartbeatRow(at = it.at, trigger = it.trigger, note = it.note)))
                log.pruneHeartbeats(Reconcile.MAX_HEARTBEATS)
            }
        }
    }

    /** Newest first. */
    fun recentChanges(limit: Int): List<AppChange> = log.recentChanges(limit).mapNotNull { row ->
        try {
            json.decodeFromString(AppChange.serializer(), row.change)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** Newest first. */
    fun recentHeartbeats(limit: Int): List<Heartbeat> =
        log.recentHeartbeats(limit).map { Heartbeat(it.at, it.trigger, it.note) }

    // The outbox, for the sync thread.

    /** Everything waiting, oldest first, without payloads. */
    fun queue(): List<QueuedRow> = outbox.queue(OutboxPolicy.MAX_PENDING_EVENTS + 10)

    /** The events' JSON, in [ids] order. */
    fun eventPayloads(ids: List<Long>): List<String> = payloads(ids, OutboxRow.TYPE_EVENT)

    /** The requests' JSON (WireRequests), in [ids] order. */
    fun requestPayloads(ids: List<Long>): List<String> = payloads(ids, OutboxRow.TYPE_REQUEST)

    private fun payloads(ids: List<Long>, type: String): List<String> =
        ids.chunked(CHUNK).flatMap { outbox.payloads(it, type) }.sortedBy { it.id }.map { it.payload }

    /** A payload read in parts, so a large snapshot never has to fit in one CursorWindow. */
    fun payload(id: Long): String? {
        val length = outbox.payloadLength(id) ?: return null
        val text = StringBuilder(length)
        var start = 1 // substr() counts from 1
        while (start <= length) {
            text.append(outbox.payloadPart(id, start, PART) ?: return null)
            start += PART
        }
        return text.toString()
    }

    fun markSent(ids: List<Long>, at: Long) {
        db.runInTransaction {
            ids.chunked(CHUNK).forEach {
                outbox.markItemsSent(it, at)
                outbox.deleteSnapshots(it)
            }
        }
    }

    fun markDropped(id: Long, reason: String, at: Long) = outbox.markDropped(id, reason.take(MAX_ERROR), at)

    /** How many failed attempts [ids] have had so far. */
    fun attempts(ids: List<Long>): Int = ids.chunked(CHUNK).maxOfOrNull { outbox.maxAttempts(it) ?: 0 } ?: 0

    /** Counts one more failed attempt for [ids]; they, and everything after them, wait until [nextAttemptAt]. */
    fun markFailed(ids: List<Long>, error: String, nextAttemptAt: Long) {
        db.runInTransaction {
            ids.chunked(CHUNK).forEach { outbox.markFailed(it, error.take(MAX_ERROR), nextAttemptAt) }
        }
    }

    fun makePendingDue() = outbox.makePendingDue()

    fun pendingCount(): Int = outbox.pendingCount()

    val pendingCountFlow: Flow<Int> get() = outbox.pendingCountFlow()

    fun countsByState(): Map<String, Int> = outbox.countsByState().associate { it.state to it.count }

    fun eventsFor(packageName: String): List<OutboxRow> = outbox.eventsFor(packageName)

    fun requestsQueuedFor(packageName: String): List<OutboxRow> = outbox.requestsFor(packageName)

    /** The ids of the kid's requests with a send still waiting in the outbox. */
    val unsentRequestsFlow: Flow<Set<String>>
        get() = outbox.pendingRequestItemIds().map { ids ->
            ids.mapNotNullTo(HashSet()) { it.removePrefix("request:").substringBeforeLast(':', "").takeIf(String::isNotEmpty) }
        }

    // Phase 2: the policy, what Belay applied, the kid's requests, Private DNS.

    /** The last policy the phone got, or null before the first (or if it can't be read). */
    fun policy(): WirePolicy? = enforcement.policy()?.let { decode(it.policy, WirePolicy.serializer()) }

    /** The stored policy's version, or null before the first. */
    fun policyVersion(): Int? = enforcement.policyVersion()

    /**
     * Keeps [incoming], the answer to a request sent at [sentAt] and received [at], if it
     * replaces the stored policy (core's PolicyRules), in one transaction, so the long-poll
     * and a check-in can't race. True when it was kept.
     */
    fun savePolicy(incoming: WirePolicy, sentAt: Long, at: Long): Boolean = db.runInTransaction<Boolean> {
        val row = enforcement.policy()
        val stored = row?.let { decode(it.policy, WirePolicy.serializer()) }
        if (!PolicyRules.replaces(stored, row?.receivedAt, incoming, sentAt)) return@runInTransaction false
        enforcement.setPolicy(PolicyRow(version = incoming.version, policy = Wire.json.encodeToString(WirePolicy.serializer(), incoming), receivedAt = at))
        true
    }

    /** What Belay applied; empty before the first policy. */
    fun applied(): Applied = enforcement.enforcement()?.let { decode(it.applied, Applied.serializer()) } ?: Applied()

    /** The kid's requests, newest first. */
    fun requests(): List<KidRequest> = enforcement.requests().mapNotNull { decode(it.request, KidRequest.serializer()) }

    /**
     * What one enforcement step did, in one transaction: what Belay now holds, and the
     * requests it made or the kid sent, each queued for the server behind everything older.
     */
    fun commitEnforcement(applied: Applied?, requests: List<KidRequest>, at: Long) {
        db.runInTransaction {
            if (applied != null) {
                enforcement.setEnforcement(EnforcementRow(applied = json.encodeToString(Applied.serializer(), applied), updatedAt = at))
            }
            if (requests.isNotEmpty()) {
                enforcement.upsertRequests(
                    requests.map { RequestRow(it.id, it.packageName, json.encodeToString(KidRequest.serializer(), it), it.askedAt) },
                )
                requests.forEach { outbox.deletePendingRequestSends("request:${it.id}:") }
                outbox.insert(
                    requests.map {
                        OutboxRow(
                            type = OutboxRow.TYPE_REQUEST,
                            itemId = Requests.itemId(it),
                            packageName = it.packageName,
                            payload = Wire.json.encodeToString(WireRequest.serializer(), Requests.toWire(it)),
                            createdAt = at,
                        )
                    },
                )
            }
            enforcement.pruneRequests(at - Requests.KEEP_MS)
        }
    }

    /** What the Private DNS thread last did; null before it ever ran. */
    fun privateDns(): PrivateDnsRow? = enforcement.privateDns()

    /** For the Private DNS thread only. */
    fun savePrivateDns(row: PrivateDnsRow) = enforcement.setPrivateDns(row)

    private fun <T> decode(text: String, serializer: KSerializer<T>): T? = try {
        json.decodeFromString(serializer, text)
    } catch (e: IllegalArgumentException) {
        // Unreadable (a bug, or a downgrade): treated as absent, and the next step rewrites it.
        Log.e(Agent.TAG, "stored ${serializer.descriptor.serialName} unreadable", e)
        null
    }

    /** Forgets sent and dropped items after a while. */
    fun pruneFinished(now: Long) = outbox.pruneFinished(now - OutboxPolicy.KEEP_FINISHED_MS, OutboxPolicy.MAX_FINISHED)

    /** Keeps the newest unsent snapshot only, and at most MAX_PENDING_EVENTS events. In a transaction. */
    private fun capOutbox() {
        outbox.deleteOlderPendingSnapshots()
        val over = outbox.pendingEventCount() - OutboxPolicy.MAX_PENDING_EVENTS
        if (over > 0) {
            Log.w(Agent.TAG, "outbox full: dropping the $over oldest unsent events (the next inventory still shows the result)")
            outbox.deleteOldestPendingEvents(over)
        }
    }

    /**
     * The Phase 0 agent kept its state in no_backup/agent-state.json. Its inventory, cursor,
     * change log and heartbeats come into Room once, then the file goes. Its changes only go
     * to the local log, not the outbox: Phase 0 told the kid nothing was sent anywhere.
     */
    fun importPhase0() {
        val file = AtomicFile(File(noBackupDir, PHASE0_FILE))
        if (!file.baseFile.exists()) return
        val state = try {
            json.decodeFromString(AgentState.serializer(), file.readFully().decodeToString())
        } catch (e: Exception) {
            Log.e(Agent.TAG, "Phase 0 state unreadable; not imported", e)
            null
        }
        if (state != null && inventory.scanState() == null && inventory.packages().isEmpty()) {
            db.runInTransaction {
                inventory.upsertPackages(
                    state.inventory.values.map { PackageRow(it.packageName, json.encodeToString(PackageRecord.serializer(), it)) },
                )
                inventory.setScanState(
                    ScanStateRow(
                        lastFullScanAt = state.lastFullScanAt,
                        lastScanAt = state.lastFullScanAt,
                        cursorBootCount = state.cursor?.bootCount,
                        cursorSequence = state.cursor?.sequence,
                    ),
                )
                log.insertChanges(
                    state.changes.takeLast(Reconcile.MAX_CHANGES).map {
                        ChangeRow(changeId = it.id, packageName = it.packageName, change = json.encodeToString(AppChange.serializer(), it))
                    },
                )
                log.insertHeartbeats(
                    state.heartbeats.takeLast(Reconcile.MAX_HEARTBEATS).map { HeartbeatRow(at = it.at, trigger = it.trigger, note = it.note) },
                )
            }
            Log.i(Agent.TAG, "imported the Phase 0 state: ${state.inventory.size} packages, ${state.changes.size} changes")
        }
        file.delete()
    }

    companion object {
        const val PHASE0_FILE = "agent-state.json"

        /** Well under SQLite's limit on bound parameters. */
        private const val CHUNK = 500

        /** Characters per read of a large payload. */
        private const val PART = 256 * 1024
        private const val MAX_ERROR = 500

        /** For what only the agent reads back: unknown keys are tolerated, defaults written out. */
        private val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

        @Volatile
        private var instance: AgentStore? = null

        fun get(context: Context): AgentStore = instance ?: synchronized(this) {
            instance ?: AgentStore(BelayDatabase.get(context), context.applicationContext.noBackupFilesDir)
                .also { instance = it }
        }
    }
}
