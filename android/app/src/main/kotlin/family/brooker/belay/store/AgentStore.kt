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
import family.brooker.belay.core.CommandLog
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.InventoryRequest
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.PolicyRules
import family.brooker.belay.core.Reconcile
import family.brooker.belay.core.RecoveryState
import family.brooker.belay.core.Requests
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireEvent
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequest
import family.brooker.belay.core.calls.CallEntry
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallsState
import family.brooker.belay.core.calls.WireCallRecord
import family.brooker.belay.core.kid.Told
import family.brooker.belay.core.location.LocationState
import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.WireFix
import family.brooker.belay.core.location.WirePlaceEvent
import family.brooker.belay.core.screentime.ScreenTimeState
import family.brooker.belay.core.screentime.UsageLedger
import family.brooker.belay.core.screentime.WireUsageDay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import java.io.File

/**
 * The agent's storage, on top of Room. The agent thread is the only writer of the baseline,
 * the change log, the heartbeats, what Belay applied, the kid's requests, the recovery key's
 * tries, the command log and screen time's ledger and state, and the only one that adds to the
 * outbox; the sync thread marks outbox items sent, failed or dropped; the long-poll and the sync
 * thread store the policy (and note an answer too big to read); the Private DNS and update
 * threads write their own rows. SQLite transactions keep all of them safe.
 */
class AgentStore internal constructor(private val db: BelayDatabase, private val noBackupDir: File) {
    /** Phase 3: screen time's ledger and state, each null when absent or unreadable (then made anew). */
    data class ScreenTimeStored(val ledger: UsageLedger?, val state: ScreenTimeState?)

    /** Phase 3: what an enforcement step does with screen time's row. */
    sealed interface ScreenTimeWrite {
        data class Save(val ledger: UsageLedger, val state: ScreenTimeState) : ScreenTimeWrite

        /** The policy has no screen time: the row goes, and so does every unsent usage day. */
        data object Clear : ScreenTimeWrite
    }

    /** Phase 4: what an enforcement step does with location's row and the fixes it took. */
    data class LocationWrite(
        /** Null: the row goes (location is off and nothing is being shared). */
        val state: LocationState?,
        /** Fixes for `POST /locations`, oldest first, then the place events that name them. */
        val fixes: List<WireFix> = emptyList(),
        val placeEvents: List<WirePlaceEvent> = emptyList(),
        /** Lines of "What Belay told your parent", new or updated by id. */
        val told: List<ToldEntry> = emptyList(),
        /** Location went off: unsent fixes and place events aren't sent. */
        val dropUnsent: Boolean = false,
    )

    /** Phase 5: what an enforcement step does with calls' row and Belay's own call records. */
    data class CallsWrite(
        /** Null: the row goes (calls is off, and nothing of Belay's is left to undo). */
        val state: CallsState?,
        /** `log` is off: unsent call records aren't sent. */
        val dropUnsent: Boolean = false,
        /** Calls went off: Belay's own recent calls go too. */
        val clearRecents: Boolean = false,
    )

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

    /** Phase 3: the usage days' JSON (WireUsageDays), in [ids] order. */
    fun usagePayloads(ids: List<Long>): List<String> = payloads(ids, OutboxRow.TYPE_USAGE)

    /** Phase 4: the fixes' and the place events' JSON (WireFixes, WirePlaceEvents), each in [ids] order. */
    fun locationPayloads(ids: List<Long>): Pair<List<String>, List<String>> {
        val rows = ids.chunked(CHUNK).flatMap { outbox.locationPayloads(it) }.sortedBy { it.id }
        return rows.filter { it.type == OutboxRow.TYPE_FIX }.map { it.payload } to
            rows.filter { it.type == OutboxRow.TYPE_PLACE_EVENT }.map { it.payload }
    }

    /** Phase 5: the call records' JSON (WireCallRecords), in [ids] order. */
    fun callPayloads(ids: List<Long>): List<String> =
        ids.chunked(CHUNK).flatMap { outbox.callPayloads(it) }.sortedBy { it.id }.map { it.payload }

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
                outbox.deleteSentLarge(it)
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

    /** Phase 3: usage days waiting to be sent. */
    fun pendingUsageCount(): Int = outbox.pendingUsageCount()

    /** Phase 4: fixes and place events waiting to be sent. */
    fun pendingLocationCount(): Int = outbox.pendingLocationCount()

