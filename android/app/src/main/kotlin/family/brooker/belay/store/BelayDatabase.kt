package family.brooker.belay.store

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/*
 * Everything the agent keeps, in databases/belay.db. The "database" domain is excluded from
 * backups and device transfers (res/xml/data_extraction_rules.xml), so none of it leaves the
 * phone that way. Records are stored as JSON where only the agent reads them, so they can
 * grow fields without a schema change.
 */

/** The last known inventory: the baseline every scan is compared with. */
@Entity(tableName = "packages")
data class PackageRow(
    @PrimaryKey @ColumnInfo(name = "package_name") val packageName: String,
    /** A PackageRecord, as JSON. */
    val record: String,
)

/** One row: the change cursor and scan times. */
@Entity(tableName = "scan_state")
data class ScanStateRow(
    @PrimaryKey val id: Int = 0,
    @ColumnInfo(name = "last_full_scan_at") val lastFullScanAt: Long?,
    @ColumnInfo(name = "last_scan_at") val lastScanAt: Long?,
    @ColumnInfo(name = "cursor_boot_count") val cursorBootCount: Int?,
    @ColumnInfo(name = "cursor_sequence") val cursorSequence: Int?,
)

/** The recent changes the screen shows, newest last (capped at Reconcile.MAX_CHANGES). */
@Entity(tableName = "changes", indices = [Index(value = ["change_id"], unique = true)])
data class ChangeRow(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    @ColumnInfo(name = "change_id") val changeId: String,
    @ColumnInfo(name = "package_name") val packageName: String,
    /** An AppChange, as JSON. */
    val change: String,
)

/** When the agent ran, and why (capped at Reconcile.MAX_HEARTBEATS). */
@Entity(tableName = "heartbeats")
data class HeartbeatRow(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val at: Long,
    val trigger: String,
    val note: String?,
)

/** Phase 2. One row: the last policy the phone got, enforced offline and after a restart. */
@Entity(tableName = "policy")
data class PolicyRow(
    @PrimaryKey val id: Int = 0,
    val version: Int,
    /** A WirePolicy, as JSON. */
    val policy: String,
    @ColumnInfo(name = "received_at") val receivedAt: Long,
)

/** Phase 2. One row: what Belay itself applied (core's Applied, as JSON), so it only undoes its own. */
@Entity(tableName = "enforcement")
data class EnforcementRow(
    @PrimaryKey val id: Int = 0,
    val applied: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/** Phase 2. The kid's requests (core's KidRequest, as JSON), newest kept 60 days. */
@Entity(tableName = "requests", indices = [Index(value = ["package_name"])])
data class RequestRow(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "package_name") val packageName: String,
    val request: String,
    @ColumnInfo(name = "asked_at") val askedAt: Long,
)

/**
 * Phase 2. One row, written only by the Private DNS thread: the host Belay set (null: none),
 * and how the last attempt went. Setting a host checks it over the network first, which can
 * take seconds, so it doesn't run on the agent thread.
 */
@Entity(tableName = "private_dns")
data class PrivateDnsRow(
    @PrimaryKey val id: Int = 0,
    @ColumnInfo(name = "set_host") val setHost: String?,
    @ColumnInfo(name = "attempt_host") val attemptHost: String?,
    @ColumnInfo(name = "attempt_at") val attemptAt: Long?,
    /** Null when the last attempt worked. */
    val error: String?,
)

/**
 * Phase 6. One row, written only by the update thread (update/AgentUpdater.kt): how the offered
 * update is going (core's UpdateRecord, as JSON). It outlives the restart an update causes.
 */
