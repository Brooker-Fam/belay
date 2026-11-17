package family.brooker.belay

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.AgentState
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Baseline
import family.brooker.belay.core.ChangeCursor
import family.brooker.belay.core.ChangeKind
import family.brooker.belay.core.Detection
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.InventoryRequest
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.VersionRef
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireHealth
import family.brooker.belay.core.toWire
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.BelayDatabase
import family.brooker.belay.store.OutboxRow
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The Room store on an in-memory database (made-up apps only): what one step writes, the
 * caps, the outbox's order, large payloads, and the one-time Phase 0 import.
 */
@RunWith(AndroidJUnit4::class)
class AgentStoreInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: BelayDatabase
    private lateinit var dir: File
    private lateinit var store: AgentStore

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(context, BelayDatabase::class.java).build()
        dir = File(context.cacheDir, "store-test-${System.nanoTime()}").apply { mkdirs() }
        store = AgentStore(db, dir)
    }

    @After
    fun close() {
        db.close()
        dir.deleteRecursively()
    }

    private fun app(name: String, code: Long = 1) = PackageRecord(
        packageName = name, label = name.substringAfterLast('.'), versionName = "$code", versionCode = code,
        firstInstallTime = T0, lastUpdateTime = T0 + code, system = false,
    )

    private fun change(id: String, kind: ChangeKind, record: PackageRecord) = AppChange(
        id = id, kind = kind, packageName = record.packageName, label = record.label,
        to = VersionRef(record.versionName, record.versionCode), detectedAt = T0, detection = Detection.BROADCAST,
    )

    private val device = WireDevice(
        manufacturer = "Example", model = "Phone", androidRelease = "17", sdk = 37, sdkFull = "37",
        securityPatch = "2026-11-05", agentVersionName = "test", agentVersionCode = 1, lastBootAt = T0,
        timezone = "UTC", deviceTime = T0,
        health = WireHealth(
            deviceOwner = false, batteryExempt = false, usageAccess = false, notificationsShown = true,
            permissions = emptyList(), standbyBucket = 10, backgroundRestricted = false, serviceRunning = false,
            testOnly = true,
        ),
    )

    private fun snapshot(id: String, packages: List<PackageRecord>) =
        InventoryRequest(snapshotId = id, takenAt = T0, bootCount = 1, device = device, packages = packages.map { it.toWire() })

    private fun step(
        previous: Baseline,
        next: Baseline,
        changes: List<AppChange> = emptyList(),
        snapshot: InventoryRequest? = null,
    ) = AgentStore.Step(
        previous = previous, next = next, changes = changes,
        events = changes.map { it.toWire(next.inventory[it.packageName]) },
        snapshot = snapshot, heartbeat = Heartbeat(T0, "test"), at = T0,
    )

    @Test
    fun aStepWritesTheBaselineTheLogAndTheOutboxTogether() {
        val a = app("com.example.a")
        val next = Baseline(mapOf(a.packageName to a), T0, ChangeCursor(3, 7))
        store.commit(step(Baseline(), next, listOf(change("e1", ChangeKind.INSTALLED, a)), snapshot("s1", listOf(a))))

        assertEquals(next, store.loadBaseline())
        assertEquals(listOf("e1"), store.recentChanges(10).map { it.id })
        assertEquals(listOf("test"), store.recentHeartbeats(10).map { it.trigger })
        val queue = store.queue()
        assertEquals(listOf(OutboxRow.TYPE_EVENT, OutboxRow.TYPE_SNAPSHOT), queue.map { it.type })
        assertTrue("events come before the snapshot taken after them", queue[0].id < queue[1].id)
        assertTrue(store.eventPayloads(listOf(queue[0].id)).single().contains("\"app\":{"))
    }

    @Test
    fun aRemovedPackageLeavesTheBaseline() {
        val a = app("com.example.a")
        val b = app("com.example.b")
        val first = Baseline(mapOf(a.packageName to a, b.packageName to b), T0, null)
        store.commit(step(Baseline(), first))
        val second = first.copy(inventory = mapOf(a.packageName to a))
        store.commit(step(first, second))
        assertEquals(setOf("com.example.a"), store.loadBaseline().inventory.keys)
    }

    @Test
    fun onlyTheNewestUnsentSnapshotIsKept() {
        store.commit(step(Baseline(), Baseline(), snapshot = snapshot("s1", emptyList())))
        store.commit(step(Baseline(), Baseline(), listOf(change("e1", ChangeKind.INSTALLED, app("com.example.a")))))
        store.commit(step(Baseline(), Baseline(), snapshot = snapshot("s2", emptyList())))
        val queue = store.queue()
        assertEquals(listOf(OutboxRow.TYPE_EVENT, OutboxRow.TYPE_SNAPSHOT), queue.map { it.type })
        assertTrue(store.payload(queue[1].id)!!.contains("\"snapshot_id\":\"s2\""))
    }

    @Test
    fun theSameEventIsQueuedOnce() {
        val e = change("e1", ChangeKind.INSTALLED, app("com.example.a"))
        store.commit(step(Baseline(), Baseline(), listOf(e)))
        store.commit(step(Baseline(), Baseline(), listOf(e)))
        assertEquals(1, store.pendingCount())
    }

    @Test
    fun aPayloadLargerThanACursorWindowStillReadsBack() {
        // About 3 MB (labels and version names are capped at 200 characters each): more than
        // the 2 MB a CursorWindow holds.
        val packages = (1..4000).map { app("com.example.app$it").copy(label = "x".repeat(200), versionName = "y".repeat(200)) }
        store.commit(step(Baseline(), Baseline(), snapshot = snapshot("big", packages)))
        val row = store.queue().single()
        assertTrue("the payload is only ${row.bytes} bytes", row.bytes > 2 * 1024 * 1024)
        val payload = store.payload(row.id)
        assertNotNull(payload)
        val decoded = lenient.decodeFromString(InventoryRequest.serializer(), payload!!)
        assertEquals(4000, decoded.packages.size)
        assertEquals(payload.encodeToByteArray().size, row.bytes)
    }

    @Test
    fun sentFailedAndDroppedItemsAreMarked() {
        val changes = (1..3).map { change("e$it", ChangeKind.INSTALLED, app("com.example.a$it")) }
        store.commit(step(Baseline(), Baseline(), changes))
        val ids = store.queue().map { it.id }

        store.markFailed(ids.take(1), "HTTP 503", nextAttemptAt = T0 + 60_000)
        assertEquals(1, store.attempts(ids.take(1)))
        assertEquals(T0 + 60_000, store.queue().first().nextAttemptAt)

        store.markSent(ids.take(2), T0)
        store.markDropped(ids[2], "HTTP 400 invalid_request", T0)
        assertTrue(store.queue().isEmpty())
        assertEquals(mapOf(OutboxRow.STATE_SENT to 2, OutboxRow.STATE_DROPPED to 1), store.countsByState())
        assertEquals("HTTP 400 invalid_request", store.eventsFor("com.example.a3").single().lastError)
    }

    @Test
    fun theOutboxKeepsAtMostItsCapOfEvents() {
        val many = (1..OutboxPolicy.MAX_PENDING_EVENTS + 5).map { change("e$it", ChangeKind.UPDATED, app("com.example.a")) }
        store.commit(step(Baseline(), Baseline(), many))
        val queue = store.queue()
        assertEquals(OutboxPolicy.MAX_PENDING_EVENTS, queue.size)
        // The oldest went; the newest stayed, still in order.
        assertEquals(queue.map { it.id }.sorted(), queue.map { it.id })
    }

    @Test
    fun thePhase0FileIsImportedOnceIntoTheLogOnly() {
        val a = app("com.example.a")
        val phase0 = AgentState(
            inventory = mapOf(a.packageName to a),
            lastFullScanAt = T0,
            cursor = ChangeCursor(4, 2),
            changes = listOf(change("old", ChangeKind.INSTALLED, a)),
            heartbeats = listOf(Heartbeat(T0, "phone started")),
        )
        val file = File(dir, AgentStore.PHASE0_FILE)
        file.writeText(Json.encodeToString(AgentState.serializer(), phase0))

        store.importPhase0()

        assertEquals(phase0.baseline, store.loadBaseline())
        assertEquals(listOf("old"), store.recentChanges(10).map { it.id })
        assertEquals(listOf("phone started"), store.recentHeartbeats(10).map { it.trigger })
        assertTrue("Phase 0 changes are never sent", store.queue().isEmpty())
        assertFalse(file.exists())
        store.importPhase0() // nothing left to import
        assertEquals(1, store.recentChanges(10).size)
    }

    private companion object {
        const val T0 = 1_760_000_000_000L
        val lenient = Json { ignoreUnknownKeys = true }
    }
}
