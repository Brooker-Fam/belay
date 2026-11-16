package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.Fixtures.inventory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class InventoryDiffTest {
    private val now = T0 + 10 * HOUR
    private val snapshot: (String) -> Detection = { Detection.SNAPSHOT }

    private fun diff(
        before: Map<String, PackageRecord>,
        after: Map<String, PackageRecord>,
        scope: Set<String>? = null,
    ) = InventoryDiff.diff(before, after, scope, now, snapshot, ids())

    @Test
    fun `new package is installed, dated by its first install time`() {
        val changes = diff(inventory(), inventory(app("com.example.drawing", installed = T0 + HOUR)))
        val c = changes.single()
        assertEquals(ChangeKind.INSTALLED, c.kind)
        assertEquals("com.example.drawing", c.packageName)
        assertEquals(T0 + HOUR, c.happenedAt)
        assertEquals(now, c.detectedAt)
        assertEquals(VersionRef("1.0", 1), c.to)
        assertNull(c.from)
    }

    @Test
    fun `missing package is removed, with no happened time`() {
        val c = diff(inventory(app("com.example.drawing")), inventory()).single()
        assertEquals(ChangeKind.REMOVED, c.kind)
        assertNull(c.happenedAt)
        assertEquals(VersionRef("1.0", 1), c.from)
    }

    @Test
    fun `new version code is an update from one version to the other`() {
        val before = inventory(app("com.example.maps", code = 10, versionName = "1.0"))
        val after = inventory(app("com.example.maps", code = 11, versionName = "1.1", updated = T0 + 2 * HOUR))
        val c = diff(before, after).single()
        assertEquals(ChangeKind.UPDATED, c.kind)
        assertEquals(VersionRef("1.0", 10), c.from)
        assertEquals(VersionRef("1.1", 11), c.to)
        assertEquals(T0 + 2 * HOUR, c.happenedAt)
    }

    @Test
    fun `same version reinstalled over itself is an update`() {
        val before = inventory(app("com.example.maps"))
        val after = inventory(app("com.example.maps", updated = T0 + HOUR))
        assertEquals(ChangeKind.UPDATED, diff(before, after).single().kind)
    }

    @Test
    fun `new first install time means removed and installed again`() {
        val before = inventory(app("com.example.chat", installed = T0))
        val after = inventory(app("com.example.chat", installed = T0 + 3 * HOUR))
        val c = diff(before, after).single()
        assertEquals(ChangeKind.REINSTALLED, c.kind)
        assertEquals(T0 + 3 * HOUR, c.happenedAt)
    }

    @Test
    fun `identical inventories give no changes`() {
        val inv = inventory(app("com.example.a"), app("com.example.b", system = true))
        assertTrue(diff(inv, inv).isEmpty())
    }

    @Test
    fun `label or enabled changes alone are not app changes`() {
        val before = inventory(app("com.example.a", label = "Old name"))
        val after = inventory(app("com.example.a", label = "New name").copy(enabled = false))
        assertTrue(diff(before, after).isEmpty())
    }

    @Test
    fun `scoped diff only looks at the scope`() {
        val before = inventory(app("com.example.a"), app("com.example.b"))
        // b is absent from the scoped read because it was not asked for, not because it's gone.
        val after = inventory(app("com.example.a", code = 2))
        val changes = diff(before, after, scope = setOf("com.example.a"))
        assertEquals(listOf("com.example.a" to ChangeKind.UPDATED), changes.map { it.packageName to it.kind })
    }

    @Test
    fun `changes come out sorted by package, with fresh ids`() {
        val after = inventory(app("com.example.z"), app("com.example.a"), app("com.example.m"))
        val changes = diff(inventory(), after)
        assertEquals(listOf("com.example.a", "com.example.m", "com.example.z"), changes.map { it.packageName })
        assertEquals(listOf("id-1", "id-2", "id-3"), changes.map { it.id })
    }

    @Test
    fun `merge replaces and removes only scoped packages`() {
        val before = inventory(app("com.example.a"), app("com.example.b"), app("com.example.c"))
        val read = inventory(app("com.example.a", code = 2))
        val merged = InventoryDiff.merge(before, read, setOf("com.example.a", "com.example.c"))
        assertEquals(setOf("com.example.a", "com.example.b"), merged.keys)
        assertEquals(2, merged.getValue("com.example.a").versionCode)
    }

    @Test
    fun `merge without scope is the new inventory`() {
        val read = inventory(app("com.example.x"))
        assertEquals(read, InventoryDiff.merge(inventory(app("com.example.a")), read, null))
    }
}