@Entity(tableName = "agent_update")
data class AgentUpdateRow(
    @PrimaryKey val id: Int = 0,
    val record: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/** Phase 6. One row, written only by the agent thread: the recovery key's wrong tries and last use (core's RecoveryState, as JSON). */
@Entity(tableName = "recovery")
data class RecoveryRow(
    @PrimaryKey val id: Int = 0,
    val state: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/** Phase 10. One row, written only by the agent thread: the commands run and their last results (core's CommandLog, as JSON). */
@Entity(tableName = "commands")
data class CommandsRow(
    @PrimaryKey val id: Int = 0,
    val log: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * One row while the server's last policy answer was too big to read (core's PolicyTooLarge),
 * written by the sync and long-poll threads; gone once a policy answer is read again.
 */
@Entity(tableName = "policy_fetch")
data class PolicyFetchRow(
    @PrimaryKey val id: Int = 0,
    @ColumnInfo(name = "too_large_at") val tooLargeAt: Long,
    /** The answer's Content-Length; null when the server didn't send one. */
    @ColumnInfo(name = "too_large_bytes") val tooLargeBytes: Long?,
)

/**
 * Phase 3. One row while the policy has screen_time, written only by the agent thread: Belay's
 * own count of what was on the screen (core's UsageLedger, as JSON: yesterday and today) and the
 * rest screen time keeps between steps (core's ScreenTimeState: the kid's self-serve takes,
 * notices shown, screen locks done, uploads). Deleted when the policy no longer has screen time.
 */
@Entity(tableName = "screen_time")
data class ScreenTimeRow(
    @PrimaryKey val id: Int = 0,
    val ledger: String,
    val state: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * Phase 4. One row while the policy has location on (or a help fix is being shared), written
 * only by the agent thread: core's LocationState, as JSON: where each place stands, the last fix,
 * the fixes Belay still wants, lost mode as applied and the report. No history of fixes: they go
 * to the server through the outbox, and leave the phone once sent.
 */
@Entity(tableName = "location")
data class LocationRow(
    @PrimaryKey val id: Int = 0,
    val state: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * Phase 7. "What Belay told your parent": each check a parent asked for, each lost mode and each
 * fix the kid shared (core's ToldEntry, as JSON), written only by the agent thread from what it
 * ran, kept 30 days. [lastAt] is when it last told the parent something (a lost mode's last fix).
 */
@Entity(tableName = "told", indices = [Index(value = ["last_at"])])
data class ToldRow(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "last_at") val lastAt: Long,
    val entry: String,
)

/**
 * Phase 5. One row while calls is or was on, written only by the agent thread: core's CallsState,
 * as JSON: the dialer Belay took the role from, the numbers it put on Android's block list, the
 * apps it denied CALL_PHONE, and when the kid last called 911 or 988 (only for the callback window,
 * forgotten once it's over, never sent).
 */
@Entity(tableName = "calls_state")
data class CallsStateRow(
    @PrimaryKey val id: Int = 0,
    val state: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * Phase 5. Belay's own recent calls (core's CallEntry, as JSON), for its dialer, kept 30 days and
 * deleted when calls goes off; never a call with 911, an emergency number, 988 or a private number
 * (core's CallRecords). With `calls.log`, each one also goes to the outbox as a WireCallRecord.
 */
@Entity(tableName = "calls", indices = [Index(value = ["at"])])
data class CallRow(
    @PrimaryKey val id: String,
    val at: Long,
    val entry: String,
)

/**
 * Phase 3, network logging. One row while the policy has network logging on, written only by the
 * agent thread: core's NetworkLogState, as JSON (where Android's batches stand, and the report).
 * Deleted, with the days, when logging goes off.
 */
@Entity(tableName = "network_state")
data class NetworkStateRow(
    @PrimaryKey val id: Int = 0,
    val state: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * Phase 3, network logging: one local day Belay is still counting (core's NetworkDay without its
 * counts), today and the two days before; older ones are deleted, their last report already in
 * the outbox. Written only by the agent thread.
 */
@Entity(tableName = "network_days")
data class NetworkDayRow(
    /** "YYYY-MM-DD" in [zone]. */
    @PrimaryKey val day: String,
    val zone: String,
    @ColumnInfo(name = "as_of") val asOf: Long,
    /** Entries that came after the day already held its most: counted in `dropped`. */
    val overflow: Int,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * Phase 3, network logging: how many times one app looked up one domain on one day (core's
 * NetworkKey and its count), all that Belay keeps of Android's DNS lookups. Deleted with its day
 * (NetworkDao.pruneDays and clearDays delete both).
 */
@Entity(tableName = "network_counts", primaryKeys = ["day", "package_name", "domain"])
data class NetworkCountRow(
    val day: String,
    @ColumnInfo(name = "package_name") val packageName: String,
    val domain: String,
    val lookups: Int,
)

/**
 * What waits to be sent, in the order it was made: [id] is AUTOINCREMENT, so it only ever
 * grows. Events are written in the same transaction as the baseline that found them.
 * Sent and dropped rows stay a while (OutboxPolicy.KEEP_FINISHED_MS) for the screen and for
 * tests; a sent snapshot, usage day, fix or place event is deleted at once.
 */
@Entity(
    tableName = "outbox",
    indices = [Index(value = ["item_id"], unique = true), Index(value = ["state", "id"])],
)
data class OutboxRow(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** [TYPE_EVENT], [TYPE_SNAPSHOT], [TYPE_REQUEST], [TYPE_USAGE], [TYPE_FIX], [TYPE_PLACE_EVENT], [TYPE_CALL] or [TYPE_NETWORK]. */
    val type: String,
    /**
     * The event's id or the snapshot's snapshot_id: the server de-duplicates on it. A request
     * is sent again with each new reason, so its item id also counts the sends (core's
     * Requests.itemId); the server de-duplicates on the request's own id. A usage day is
     * "usage:<day>:<zone>:<queued at>" (AgentStore.usageItemId): a newer one replaces it. A fix
     * or a place event is "fix:<id>" or "place_event:<id>"; a call record "call:<id>"; a network
     * day "network:<day>:<queued at>" (AgentStore.networkItemId): a newer one replaces it.
     */
    @ColumnInfo(name = "item_id") val itemId: String,
    /** The event's or the request's package (null for snapshots, usage days, fixes and place events). */
    @ColumnInfo(name = "package_name") val packageName: String?,
    /** The WireEvent, InventoryRequest, WireRequest, WireUsageDay, WireFix, WirePlaceEvent, WireCallRecord or WireNetworkDay, as the JSON that is sent. */
    val payload: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    val attempts: Int = 0,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long = 0,
    @ColumnInfo(name = "last_error") val lastError: String? = null,
    /** [STATE_PENDING], [STATE_SENT] or [STATE_DROPPED]. */
    val state: String = STATE_PENDING,
    /** When it was sent or dropped. */
    @ColumnInfo(name = "finished_at") val finishedAt: Long? = null,
) {
    companion object {
        const val TYPE_EVENT = "event"
        const val TYPE_SNAPSHOT = "snapshot"
        const val TYPE_REQUEST = "request"

        /** Phase 3: one usage day for `POST /api/v1/usage`. */
        const val TYPE_USAGE = "usage"

        /** Phase 4: one fix, and one place event, for `POST /api/v1/locations`. */
        const val TYPE_FIX = "fix"
        const val TYPE_PLACE_EVENT = "place_event"

        /** Phase 5: one call record, for `POST /api/v1/calls`. */
        const val TYPE_CALL = "call"

        /** Phase 3, network logging: one day of lookups, for `POST /api/v1/network`. */
        const val TYPE_NETWORK = "network"
        const val STATE_PENDING = "pending"
        const val STATE_SENT = "sent"
        const val STATE_DROPPED = "dropped"
    }
}

/** An outbox row without its payload (a snapshot's can be large). */
data class QueuedRow(
    val id: Long,
    val type: String,
    /** The payload's size in bytes, as UTF-8. */
    val bytes: Int,
    val attempts: Int,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long,
)

data class PayloadRow(val id: Long, val payload: String)

/** Phase 4: a fix's or a place event's payload, with which of the two it is. */
data class TypedPayloadRow(val id: Long, val type: String, val payload: String)

@Dao
interface InventoryDao {
    @Query("SELECT * FROM packages")
    fun packages(): List<PackageRow>

    @Upsert
    fun upsertPackages(rows: List<PackageRow>)

    @Query("DELETE FROM packages WHERE package_name IN (:names)")
    fun deletePackages(names: List<String>)

    @Query("SELECT * FROM scan_state WHERE id = 0")
    fun scanState(): ScanStateRow?

    @Upsert
    fun setScanState(row: ScanStateRow)
}

@Dao
interface LogDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertChanges(rows: List<ChangeRow>)

    @Query("SELECT * FROM changes ORDER BY seq DESC LIMIT :limit")
    fun recentChanges(limit: Int): List<ChangeRow>

    @Query("DELETE FROM changes WHERE seq NOT IN (SELECT seq FROM changes ORDER BY seq DESC LIMIT :keep)")
    fun pruneChanges(keep: Int)

    @Insert
    fun insertHeartbeats(rows: List<HeartbeatRow>)

    @Query("SELECT * FROM heartbeats ORDER BY seq DESC LIMIT :limit")
    fun recentHeartbeats(limit: Int): List<HeartbeatRow>

    @Query("DELETE FROM heartbeats WHERE seq NOT IN (SELECT seq FROM heartbeats ORDER BY seq DESC LIMIT :keep)")
    fun pruneHeartbeats(keep: Int)
}

@Dao
interface OutboxDao {
    /** Idempotent: an item already queued (same item_id) is left as it is. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insert(rows: List<OutboxRow>)

    @Query(
        "SELECT id, type, length(CAST(payload AS BLOB)) AS bytes, attempts, next_attempt_at FROM outbox " +
            "WHERE state = 'pending' ORDER BY id LIMIT :limit",
    )
    fun queue(limit: Int): List<QueuedRow>

    @Query("SELECT id, payload FROM outbox WHERE id IN (:ids) AND type = :type ORDER BY id")
    fun payloads(ids: List<Long>, type: String): List<PayloadRow>

    @Query("SELECT length(payload) FROM outbox WHERE id = :id")
    fun payloadLength(id: Long): Int?

    /** Part of one payload: a snapshot can be larger than a CursorWindow (2 MB) holds. */
    @Query("SELECT substr(payload, :start, :length) FROM outbox WHERE id = :id")
    fun payloadPart(id: Long, start: Int, length: Int): String?

    /** Phase 4: fixes and place events, in [ids] order is up to the caller. */
    @Query("SELECT id, type, payload FROM outbox WHERE id IN (:ids) AND type IN ('fix', 'place_event') ORDER BY id")
    fun locationPayloads(ids: List<Long>): List<TypedPayloadRow>

    /** Phase 5: call records, in [ids] order is up to the caller. */
    @Query("SELECT id, payload FROM outbox WHERE id IN (:ids) AND type = 'call' ORDER BY id")
    fun callPayloads(ids: List<Long>): List<PayloadRow>

    /** Events and requests; a sent snapshot, usage day, fix, place event, call record or network day is deleted instead ([deleteSentLarge]). */
    @Query(
        "UPDATE outbox SET state = 'sent', finished_at = :at, last_error = NULL WHERE id IN (:ids) " +
            "AND type NOT IN ('snapshot', 'usage', 'fix', 'place_event', 'call', 'network')",
    )
    fun markItemsSent(ids: List<Long>, at: Long)

    /**
     * Snapshots and usage days: large, and replaced by newer ones anyway. Fixes and place events
     * (Phase 4): where the phone was doesn't stay on the phone once the family's server has it. Call
     * records (Phase 5): the copy sent; Belay's own recent calls are in their own table. Network days
     * (Phase 3): the copy sent; the day still being counted is in network_days.
     */
    @Query("DELETE FROM outbox WHERE id IN (:ids) AND type IN ('snapshot', 'usage', 'fix', 'place_event', 'call', 'network')")
    fun deleteSentLarge(ids: List<Long>)

    /**
     * A dropped snapshot keeps its row and reason, not its payload; so do a fix and a place event
     * (Phase 4), a call record (Phase 5: it may hold someone's number) and a network day (Phase 3:
     * which websites apps looked up).
     */
    @Query(
        "UPDATE outbox SET state = 'dropped', finished_at = :at, last_error = :reason, " +
            "payload = CASE WHEN type IN ('snapshot', 'fix', 'place_event', 'call', 'network') THEN '' ELSE payload END WHERE id = :id",
    )
    fun markDropped(id: Long, reason: String, at: Long)

    @Query(
        "UPDATE outbox SET attempts = attempts + 1, last_error = :error, next_attempt_at = :nextAttemptAt " +
            "WHERE id IN (:ids)",
    )
    fun markFailed(ids: List<Long>, error: String, nextAttemptAt: Long)

    @Query("SELECT MAX(attempts) FROM outbox WHERE id IN (:ids)")
    fun maxAttempts(ids: List<Long>): Int?

    /** After a new enrollment: everything waiting goes at once. */
    @Query("UPDATE outbox SET next_attempt_at = 0 WHERE state = 'pending'")
    fun makePendingDue()

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending'")
    fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending'")
    fun pendingCountFlow(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND type = 'event'")
    fun pendingEventCount(): Int

    /** Only the newest unsent snapshot matters. */
    @Query(
        "DELETE FROM outbox WHERE type = 'snapshot' AND state = 'pending' AND id < " +
            "(SELECT MAX(id) FROM outbox WHERE type = 'snapshot' AND state = 'pending')",
    )
    fun deleteOlderPendingSnapshots()

    @Query(
        "DELETE FROM outbox WHERE id IN " +
            "(SELECT id FROM outbox WHERE type = 'event' AND state = 'pending' ORDER BY id LIMIT :count)",
    )
    fun deleteOldestPendingEvents(count: Int)

    @Query(
        "DELETE FROM outbox WHERE state != 'pending' AND (finished_at < :before OR id NOT IN " +
            "(SELECT id FROM outbox WHERE state != 'pending' ORDER BY id DESC LIMIT :keep))",
    )
    fun pruneFinished(before: Long, keep: Int)

    @Query("SELECT * FROM outbox WHERE type = 'event' AND package_name = :packageName ORDER BY id")
    fun eventsFor(packageName: String): List<OutboxRow>

    @Query("SELECT * FROM outbox WHERE type = 'request' AND package_name = :packageName ORDER BY id")
    fun requestsFor(packageName: String): List<OutboxRow>

    /** The kid's screen shows whether each request has reached the server yet. */
    @Query("SELECT item_id FROM outbox WHERE type = 'request' AND state = 'pending'")
    fun pendingRequestItemIds(): Flow<List<String>>

    /** An unsent earlier send of the same request: the newer one replaces it. */
    @Query("DELETE FROM outbox WHERE type = 'request' AND state = 'pending' AND item_id LIKE :itemIdPrefix || '%'")
    fun deletePendingRequestSends(itemIdPrefix: String)

    /** Phase 3: an unsent earlier report of the same day (item ids starting [itemIdPrefix]): the newer one replaces it. */
    @Query("DELETE FROM outbox WHERE type = 'usage' AND state = 'pending' AND substr(item_id, 1, length(:itemIdPrefix)) = :itemIdPrefix")
    fun deletePendingUsage(itemIdPrefix: String)

    /** Phase 3: keeps the newest [keep] unsent usage days. */
    @Query(
        "DELETE FROM outbox WHERE id IN " +
            "(SELECT id FROM outbox WHERE type = 'usage' AND state = 'pending' ORDER BY id DESC LIMIT -1 OFFSET :keep)",
    )
    fun capPendingUsage(keep: Int)

    /** Phase 3: every unsent usage day, when the policy stops measuring. */
    @Query("DELETE FROM outbox WHERE type = 'usage' AND state = 'pending'")
    fun deleteAllPendingUsage(): Int

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND type = 'usage'")
    fun pendingUsageCount(): Int

    /** Phase 4: keeps the newest [keep] unsent fixes and place events. */
    @Query(
        "DELETE FROM outbox WHERE id IN " +
            "(SELECT id FROM outbox WHERE type IN ('fix', 'place_event') AND state = 'pending' ORDER BY id DESC LIMIT -1 OFFSET :keep)",
    )
    fun capPendingLocations(keep: Int)

    /** Phase 4: every unsent fix and place event, when location goes off. */
    @Query("DELETE FROM outbox WHERE type IN ('fix', 'place_event') AND state = 'pending'")
    fun deleteAllPendingLocations(): Int

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND type IN ('fix', 'place_event')")
    fun pendingLocationCount(): Int

    /** Phase 5: keeps the newest [keep] unsent call records. */
    @Query(
        "DELETE FROM outbox WHERE id IN " +
            "(SELECT id FROM outbox WHERE type = 'call' AND state = 'pending' ORDER BY id DESC LIMIT -1 OFFSET :keep)",
    )
    fun capPendingCalls(keep: Int)

    /** Phase 5: every unsent call record, when `log` goes off. */
    @Query("DELETE FROM outbox WHERE type = 'call' AND state = 'pending'")
    fun deleteAllPendingCalls(): Int

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND type = 'call'")
    fun pendingCallCount(): Int

    /** Phase 3, network logging: an unsent earlier report of the same day (item ids starting [itemIdPrefix]): the newer one replaces it. */
    @Query("DELETE FROM outbox WHERE type = 'network' AND state = 'pending' AND substr(item_id, 1, length(:itemIdPrefix)) = :itemIdPrefix")
    fun deletePendingNetwork(itemIdPrefix: String)

    /** Phase 3, network logging: keeps the newest [keep] unsent network days. */
    @Query(
        "DELETE FROM outbox WHERE id IN " +
            "(SELECT id FROM outbox WHERE type = 'network' AND state = 'pending' ORDER BY id DESC LIMIT -1 OFFSET :keep)",
    )
    fun capPendingNetwork(keep: Int)

    /** Phase 3, network logging: every unsent network day, when logging goes off. */
    @Query("DELETE FROM outbox WHERE type = 'network' AND state = 'pending'")
    fun deleteAllPendingNetwork(): Int

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND type = 'network'")
    fun pendingNetworkCount(): Int

    @Query("SELECT state, COUNT(*) AS count FROM outbox GROUP BY state")
    fun countsByState(): List<StateCount>
}

data class StateCount(val state: String, val count: Int)

/** Phase 2: the policy, what Belay applied, the kid's requests, Private DNS. */
@Dao
interface EnforcementDao {
    @Query("SELECT * FROM policy WHERE id = 0")
    fun policy(): PolicyRow?

    /** For the long-poll's `have`, without reading the whole policy. */
    @Query("SELECT version FROM policy WHERE id = 0")
    fun policyVersion(): Int?

    @Upsert
    fun setPolicy(row: PolicyRow)

    @Query("SELECT * FROM enforcement WHERE id = 0")
    fun enforcement(): EnforcementRow?

    @Upsert
    fun setEnforcement(row: EnforcementRow)

    @Query("SELECT * FROM requests ORDER BY asked_at DESC")
    fun requests(): List<RequestRow>

    @Upsert
    fun upsertRequests(rows: List<RequestRow>)

    @Query("DELETE FROM requests WHERE asked_at < :before")
    fun pruneRequests(before: Long)

    @Query("SELECT * FROM private_dns WHERE id = 0")
    fun privateDns(): PrivateDnsRow?

    @Upsert
    fun setPrivateDns(row: PrivateDnsRow)

    @Query("SELECT * FROM agent_update WHERE id = 0")
    fun agentUpdate(): AgentUpdateRow?

    @Upsert
    fun setAgentUpdate(row: AgentUpdateRow)

    @Query("SELECT * FROM recovery WHERE id = 0")
    fun recovery(): RecoveryRow?

    @Upsert
    fun setRecovery(row: RecoveryRow)

    @Query("SELECT * FROM commands WHERE id = 0")
    fun commands(): CommandsRow?

    @Upsert
    fun setCommands(row: CommandsRow)

    @Query("SELECT * FROM policy_fetch WHERE id = 0")
    fun policyFetch(): PolicyFetchRow?

    @Upsert
    fun setPolicyFetch(row: PolicyFetchRow)

    /** The number of rows deleted: 1 when a too-large answer was on record. */
    @Query("DELETE FROM policy_fetch")
    fun clearPolicyFetch(): Int

    @Query("SELECT * FROM screen_time WHERE id = 0")
    fun screenTime(): ScreenTimeRow?

    @Upsert
    fun setScreenTime(row: ScreenTimeRow)

    /** The number of rows updated: 0 when there's no screen time row yet. */
    @Query("UPDATE screen_time SET state = :state, updated_at = :at WHERE id = 0")
    fun setScreenTimeState(state: String, at: Long): Int

    @Query("DELETE FROM screen_time")
    fun clearScreenTime(): Int

    @Query("SELECT COUNT(*) FROM screen_time")
    fun screenTimeRows(): Int

    @Query("SELECT * FROM location WHERE id = 0")
    fun location(): LocationRow?

    @Upsert
    fun setLocation(row: LocationRow)

    @Query("DELETE FROM location")
    fun clearLocation(): Int

    /** "What Belay told your parent", the newest first. */
    @Query("SELECT * FROM told ORDER BY last_at DESC LIMIT :limit")
    fun told(limit: Int): List<ToldRow>

    @Upsert
    fun upsertTold(rows: List<ToldRow>)

    @Query("DELETE FROM told WHERE last_at < :before")
    fun pruneTold(before: Long)

    @Query("SELECT * FROM calls_state WHERE id = 0")
    fun callsState(): CallsStateRow?

    @Upsert
    fun setCallsState(row: CallsStateRow)

    @Query("DELETE FROM calls_state")
    fun clearCallsState(): Int

    /** Belay's recent calls, the newest first. */
    @Query("SELECT * FROM calls ORDER BY at DESC LIMIT :limit")
    fun calls(limit: Int): List<CallRow>

    @Upsert
    fun upsertCalls(rows: List<CallRow>)

    /** Keeps the last 30 days, at most [keep] rows. */
    @Query("DELETE FROM calls WHERE at < :before OR id NOT IN (SELECT id FROM calls ORDER BY at DESC LIMIT :keep)")
    fun pruneCalls(before: Long, keep: Int)

    @Query("DELETE FROM calls")
    fun clearCalls(): Int
}

/** Phase 3, network logging: its state, and the days Belay is still counting. Only the agent thread writes. */
@Dao
interface NetworkDao {
    @Query("SELECT * FROM network_state WHERE id = 0")
    fun state(): NetworkStateRow?

    @Upsert
    fun setState(row: NetworkStateRow)

    @Query("SELECT * FROM network_days WHERE day IN (:days)")
    fun days(days: List<String>): List<NetworkDayRow>

    @Query("SELECT * FROM network_days ORDER BY day")
    fun allDays(): List<NetworkDayRow>

    @Query("SELECT * FROM network_counts WHERE day = :day")
    fun counts(day: String): List<NetworkCountRow>

    @Query("SELECT COUNT(*) FROM network_counts WHERE day = :day")
    fun countEntries(day: String): Int

    @Upsert
    fun upsertDays(rows: List<NetworkDayRow>)

    @Upsert
    fun upsertCounts(rows: List<NetworkCountRow>)

    /** Days older than [before] ("YYYY-MM-DD"): their counts, then the days. In a transaction. */
    @Query("DELETE FROM network_counts WHERE day < :before")
    fun pruneCounts(before: String): Int

    @Query("DELETE FROM network_days WHERE day < :before")
    fun pruneDays(before: String): Int

    /** Everything, when logging goes off: the state, the days and their counts. */
    @Query("DELETE FROM network_state")
    fun clearState(): Int

    @Query("DELETE FROM network_counts")
    fun clearCounts(): Int

    @Query("DELETE FROM network_days")
    fun clearDays(): Int
}

/**
 * Version 2 (Phase 2) adds the policy, enforcement, requests and private_dns tables; the
 * outbox gains a third type ("request") without a schema change. Version 3 (Phases 6 and 10)
 * adds agent_update, recovery, commands and policy_fetch, one row each. Version 4 (Phase 3) adds
 * screen_time, one row; the outbox gains "usage" and the requests their new kinds without a
 * schema change. Version 5 (Phases 4 and 7) adds location, one row, and told; the outbox gains
 * "fix" and "place_event", and the requests help, talk and withdrawals, without a schema change.
 * Version 6 (Phase 5) adds calls_state, one row, and calls; the outbox gains "call", and the
 * requests the contact kind, without a schema change. Version 7 (Phase 3's network logging) adds
 * network_state, one row, network_days and network_counts; the outbox gains "network" without a
 * schema change. Room migrates each version to the next by itself from the exported schemas in
 * app/schemas/ (new tables only).
 */
@Database(
    entities = [
        PackageRow::class, ScanStateRow::class, ChangeRow::class, HeartbeatRow::class, OutboxRow::class,
        PolicyRow::class, EnforcementRow::class, RequestRow::class, PrivateDnsRow::class,
        AgentUpdateRow::class, RecoveryRow::class, CommandsRow::class, PolicyFetchRow::class,
        ScreenTimeRow::class, LocationRow::class, ToldRow::class, CallsStateRow::class, CallRow::class,
        NetworkStateRow::class, NetworkDayRow::class, NetworkCountRow::class,
    ],
    version = 7,
    exportSchema = true,
    autoMigrations = [
        AutoMigration(from = 1, to = 2), AutoMigration(from = 2, to = 3), AutoMigration(from = 3, to = 4),
        AutoMigration(from = 4, to = 5), AutoMigration(from = 5, to = 6), AutoMigration(from = 6, to = 7),
    ],
)
abstract class BelayDatabase : RoomDatabase() {
    abstract fun inventory(): InventoryDao
    abstract fun log(): LogDao
    abstract fun outbox(): OutboxDao
    abstract fun enforcement(): EnforcementDao
    abstract fun network(): NetworkDao

    companion object {
        const val NAME = "belay.db"

        @Volatile
        private var instance: BelayDatabase? = null

        fun get(context: Context): BelayDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, BelayDatabase::class.java, NAME)
                .build()
                .also { instance = it }
        }
    }
}
