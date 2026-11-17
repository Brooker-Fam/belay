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
 * What waits to be sent, in the order it was made: [id] is AUTOINCREMENT, so it only ever
 * grows. Events are written in the same transaction as the baseline that found them.
 * Sent and dropped rows stay a while (OutboxPolicy.KEEP_FINISHED_MS) for the screen and for
 * tests; a sent snapshot is deleted at once.
 */
@Entity(
    tableName = "outbox",
    indices = [Index(value = ["item_id"], unique = true), Index(value = ["state", "id"])],
)
data class OutboxRow(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** [TYPE_EVENT], [TYPE_SNAPSHOT] or [TYPE_REQUEST]. */
    val type: String,
    /**
     * The event's id or the snapshot's snapshot_id: the server de-duplicates on it. A request
     * is sent again with each new reason, so its item id also counts the sends (core's
     * Requests.itemId); the server de-duplicates on the request's own id.
     */
    @ColumnInfo(name = "item_id") val itemId: String,
    /** The event's or the request's package (null for snapshots). */
    @ColumnInfo(name = "package_name") val packageName: String?,
    /** The WireEvent, InventoryRequest or WireRequest, as the JSON that is sent. */
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

    /** Events and requests; a sent snapshot is deleted instead ([deleteSnapshots]). */
    @Query("UPDATE outbox SET state = 'sent', finished_at = :at, last_error = NULL WHERE id IN (:ids) AND type != 'snapshot'")
    fun markItemsSent(ids: List<Long>, at: Long)

    @Query("DELETE FROM outbox WHERE id IN (:ids) AND type = 'snapshot'")
    fun deleteSnapshots(ids: List<Long>)

    /** A dropped snapshot keeps its row and reason, not its payload. */
    @Query(
        "UPDATE outbox SET state = 'dropped', finished_at = :at, last_error = :reason, " +
            "payload = CASE type WHEN 'snapshot' THEN '' ELSE payload END WHERE id = :id",
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

    @Query("SELECT state, COUNT(*) AS count FROM outbox GROUP BY state")
    fun countsByState(): List<StateCount>
}

data class StateCount(val state: String, val count: Int)

/** Phase 2: the policy, what Belay applied, the kid's requests, Private DNS. */
@Dao
interface EnforcementDao {
    @Query("SELECT * FROM policy WHERE id = 0")
    fun policy(): PolicyRow?

    @Query("SELECT * FROM policy WHERE id = 0")
    fun policyFlow(): Flow<PolicyRow?>

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
}

/**
 * Version 2 (Phase 2) adds the policy, enforcement, requests and private_dns tables; the
 * outbox gains a third type ("request") without a schema change. Room migrates 1 to 2 by
 * itself from the exported schemas in app/schemas/.
 */
@Database(
    entities = [
        PackageRow::class, ScanStateRow::class, ChangeRow::class, HeartbeatRow::class, OutboxRow::class,
        PolicyRow::class, EnforcementRow::class, RequestRow::class, PrivateDnsRow::class,
    ],
    version = 2,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2)],
)
abstract class BelayDatabase : RoomDatabase() {
    abstract fun inventory(): InventoryDao
    abstract fun log(): LogDao
    abstract fun outbox(): OutboxDao
    abstract fun enforcement(): EnforcementDao

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
