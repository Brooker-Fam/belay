package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.Fixtures.inventory
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ReconcileTest {
    private val base = inventory(app("com.example.a"), app("com.android.settings", system = true))

    private fun scanned(at: Long = T0, boot: Int = 7, seq: Int = 3) =
        Reconcile.fullScan(AgentState(), base, ChangeCursor(boot, seq), at, ids()).state

    @Test
    fun `first ever scan is a full scan`() {
        assertEquals(ScanPlan.Full("first scan"), Reconcile.plan(AgentState(), bootCount = 7, now = T0))
    }

    @Test
    fun `same boot within a day is incremental from the stored sequence`() {
        val plan = Reconcile.plan(scanned(seq = 3), bootCount = 7, now = T0 + HOUR)
        assertEquals(ScanPlan.Incremental(3), plan)
    }

    @Test
    fun `a new boot count means the sequence restarted, so scan everything`() {
        assertEquals(ScanPlan.Full("phone restarted"), Reconcile.plan(scanned(boot = 7), bootCount = 8, now = T0 + HOUR))
    }

    @Test
    fun `no boot count means no way to trust the sequence`() {
        assertIs<ScanPlan.Full>(Reconcile.plan(scanned(), bootCount = null, now = T0 + HOUR))
    }

    @Test
    fun `a day after the last full scan, scan everything again`() {
        assertEquals(ScanPlan.Full("daily scan"), Reconcile.plan(scanned(at = T0), bootCount = 7, now = T0 + 24 * HOUR))
    }

    @Test
    fun `a clock that went backwards triggers a full scan`() {
        assertIs<ScanPlan.Full>(Reconcile.plan(scanned(at = T0), bootCount = 7, now = T0 - HOUR))
    }

    @Test
    fun `first full scan is a baseline without events`() {
        val result = Reconcile.fullScan(AgentState(), base, ChangeCursor(7, 0), T0, ids())
        assertTrue(result.changes.isEmpty())
        assertEquals(base, result.state.inventory)
        assertEquals(T0, result.state.lastFullScanAt)
    }

    @Test
    fun `later full scans report differences as found by snapshot`() {
        val later = inventory(app("com.example.a", code = 2), app("com.android.settings", system = true), app("com.example.new"))
        val result = Reconcile.fullScan(scanned(), later, ChangeCursor(8, 0), T0 + HOUR, ids())
        assertEquals(
            listOf("com.example.a" to ChangeKind.UPDATED, "com.example.new" to ChangeKind.INSTALLED),
            result.changes.map { it.packageName to it.kind },
        )
        assertTrue(result.changes.all { it.detection == Detection.SNAPSHOT })
        assertEquals(ChangeCursor(8, 0), result.state.cursor)
    }

    @Test
    fun `running the same scan twice reports nothing the second time`() {
        val later = inventory(app("com.example.new"))
        val once = Reconcile.fullScan(scanned(), later, ChangeCursor(7, 4), T0 + HOUR, ids())
        val twice = Reconcile.fullScan(once.state, later, ChangeCursor(7, 4), T0 + 2 * HOUR, ids())
        assertTrue(twice.changes.isEmpty())
        assertEquals(once.state.changes, twice.state.changes)
    }

    @Test
    fun `scoped scan credits each change to the layer that pointed at it`() {
        val state = scanned()
        val read = inventory(app("com.example.game"), app("com.example.a", code = 5))
        val result = Reconcile.scopedScan(
            state,
            scope = mapOf(
                "com.example.game" to Detection.BROADCAST,
                "com.example.a" to Detection.CHANGED_PACKAGES,
            ),
            current = read,
            cursor = ChangeCursor(7, 9),
            now = T0 + HOUR,
            newId = ids(),
        )
        assertEquals(
            listOf(
                Triple("com.example.a", ChangeKind.UPDATED, Detection.CHANGED_PACKAGES),
                Triple("com.example.game", ChangeKind.INSTALLED, Detection.BROADCAST),
            ),
            result.changes.map { Triple(it.packageName, it.kind, it.detection) },
        )
        // The system app outside the scope is untouched.
        assertEquals(setOf("com.example.a", "com.example.game", "com.android.settings"), result.state.inventory.keys)
        assertEquals(ChangeCursor(7, 9), result.state.cursor)
    }

    @Test
    fun `scoped scan of a removed package removes it`() {
        val result = Reconcile.scopedScan(
            scanned(), mapOf("com.example.a" to Detection.BROADCAST), inventory(), null, T0 + HOUR, ids(),
        )
        assertEquals(ChangeKind.REMOVED, result.changes.single().kind)
        assertEquals(ChangeCursor(7, 3), result.state.cursor, "a null cursor keeps the stored one")
        assertTrue("com.example.a" !in result.state.inventory)
    }

    @Test
    fun `the change log keeps only the newest entries`() {
        var state = scanned()
        repeat(Reconcile.MAX_CHANGES + 20) { i ->
            val read = inventory(app("com.example.a", code = (i + 2).toLong()))
            state = Reconcile.scopedScan(state, mapOf("com.example.a" to Detection.BROADCAST), read, null, T0 + i, ids()).state
        }
        assertEquals(Reconcile.MAX_CHANGES, state.changes.size)
        assertEquals((Reconcile.MAX_CHANGES + 21).toLong(), state.changes.last().to?.code)
    }

    @Test
    fun `heartbeats are capped`() {
        var state = AgentState()
        repeat(Reconcile.MAX_HEARTBEATS + 5) { state = Reconcile.withHeartbeat(state, Heartbeat(T0 + it, "test")) }
        assertEquals(Reconcile.MAX_HEARTBEATS, state.heartbeats.size)
        assertEquals(T0 + Reconcile.MAX_HEARTBEATS + 4, state.heartbeats.last().at)
    }

    @Test
    fun `state survives a JSON round trip`() {
        val json = Json { ignoreUnknownKeys = true }
        val state = Reconcile.withHeartbeat(scanned(), Heartbeat(T0, "boot", "full scan"))
        val decoded = json.decodeFromString(AgentState.serializer(), json.encodeToString(AgentState.serializer(), state))
        assertEquals(state, decoded)
    }
}
