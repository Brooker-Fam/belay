package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.inventory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Phase 11's hand-over on the phone (docs/protocol.md, "Off belay"): while the policy has
 * `handover`, Belay holds no factory-reset, debugging or accounts lock and no reset protection,
 * whatever the restrictions say; a release build clears reset protection once per hand-over, even
 * without a record of setting it, and tries again after a failure; a debug build leaves it alone
 * and records that. Made-up apps and account ids only.
 */
class HandoverTest {
    private val belay = app("family.example.belay", label = "Belay")
    private val apps = inventory(belay, app("com.example.game"))
    private val roles = PhoneRoles(self = belay.packageName)
    private val locked = WireRestrictions(safeBoot = true, modifyAccounts = true, factoryReset = true, debugging = true)
    private val hardened = WirePolicy(version = 4, restrictions = locked, frpAccounts = listOf("112233445566778899000"))
    private val handover = WireHandover(at = T0, by = "Sam")

    private fun plan(policy: WirePolicy, applied: Applied = Applied(), debugBuild: Boolean = false, now: Long = T0) =
        Enforcement.plan(Enforcement.Input(policy, apps, roles, applied, debugBuild, Enforcement.sdkFull(37), now))

    /** One step: plan, the changes, Android's outcome, and what Belay then holds. */
    private fun step(policy: WirePolicy, applied: Applied, debugBuild: Boolean = false, outcome: ApplyOutcome = ApplyOutcome(), now: Long = T0): Pair<EnforcementChanges, Applied> {
        val plan = plan(policy, applied, debugBuild, now)
        val changes = Enforcement.changes(plan, applied)
        return changes to Enforcement.after(applied, plan, changes, outcome, now)
    }

    /** What a release build holds for the hardened policy, before the hand-over. */
    private fun before(): Applied = step(hardened, Applied()).second

    @Test
    fun `the hand-over's locks and reset protection go, whatever the restrictions still say`() {
        val held = before()
        assertEquals(setOf(Lock.SAFE_BOOT, Lock.MODIFY_ACCOUNTS, Lock.FACTORY_RESET, Lock.DEBUGGING), held.locks)
        assertEquals(listOf("112233445566778899000"), held.frpAccounts)
        // A server that still sent them (it doesn't): the hand-over wins.
        val plan = plan(hardened.copy(version = 5, handover = handover), held)
        assertEquals(setOf(Lock.SAFE_BOOT), plan.locks)
        assertNull(plan.frpAccounts)
        assertEquals(HandoverPlan(at = T0, clearFrp = true), plan.handover)
        val changes = Enforcement.changes(plan, held)
        assertEquals(setOf(Lock.MODIFY_ACCOUNTS, Lock.FACTORY_RESET, Lock.DEBUGGING), changes.unlock)
        assertEquals(Setting.Clear, changes.frpAccounts)
    }

    @Test
    fun `the hand-over takes Play's accounts back, so Play may use the kid's own account, debug build or not`() {
        for (debug in listOf(false, true)) {
            val held = step(hardened.copy(playAccounts = listOf("parent@gmail.com")), Applied(), debugBuild = debug).second
            assertEquals(listOf("parent@gmail.com"), held.playAccounts)
            // A server that still sent them (it doesn't): the hand-over wins.
            val (changes, after) = step(hardened.copy(version = 5, playAccounts = listOf("parent@gmail.com"), handover = handover), held, debugBuild = debug)
            assertEquals(Setting.Clear, changes.playAccounts)
            assertNull(after.playAccounts)
            // And they aren't set again while it lasts.
            assertNull(step(hardened.copy(version = 6, playAccounts = listOf("parent@gmail.com"), handover = handover), after, debugBuild = debug).first.playAccounts)
        }
    }