    /** Phase 5: call records waiting to be sent. */
    fun pendingCallCount(): Int = outbox.pendingCallCount()

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
     * What one enforcement step did, in one transaction: what Belay now holds, the commands it
     * ran (Phase 10), the requests it made or the kid sent, each queued for the server behind
     * everything older, (Phase 3) screen time's ledger and state, with the [usage] days to
     * send (each replacing an unsent report of the same day), and (Phase 4) location's state, the
     * fixes and place events to send, and the lines of "What Belay told your parent". [dropUsage]:
     * the policy stopped measuring, so unsent usage days aren't sent.
     */
    fun commitEnforcement(
        applied: Applied?,
        requests: List<KidRequest>,
        at: Long,
        commands: CommandLog? = null,
        screenTime: ScreenTimeWrite? = null,
        usage: List<WireUsageDay> = emptyList(),
        dropUsage: Boolean = false,
        location: LocationWrite? = null,
        calls: CallsWrite? = null,
    ) {
        db.runInTransaction {
            if (location != null) writeLocation(location, at)
            if (calls != null) writeCalls(calls, at)
            if (applied != null) {
                enforcement.setEnforcement(EnforcementRow(applied = json.encodeToString(Applied.serializer(), applied), updatedAt = at))
            }
            if (commands != null) {
                enforcement.setCommands(CommandsRow(log = json.encodeToString(CommandLog.serializer(), commands), updatedAt = at))
            }
            when (screenTime) {
                null -> {}
                is ScreenTimeWrite.Save -> enforcement.setScreenTime(
                    ScreenTimeRow(
                        ledger = json.encodeToString(UsageLedger.serializer(), screenTime.ledger),
                        state = json.encodeToString(ScreenTimeState.serializer(), screenTime.state),
                        updatedAt = at,
                    ),
                )
                ScreenTimeWrite.Clear -> enforcement.clearScreenTime()
            }
            if (dropUsage || screenTime == ScreenTimeWrite.Clear) {
                val dropped = outbox.deleteAllPendingUsage()
                if (dropped > 0) Log.i(Agent.TAG, "screen time: $dropped unsent usage days dropped (the policy doesn't measure)")
            }
            if (usage.isNotEmpty()) {
                usage.forEach { outbox.deletePendingUsage(usagePrefix(it)) }
                outbox.insert(
                    usage.map {
                        OutboxRow(
                            type = OutboxRow.TYPE_USAGE,
                            itemId = usagePrefix(it) + at,
                            packageName = null,
                            payload = Wire.json.encodeToString(WireUsageDay.serializer(), it),
                            createdAt = at,
                        )
                    },
                )
                outbox.capPendingUsage(OutboxPolicy.MAX_PENDING_USAGE)
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

    /** Phase 4, inside commitEnforcement's transaction. */
    private fun writeLocation(write: LocationWrite, at: Long) {
        val state = write.state
        if (state == null) {
            enforcement.clearLocation()
        } else {
            enforcement.setLocation(LocationRow(state = json.encodeToString(LocationState.serializer(), state), updatedAt = at))
        }
        if (write.dropUnsent) outbox.deleteAllPendingLocations()
        val queued = write.fixes.map {
            OutboxRow(
                type = OutboxRow.TYPE_FIX,
                itemId = "fix:${it.id}",
                packageName = null,
                payload = Wire.json.encodeToString(WireFix.serializer(), it),
                createdAt = at,
            )
        } + write.placeEvents.map {
            OutboxRow(
                type = OutboxRow.TYPE_PLACE_EVENT,
                itemId = "place_event:${it.id}",
                packageName = null,
                payload = Wire.json.encodeToString(WirePlaceEvent.serializer(), it),
                createdAt = at,
            )
        }
        if (queued.isNotEmpty()) {
            outbox.insert(queued)
            outbox.capPendingLocations(OutboxPolicy.MAX_PENDING_LOCATIONS)
        }
        if (write.told.isNotEmpty()) {
            enforcement.upsertTold(write.told.map { ToldRow(it.id, Told.lastAt(it), json.encodeToString(ToldEntry.serializer(), it)) })
        }
        enforcement.pruneTold(Told.keepFrom(at))
    }

    /** Phase 5, inside commitEnforcement's transaction. */
    private fun writeCalls(write: CallsWrite, at: Long) {
        val state = write.state
        if (state == null) {
            enforcement.clearCallsState()
        } else {
            enforcement.setCallsState(CallsStateRow(state = json.encodeToString(CallsState.serializer(), state), updatedAt = at))
        }
        if (write.dropUnsent) {
            val dropped = outbox.deleteAllPendingCalls()
            if (dropped > 0) Log.i(Agent.TAG, "calls: $dropped unsent call records dropped (the policy doesn't log calls)")
        }
        if (write.clearRecents) enforcement.clearCalls()
    }

    /** Phase 5: calls' state; null before calls was ever on (or after it went off and was undone). */
    fun callsState(): CallsState? = enforcement.callsState()?.let { decode(it.state, CallsState.serializer()) }

    /** For the agent thread only, between steps (a call to 911 or 988 opened the callback window). */
    fun saveCallsState(state: CallsState, at: Long) =
        enforcement.setCallsState(CallsStateRow(state = json.encodeToString(CallsState.serializer(), state), updatedAt = at))

    /** Phase 5: Belay's own recent calls, the newest first. */
    fun calls(limit: Int = CallRecords.MAX_KEPT): List<CallEntry> =
        enforcement.calls(limit).mapNotNull { decode(it.entry, CallEntry.serializer()) }

    /**
     * Phase 5, the agent thread: a call that ended. [entry] goes in Belay's own recent calls (null:
     * one it must never keep, core's CallRecords), and [record] to the outbox (only with `log`).
     */
    fun commitCall(entry: CallEntry?, record: WireCallRecord?, at: Long) {
        if (entry == null && record == null) return
        db.runInTransaction {
            if (entry != null) {
                enforcement.upsertCalls(listOf(CallRow(entry.id, entry.at, json.encodeToString(CallEntry.serializer(), entry))))
                enforcement.pruneCalls(at - CallRecords.KEEP_MS, CallRecords.MAX_KEPT)
            }
            if (record != null) {
                outbox.insert(
                    listOf(
                        OutboxRow(
                            type = OutboxRow.TYPE_CALL,
                            itemId = "call:${record.id}",
                            packageName = null,
                            payload = Wire.json.encodeToString(WireCallRecord.serializer(), record),
                            createdAt = at,
                        ),
                    ),
                )
                outbox.capPendingCalls(OutboxPolicy.MAX_PENDING_CALLS)
            }
        }
    }

    /** Phase 4: location's state; null while location is off and nothing is being shared (no row). */
    fun locationState(): LocationState? = enforcement.location()?.let { decode(it.state, LocationState.serializer()) }

    /** For the agent thread only, between steps (Phase 7: the kid chose to share where the phone is). */
    fun saveLocationState(state: LocationState, at: Long) =
        enforcement.setLocation(LocationRow(state = json.encodeToString(LocationState.serializer(), state), updatedAt = at))

    /** Phase 7: "What Belay told your parent", the newest first, at most [limit] lines. */
    fun told(limit: Int = TOLD_ON_SCREEN): List<ToldEntry> =
        enforcement.told(limit).mapNotNull { decode(it.entry, ToldEntry.serializer()) }

    /** What the Private DNS thread last did; null before it ever ran. */
    fun privateDns(): PrivateDnsRow? = enforcement.privateDns()

    /** For the Private DNS thread only. */
    fun savePrivateDns(row: PrivateDnsRow) = enforcement.setPrivateDns(row)

    // Phases 6 and 10: the update, the recovery key, commands, and a policy too big to read.

    /** How the offered update is going; null before Belay ever started on one. */
    fun agentUpdate(): UpdateRecord? = enforcement.agentUpdate()?.let { decode(it.record, UpdateRecord.serializer()) }

    /** For the update thread only. */
    fun saveAgentUpdate(record: UpdateRecord, at: Long) =
        enforcement.setAgentUpdate(AgentUpdateRow(record = json.encodeToString(UpdateRecord.serializer(), record), updatedAt = at))

    /** The recovery key's wrong tries and last use; empty before the first try. */
    fun recovery(): RecoveryState = enforcement.recovery()?.let { decode(it.state, RecoveryState.serializer()) } ?: RecoveryState()

    /** For the agent thread only. */
    fun saveRecovery(state: RecoveryState, at: Long) =
        enforcement.setRecovery(RecoveryRow(state = json.encodeToString(RecoveryState.serializer(), state), updatedAt = at))

    /** The commands run, and their last results; written by commitEnforcement. */
    fun commandLog(): CommandLog = enforcement.commands()?.let { decode(it.log, CommandLog.serializer()) } ?: CommandLog()

    /** The server's last policy answer, if it was too big to read; null once one was read again. */
    fun policyTooLarge(): PolicyFetchRow? = enforcement.policyFetch()

    /** An answer too big to read arrived. True when that's news (a new problem, or a new size). */
    fun notePolicyTooLarge(bytes: Long?, at: Long): Boolean = db.runInTransaction<Boolean> {
        val before = enforcement.policyFetch()
        enforcement.setPolicyFetch(PolicyFetchRow(tooLargeAt = at, tooLargeBytes = bytes))
        before == null || before.tooLargeBytes != bytes
    }

    /** A policy answer was read. True when one too big to read was on record until now. */
    fun clearPolicyTooLarge(): Boolean = enforcement.clearPolicyFetch() > 0

    // Phase 3: screen time.

    /** Whether screen time has a row (without reading it). */
    fun hasScreenTime(): Boolean = enforcement.screenTimeRows() > 0

    /** Screen time's ledger and state; null when the policy has none (no row). */
    fun screenTime(): ScreenTimeStored? = enforcement.screenTime()?.let { row ->
        ScreenTimeStored(decode(row.ledger, UsageLedger.serializer()), decode(row.state, ScreenTimeState.serializer()))
    }

    /** For the agent thread only, between steps (the kid took self-serve minutes). False when there's no row yet. */
    fun saveScreenTimeState(state: ScreenTimeState, at: Long): Boolean =
        enforcement.setScreenTimeState(json.encodeToString(ScreenTimeState.serializer(), state), at) > 0

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

        /** The start of a usage day's outbox item id: the day and its zone, so a newer report replaces it. */
        fun usagePrefix(day: WireUsageDay): String = "usage:${day.day}:${day.zone}:"

        /** Well under SQLite's limit on bound parameters. */
        private const val CHUNK = 500

        /** Lines of "What Belay told your parent" the screen shows (30 days of them, almost always all). */
        const val TOLD_ON_SCREEN = 500

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
