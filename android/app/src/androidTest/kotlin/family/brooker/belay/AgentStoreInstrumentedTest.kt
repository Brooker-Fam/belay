package family.brooker.belay

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.AgentState
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Applied
import family.brooker.belay.core.Baseline
import family.brooker.belay.core.ChangeCursor
import family.brooker.belay.core.ChangeKind
import family.brooker.belay.core.CommandLog
import family.brooker.belay.core.Detection
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.InventoryRequest
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.Lock
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.RecoveryState
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.VersionRef
import family.brooker.belay.core.WireAppPolicy
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireHealth
import family.brooker.belay.core.WireNewApps
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRecoveryUse
import family.brooker.belay.core.WireRequest
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.WireUpdateState
import family.brooker.belay.core.location.FixWant
import family.brooker.belay.core.location.LocationState
import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.ToldKind
import family.brooker.belay.core.location.WireFix
import family.brooker.belay.core.location.WireFixReason
import family.brooker.belay.core.location.WireLocationProvider
import family.brooker.belay.core.location.WirePlaceEvent
import family.brooker.belay.core.location.WirePlaceEventKind
import family.brooker.belay.core.screentime.ScreenTime
import family.brooker.belay.core.screentime.ScreenTimeState
import family.brooker.belay.core.screentime.UploadState
import family.brooker.belay.core.screentime.WireUsageApp
import family.brooker.belay.core.screentime.WireUsageDay
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

    // Phase 2.

    @Test
    fun anyOtherPolicyVersionReplacesTheStoredOneUnlessItsRequestCrossedANewerAnswer() {
        assertTrue(store.savePolicy(WirePolicy(version = 3), sentAt = T0, at = T0 + 10))
        assertFalse(store.savePolicy(WirePolicy(version = 3), sentAt = T0 + 20, at = T0 + 30))
        assertFalse("sent before version 3 arrived", store.savePolicy(WirePolicy(version = 2), sentAt = T0 + 5, at = T0 + 40))
        assertEquals(3, store.policy()?.version)
        assertEquals(3, store.policyVersion())
        // A restored backup: a lower version, asked for after version 3 arrived.
        assertTrue(store.savePolicy(WirePolicy(version = 2, apps = WireAppPolicy(WireNewApps.ASK)), sentAt = T0 + 50, at = T0 + 60))
        assertEquals(WireNewApps.ASK, store.policy()?.apps?.newApps)
    }

    @Test
    fun whatBelayAppliedSurvivesAsWritten() {
        val applied = Applied(policyVersion = 4, appliedAt = T0, suspended = setOf("com.example.a"), locks = setOf(Lock.SAFE_BOOT))
        store.commitEnforcement(applied, emptyList(), T0)
        assertEquals(applied, store.applied())
    }

    // Phases 6 and 10.

    @Test
    fun theUpdateTheRecoveryKeyAndCommandsSurviveAsWritten() {
        assertEquals(null, store.agentUpdate())
        assertEquals(RecoveryState(), store.recovery())
        assertEquals(CommandLog(), store.commandLog())

        val update = UpdateRecord("ab".repeat(32), versionCode = 4, versionName = "0.4.0", state = WireUpdateState.INSTALLING, at = T0, installed = true)
        store.saveAgentUpdate(update, T0)
        assertEquals(update, store.agentUpdate())

        val recovery = RecoveryState(wrongTries = 2, lastWrongAt = T0, usedVersions = listOf(1), lastUse = WireRecoveryUse(1, T0, T0 + 1))
        store.saveRecovery(recovery, T0)
        assertEquals(recovery, store.recovery())

        val log = CommandLog().record(listOf(WireCommandResult("command-1", WireCommandOutcome.DONE, T0)))
        store.commitEnforcement(Applied(policyVersion = 5), emptyList(), T0, log)
        assertEquals(log, store.commandLog())
        assertEquals(5, store.applied().policyVersion)
    }

    @Test
    fun aPolicyTooBigToReadIsNotedUntilOneIsRead() {
        assertEquals(null, store.policyTooLarge())
        assertTrue("new", store.notePolicyTooLarge(2_000_000, T0))
        assertFalse("the same answer again isn't news", store.notePolicyTooLarge(2_000_000, T0 + 1))
        assertTrue("a new size is", store.notePolicyTooLarge(null, T0 + 2))
        assertEquals(null, store.policyTooLarge()?.tooLargeBytes)
        assertTrue(store.clearPolicyTooLarge())
        assertFalse(store.clearPolicyTooLarge())
        assertEquals(null, store.policyTooLarge())
    }

    @Test
    fun requestsQueueBehindTheEventsBeforeThemAndAResendReplacesAnUnsentOne() {
        val a = app("com.example.a")
        store.commit(step(Baseline(), Baseline(), listOf(change("e1", ChangeKind.INSTALLED, a))))
        val asked = KidRequest("request-1", a.packageName, a.label, null, T0)
        store.commitEnforcement(Applied(policyVersion = 1), listOf(asked), T0)
        assertEquals(listOf(OutboxRow.TYPE_EVENT, OutboxRow.TYPE_REQUEST), store.queue().map { it.type })

        // The kid writes why before the first send went: only the newer send waits.
        store.commitEnforcement(null, listOf(asked.copy(reason = "For school", revision = 1)), T0 + 1)
        val queued = store.requestsQueuedFor(a.packageName)
        assertEquals(1, queued.size)
        assertEquals("request:request-1:1", queued.single().itemId)
        val wire = lenient.decodeFromString(WireRequest.serializer(), store.requestPayloads(listOf(queued.single().id)).single())
        assertEquals("request-1", wire.id)
        assertEquals("For school", wire.reason)
        assertEquals(listOf("For school"), store.requests().map { it.reason })

        store.markSent(store.queue().map { it.id }, T0 + 2)
        assertTrue(store.queue().isEmpty())
        assertEquals(OutboxRow.STATE_SENT, store.requestsQueuedFor(a.packageName).single().state)
    }

    // Phase 3.

    private fun usageDay(day: String, asOf: Long) = WireUsageDay(
        day = day, zone = "America/New_York", asOf = asOf, complete = false, screenMinutes = 10, unlocks = 2,
        byHour = List(24) { 0 }, apps = listOf(WireUsageApp("com.example.a", 10, 2)),
    )

    @Test
    fun screenTimesLedgerAndStateSurviveAndGoWhenScreenTimeDoes() {
        assertEquals(null, store.screenTime())
        assertFalse(store.hasScreenTime())
        val ledger = ScreenTime.start(T0)
        val state = ScreenTimeState(shown = mapOf("up:l-games:2026-11-17:60" to T0), uploads = UploadState(since = T0))
        store.commitEnforcement(Applied(policyVersion = 1), emptyList(), T0, screenTime = AgentStore.ScreenTimeWrite.Save(ledger, state))
        assertEquals(AgentStore.ScreenTimeStored(ledger, state), store.screenTime())
        assertTrue(store.saveScreenTimeState(state.copy(unmeasuredSince = T0), T0 + 1))
        assertEquals(T0, store.screenTime()?.state?.unmeasuredSince)

        store.commitEnforcement(Applied(policyVersion = 2), emptyList(), T0 + 2, usage = listOf(usageDay("2026-11-17", T0 + 2)))
        store.commitEnforcement(Applied(policyVersion = 2), emptyList(), T0 + 3, screenTime = AgentStore.ScreenTimeWrite.Clear)
        assertEquals(null, store.screenTime())
        assertEquals("unsent usage goes with screen time", 0, store.pendingUsageCount())
        assertFalse(store.saveScreenTimeState(state, T0 + 4))
    }

    @Test
    fun aNewerReportOfADayReplacesAnUnsentOneAndASentDayIsDeleted() {
        store.commitEnforcement(null, emptyList(), T0, usage = listOf(usageDay("2026-11-16", T0), usageDay("2026-11-17", T0)))
        store.commitEnforcement(null, emptyList(), T0 + 1, usage = listOf(usageDay("2026-11-17", T0 + 1)))
        val queue = store.queue()
        assertEquals(listOf(OutboxRow.TYPE_USAGE, OutboxRow.TYPE_USAGE), queue.map { it.type })
        val days = store.usagePayloads(queue.map { it.id }).map { lenient.decodeFromString(WireUsageDay.serializer(), it) }
        assertEquals(listOf("2026-11-16" to T0, "2026-11-17" to T0 + 1), days.map { it.day to it.asOf })

        store.markSent(queue.map { it.id }, T0 + 2)
        assertEquals("sent usage days are deleted, not kept", 0, store.countsByState().values.sum())

        store.commitEnforcement(null, emptyList(), T0 + 3, usage = listOf(usageDay("2026-11-17", T0 + 3)))
        store.commitEnforcement(null, emptyList(), T0 + 4, dropUsage = true)
        assertEquals("the policy stopped measuring", 0, store.pendingUsageCount())
    }

    @Test
    fun atMost31UsageDaysWait() {
        val days = (1..40).map { usageDay("2026-10-${it.toString().padStart(2, '0')}", T0) }
        days.chunked(10).forEachIndexed { i, chunk -> store.commitEnforcement(null, emptyList(), T0 + i, usage = chunk) }
        assertEquals(OutboxPolicy.MAX_PENDING_USAGE, store.pendingUsageCount())
        val kept = store.usagePayloads(store.queue().map { it.id }).map { lenient.decodeFromString(WireUsageDay.serializer(), it).day }
        assertEquals("the newest are kept", days.takeLast(OutboxPolicy.MAX_PENDING_USAGE).map { it.day }, kept)
    }

    // Phase 4 and 7 (schema 5). Made-up coordinates only.

    private fun fix(id: String, at: Long = T0) =
        WireFix(id, at, 40.0, -75.0, 12, WireLocationProvider.GPS, WireFixReason.PERIODIC)

    @Test
    fun locationStateFixesAndPlaceEventsGoTogetherAndASentFixLeavesThePhone() {
        val state = LocationState(wants = listOf(FixWant(WireFixReason.PERIODIC, T0)), problem = "No GPS fix in 60 seconds.")
        val event = WirePlaceEvent("event-1", "p-school", WirePlaceEventKind.ARRIVED, T0, "fix-2")
        store.commitEnforcement(
            null, emptyList(), T0,
            location = AgentStore.LocationWrite(state, fixes = listOf(fix("fix-1"), fix("fix-2")), placeEvents = listOf(event)),
        )
        assertEquals(state, store.locationState())
        val queue = store.queue()
        assertEquals(listOf(OutboxRow.TYPE_FIX, OutboxRow.TYPE_FIX, OutboxRow.TYPE_PLACE_EVENT), queue.map { it.type })
        val (fixes, events) = store.locationPayloads(queue.map { it.id })
        assertEquals(listOf("fix-1", "fix-2"), fixes.map { lenient.decodeFromString(WireFix.serializer(), it).id })
        assertEquals(listOf("event-1"), events.map { lenient.decodeFromString(WirePlaceEvent.serializer(), it).id })
        assertEquals(3, store.pendingLocationCount())

        store.markSent(queue.map { it.id }, T0 + 1)
        assertEquals("sent fixes and place events are deleted, not kept", 0, store.countsByState().values.sum())
    }

    @Test
    fun locationGoingOffDropsUnsentFixesAndTheRow() {
        store.commitEnforcement(null, emptyList(), T0, location = AgentStore.LocationWrite(LocationState(), fixes = listOf(fix("fix-3"))))
        store.commitEnforcement(null, emptyList(), T0 + 1, location = AgentStore.LocationWrite(null, dropUnsent = true))
        assertEquals(null, store.locationState())
        assertEquals(0, store.pendingLocationCount())
    }

    @Test
    fun aDroppedFixKeepsItsReasonButNotWhereThePhoneWas() {
        store.commitEnforcement(null, emptyList(), T0, location = AgentStore.LocationWrite(LocationState(), fixes = listOf(fix("fix-4"))))
        val id = store.queue().single().id
        store.markDropped(id, "HTTP 400 invalid_request", T0 + 1)
        assertEquals(listOf(""), store.locationPayloads(listOf(id)).first)
    }

    @Test
    fun whatBelayToldYourParentKeepsTheNewestLineForEachIdThirtyDays() {
        val day = 24 * 60 * 60 * 1000L
        val first = ToldEntry("lost:1", ToldKind.LOST, T0, sent = true, count = 1, lastAt = T0)
        store.commitEnforcement(null, emptyList(), T0, location = AgentStore.LocationWrite(LocationState(), told = listOf(first)))
        store.commitEnforcement(null, emptyList(), T0 + 1, location = AgentStore.LocationWrite(LocationState(), told = listOf(first.copy(count = 2, lastAt = T0 + 300_000))))
        assertEquals(listOf(2), store.told().map { it.count })
        store.commitEnforcement(null, emptyList(), T0 + 31 * day, location = AgentStore.LocationWrite(LocationState(), told = listOf(ToldEntry("command-1", ToldKind.CHECK, T0 + 31 * day, "Claude", sent = true))))
        assertEquals("older than 30 days goes", listOf("command-1"), store.told().map { it.id })
    }

    @Test
    fun aWithdrawnRequestIsSentAgainWithWithdrawnAt() {
        val talk = KidRequest("request-talk", "", "", "Can we talk about bedtime?", T0, kind = WireRequestKind.TALK)
        store.commitEnforcement(null, listOf(talk), T0)
        store.commitEnforcement(null, listOf(talk.copy(withdrawnAt = T0 + 1, revision = 1)), T0 + 1)
        val sends = store.requestsQueuedFor("").map { lenient.decodeFromString(WireRequest.serializer(), it.payload) }
        assertEquals("the unsent first send was replaced", listOf(T0 + 1), sends.map { it.withdrawnAt })
        assertEquals(T0 + 1, store.requests().single().withdrawnAt)
    }

    private companion object {
        const val T0 = 1_760_000_000_000L
        val lenient = Json { ignoreUnknownKeys = true }
    }
}
