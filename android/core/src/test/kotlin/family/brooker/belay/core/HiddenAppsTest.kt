package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.Fixtures.inventory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A blocked app is hidden (setApplicationHidden), which makes it look uninstalled to
 * PackageManager and sends PACKAGE_REMOVED; showing it again sends PACKAGE_ADDED. Belay must
 * keep it present and blocked: no "removed" or "installed" event, still in every snapshot.
 */
class HiddenAppsTest {
    private val chat = app("com.example.chat", label = "Chatter Box")
    private val notes = app("com.example.notes")

    /** ApplicationInfo flags as a MATCH_UNINSTALLED_PACKAGES read returns them. */
    private val installedVisible = PackagePresence.FLAG_INSTALLED or 0x1 // FLAG_SYSTEM-like bits don't matter
    private val installedHidden = PackagePresence.FLAG_INSTALLED // hidden is a private flag: FLAG_INSTALLED stays
    private val dataLeftBehind = 0x1 // uninstalled with DELETE_KEEP_DATA: FLAG_INSTALLED is cleared

    @Test
    fun `the reader counts a hidden app as installed, and leftover data as not`() {
        assertTrue(PackagePresence.installed(installedVisible))
        assertTrue(PackagePresence.installed(installedHidden))
        assertFalse(PackagePresence.installed(dataLeftBehind))
    }

    private fun baseline() = Reconcile.fullScan(Baseline(), inventory(chat, notes), ChangeCursor(1, 0), T0, ids()).baseline

    @Test
    fun `hiding a blocked app and its PACKAGE_REMOVED broadcast record no removal`() {
        // The reader still returns the hidden app (MATCH_UNINSTALLED_PACKAGES, FLAG_INSTALLED).
        val result = Reconcile.scopedScan(
            baseline(), mapOf(chat.packageName to Detection.BROADCAST), inventory(chat), ChangeCursor(1, 1), T0 + HOUR, ids(),
        )
        assertTrue(result.changes.isEmpty())
        assertEquals(chat, result.baseline.inventory[chat.packageName])
    }

    @Test
    fun `showing it again and its PACKAGE_ADDED broadcast record no install`() {
        val hidden = Reconcile.scopedScan(
            baseline(), mapOf(chat.packageName to Detection.BROADCAST), inventory(chat), ChangeCursor(1, 1), T0 + HOUR, ids(),
        ).baseline
        val shown = Reconcile.scopedScan(
            hidden, mapOf(chat.packageName to Detection.BROADCAST), inventory(chat), ChangeCursor(1, 2), T0 + 2 * HOUR, ids(),
        )
        assertTrue(shown.changes.isEmpty())
    }

    @Test
    fun `a hidden app stays in the full scan the snapshot is made from`() {
        val scan = Reconcile.fullScan(baseline(), inventory(chat, notes), ChangeCursor(2, 0), T0 + 25 * HOUR, ids())
        assertTrue(scan.changes.isEmpty())
        assertTrue(chat.packageName in scan.baseline.inventory)
    }

    @Test
    fun `a hidden app that is really uninstalled is removed`() {
        // Uninstalled, its data gone: the reader no longer returns it at all.
        val result = Reconcile.scopedScan(
            baseline(), mapOf(chat.packageName to Detection.BROADCAST), emptyMap(), ChangeCursor(1, 1), T0 + HOUR, ids(),
        )
        assertEquals(listOf(ChangeKind.REMOVED), result.changes.map { it.kind })
    }

    @Test
    fun `a hidden app stays blocked, and Belay keeps holding it`() {
        val policy = WirePolicy(
            version = 3,
            apps = WireAppPolicy(WireNewApps.ASK, listOf(WireAppDecision(chat.packageName, WireAppState.BLOCKED), WireAppDecision(notes.packageName, WireAppState.ALLOWED))),
        )
        val roles = PhoneRoles(self = "family.example.belay")
        val first = Enforcement.plan(Enforcement.Input(policy, inventory(chat, notes), roles, Applied(), false, Enforcement.sdkFull(37), T0))
        val applied = Enforcement.after(Applied(), first, Enforcement.changes(first, Applied()), ApplyOutcome(), T0)
        // Hidden, its launcher icon may not show in a read: it is still blocked, not "waiting".
        val hiddenRead = inventory(chat.copy(launchable = false), notes)
        val again = Enforcement.plan(Enforcement.Input(policy, hiddenRead, roles, applied, false, Enforcement.sdkFull(37), T0 + HOUR))
        assertEquals(listOf(chat.packageName), again.blocked)
        assertTrue(again.waiting.isEmpty())
        assertTrue(Enforcement.changes(again, applied).none)
        assertEquals(1, Enforcement.report(applied)?.suspendedCount)
    }
}
