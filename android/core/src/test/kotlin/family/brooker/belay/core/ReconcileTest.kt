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
        Reconcile.fullScan(Baseline(), base, ChangeCursor(boot, seq), at, ids()).baseline

    @Test
    fun `first ever scan is a full scan`() {
        assertEquals(ScanPlan.Full("first scan"), Reconcile.plan(Baseline(), bootCount = 7, now = T0))
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
    fun `a wanted full scan happens even when the cursor is fine`() {
        assertEquals(
            ScanPlan.Full("enrolled"),
            Reconcile.plan(scanned(), bootCount = 7, now = T0 + HOUR, fullScanWanted = "enrolled"),
        )
        // The very first scan is still a baseline, whatever the reason.
        assertEquals(ScanPlan.Full("first scan"), Reconcile.plan(Baseline(), 7, T0, fullScanWanted = "enrolled"))
    }

    @Test
    fun `first full scan is a baseline without events`() {
        val result = Reconcile.fullScan(Baseline(), base, ChangeCursor(7, 0), T0, ids())
        assertTrue(result.changes.isEmpty())
        assertEquals(base, result.baseline.inventory)
        assertEquals(T0, result.baseline.lastFullScanAt)
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
        assertEquals(ChangeCursor(8, 0), result.baseline.cursor)
        assertEquals(T0 + HOUR, result.baseline.lastFullScanAt)
    }

    @Test
    fun `running the same scan twice reports nothing the second time`() {
        val later = inventory(app("com.example.new"))
        val once = Reconcile.fullScan(scanned(), later, ChangeCursor(7, 4), T0 + HOUR, ids())
        val twice = Reconcile.fullScan(once.baseline, later, ChangeCursor(7, 4), T0 + 2 * HOUR, ids())
        assertTrue(twice.changes.isEmpty())
        assertEquals(once.baseline.inventory, twice.baseline.inventory)
    }

    @Test
    fun `a permission change alone is no app change, but the baseline keeps it`() {
        val granted = inventory(
            app("com.example.a").copy(permissions = listOf(SensitivePermissions.CAMERA)),
            app("com.android.settings", system = true),
        )
        val result = Reconcile.fullScan(scanned(), granted, ChangeCursor(7, 4), T0 + HOUR, ids())
        assertTrue(result.changes.isEmpty())
        assertEquals(listOf("camera"), result.baseline.inventory.getValue("com.example.a").permissions)
    }

    @Test
    fun `scoped scan credits each change to the layer that pointed at it`() {
        val baseline = scanned()
        val read = inventory(app("com.example.game"), app("com.example.a", code = 5))
        val result = Reconcile.scopedScan(
            baseline,
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
        assertEquals(setOf("com.example.a", "com.example.game", "com.android.settings"), result.baseline.inventory.keys)
        assertEquals(ChangeCursor(7, 9), result.baseline.cursor)
        assertEquals(baseline.lastFullScanAt, result.baseline.lastFullScanAt, "a scoped scan isn't a full one")
    }

    @Test
    fun `scoped scan of a removed package removes it`() {
        val result = Reconcile.scopedScan(
            scanned(), mapOf("com.example.a" to Detection.BROADCAST), inventory(), null, T0 + HOUR, ids(),
        )
        assertEquals(ChangeKind.REMOVED, result.changes.single().kind)
        assertEquals(ChangeCursor(7, 3), result.baseline.cursor, "a null cursor keeps the stored one")
        assertTrue("com.example.a" !in result.baseline.inventory)
    }

    @Test
    fun `the Phase 0 state file still parses, and gives its baseline`() {
        val json = Json { ignoreUnknownKeys = true }
        val phase0 = AgentState(
            inventory = base,
            lastFullScanAt = T0,
            cursor = ChangeCursor(7, 3),
            heartbeats = listOf(Heartbeat(T0, "phone started", "full scan")),
        )
        val decoded = json.decodeFromString(AgentState.serializer(), json.encodeToString(AgentState.serializer(), phase0))
        assertEquals(phase0, decoded)
        assertEquals(Baseline(base, T0, ChangeCursor(7, 3)), decoded.baseline)
        // A Phase 0 file written before `permissions` existed reads with none.
        val old = """{"inventory":{"com.example.a":{"packageName":"com.example.a","label":"A","versionCode":1,""" +
            """"firstInstallTime":1,"lastUpdateTime":1,"system":false}},"lastFullScanAt":1}"""
        assertEquals(emptyList(), json.decodeFromString(AgentState.serializer(), old).inventory.getValue("com.example.a").permissions)
    }
}