    @Test
    fun `a release build clears reset protection once per hand-over, even with no record of setting it`() {
        val policy = WirePolicy(version = 5, handover = handover)
        // Belay has no record of a reset protection policy (it never set one, or lost its record).
        val (first, done) = step(policy, Applied(), now = T0 + HOUR)
        assertEquals(Setting.Clear, first.frpAccounts)
        assertEquals(HandoverDone(at = T0, doneAt = T0 + HOUR, frp = HandoverFrp.CLEARED), done.handover)
        // The next steps leave it: done once.
        val (again, still) = step(policy, done, now = T0 + 2 * HOUR)
        assertNull(again.frpAccounts)
        assertTrue(again.none)
        assertEquals(done.handover, still.handover)
        // A new hand-over (after one was taken back) clears it again.
        val (newer, _) = step(policy.copy(version = 7, handover = WireHandover(at = T0 + 3 * HOUR)), still)
        assertEquals(Setting.Clear, newer.frpAccounts)
    }

    @Test
    fun `a failed clear is tried again at the next step`() {
        val policy = hardened.copy(version = 5, handover = handover)
        val (changes, failed) = step(policy, before(), outcome = ApplyOutcome(frpFailed = true, problems = listOf("Couldn't clear factory reset protection: SecurityException.")))
        assertEquals(Setting.Clear, changes.frpAccounts)
        assertNull(failed.handover)
        // Belay still holds what it couldn't take back.
        assertEquals(listOf("112233445566778899000"), failed.frpAccounts)
        val (retry, done) = step(policy, failed)
        assertEquals(Setting.Clear, retry.frpAccounts)
        assertEquals(HandoverFrp.CLEARED, done.handover?.frp)
        assertNull(done.frpAccounts)
    }

    @Test
    fun `a debug build never touches reset protection, and records that it left it alone`() {
        val policy = WirePolicy(version = 5, restrictions = locked, frpAccounts = listOf("112233445566778899000"), handover = handover)
        val plan = plan(policy, debugBuild = true)
        assertEquals(HandoverPlan(at = T0, clearFrp = false), plan.handover)
        assertNull(plan.frpAccounts)
        // No "test build" problems: there's nothing it was asked to lock or set.
        assertFalse(plan.problems.any { "test build" in it }, plan.problems.toString())
        val (changes, done) = step(policy, Applied(), debugBuild = true)
        assertNull(changes.frpAccounts)
        assertEquals(HandoverDone(at = T0, doneAt = T0, frp = HandoverFrp.SKIPPED_DEBUG), done.handover)
        assertFalse(done.locks.any { it in HandoverPlan.LIFTS })
    }

    @Test
    fun `taken back, the record goes, and the locks come back only when the policy says so`() {
        val (_, done) = step(WirePolicy(version = 5, handover = handover), before())
        assertEquals(HandoverFrp.CLEARED, done.handover?.frp)
        val (changes, after) = step(WirePolicy(version = 6), done)
        assertNull(after.handover)
        assertTrue(changes.lock.isEmpty())
        assertNull(changes.frpAccounts)
        // A parent locks them again on the parent page: an ordinary policy.
        val (relock, _) = step(hardened.copy(version = 7), after)
        assertEquals(setOf(Lock.SAFE_BOOT, Lock.MODIFY_ACCOUNTS, Lock.FACTORY_RESET, Lock.DEBUGGING), relock.lock)
        assertTrue(relock.frpAccounts is Setting.Set)
    }

    @Test
    fun `the server's policy carries the hand-over and Off belay`() {
        val policy = Wire.json.decodeFromString(
            WirePolicy.serializer(),
            """{"version":9,"handover":{"at":$T0,"by":"Sam"},"off_belay":{"how":"When you turn 16","position":"next"},"some_later_field":true}""",
        )
        assertEquals(WireHandover(at = T0, by = "Sam"), policy.handover)
        assertEquals(WireOffBelay(how = "When you turn 16", position = WireOffBelayPosition.NEXT), policy.offBelay)
        val older = Wire.json.decodeFromString(WirePolicy.serializer(), """{"version":9,"handover":null}""")
        assertNull(older.handover)
        assertNull(older.offBelay)
    }
}
