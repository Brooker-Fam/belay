package family.brooker.belay.core

import family.brooker.belay.core.kid.CaregiverLock
import family.brooker.belay.core.kid.Caregivers
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The seventh security review's probes on the phone (commit c7063d1), turned to assert what holds
 * now. The steps run through core's own functions, as the app's enforce/EnforcementStep.kt and
 * service/PauseNotice.kt run them. Made-up names only.
 * - H2: a caregiver's lock names them on the kid's phone, whoever's pause it came with.
 * - J5: a caregiver's name keeps no invisible or format character.
 */
class SeventhReviewTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()
    private val minute = 60_000L

    // ── H2: a caregiver's lock names them on the kid's phone ───────────────────────────────

    private val now = at("2026-11-19T20:15:00")
    private val grandma = WireCommand("c-1", WireCommand.LOCK_NOW, issuedAt = now, expiresAt = now + 10 * minute, caregiver = "Grandma")

    @Test
    fun `H2 - under a parent's longer pause the pause stays the parent's, and Grandma's lock names her`() {
        // A parent paused the phone until they resume it; Grandma's "Pause and lock the screen now" kept that pause.
        val policy = WirePolicy(version = 7, pause = WirePause(until = null, note = null), commands = listOf(grandma))
        assertNull(Caregivers.who(policy.pause?.caregiver), "the pause reads \"Paused by your parent\"")
        val plan = Commands.plan(policy.commands, emptySet(), now, setOf(WireCommand.LOCK_NOW, WireCommand.LOCATE_NOW, WireCommand.REMOVE_OTHER_USERS))
        // No call on: the screen locks now, and the command is done.
        val step = ScreenLocks.lockNow(plan, due = null, bootCount = 3, bootAt = 0, cannotLock = null) { false }
        assertTrue(step.lock)
        val results = step.report.map { CommandLog.done(it, now) }
        assertEquals(listOf(CaregiverLock("c-1", "Grandma", now, afterCall = false)), Caregivers.locks(plan.lockNow, results, waits = step.due != null))
        // During a call it's done at once and the screen locks after the call: the notice says so.
        val during = ScreenLocks.lockNow(plan, due = null, bootCount = 3, bootAt = 0, cannotLock = null) { true }
        val waiting = during.report.map { CommandLog.done(it, now) }
        assertEquals(listOf(CaregiverLock("c-1", "Grandma", now, afterCall = true)), Caregivers.locks(plan.lockNow, waiting, waits = during.due != null))
    }

    @Test
    fun `H2 - a parent's or an AI app's lock names no one, and neither does a lock that failed or a check`() {
        val parent = WireCommand("c-2", WireCommand.LOCK_NOW, issuedAt = now, expiresAt = now + 10 * minute)
        val ai = WireCommand("c-3", WireCommand.LOCK_NOW, issuedAt = now, expiresAt = now + 10 * minute, via = "Claude")
        val check = WireCommand("c-4", WireCommand.LOCATE_NOW, issuedAt = now, expiresAt = now + 2 * minute, caregiver = "Grandma")
        val commands = listOf(grandma, parent, ai, check)
        assertEquals(listOf("c-1"), Caregivers.locks(commands, commands.map { CommandLog.done(it, now) }, waits = false).map { it.commandId })
        // Belay couldn't lock (not the device owner, or Android needs a restart first): it locked nothing.
        assertEquals(emptyList(), Caregivers.locks(listOf(grandma), listOf(CommandLog.failed(grandma, now, "Belay isn't the device owner.")), waits = false))
        // Not reported at this step: nothing.
        assertEquals(emptyList(), Caregivers.locks(listOf(grandma), emptyList(), waits = false))
        // A name with nothing left once cleaned still names a caregiver, never "your parent".
        val blank = grandma.copy(id = "c-5", caregiver = "\u200b")
        assertEquals(listOf(Caregivers.UNNAMED), Caregivers.locks(listOf(blank), listOf(CommandLog.done(blank, now)), waits = false).map { it.by })
    }

    // ── J5: a caregiver's name, cleaned again on the phone ────────────────────────────────

    @Test
    fun `J5 - every invisible and format character goes from a caregiver's name, and every run of spaces is one`() {
        assertEquals("Grandma", Caregivers.name("Grand\u2060ma"), "a word joiner")
        assertEquals("Coach Lee", Caregivers.name("Coach Lee\u061c"), "an Arabic letter mark")
        assertEquals("Coach Lee", Caregivers.name("Coach\u2028Lee"), "a line separator")
        assertEquals("Aunt Robin", Caregivers.name("Aunt\u00a0\u2003 Robin\u2029"), "no-break and em spaces, a paragraph separator")
        assertEquals("Grandma", Caregivers.name("\ufeffGran\u202ed\u200bma\u00ad"), "a byte-order mark, an override, a zero-width space, a soft hyphen")
        assertEquals("Nana", Caregivers.name("Na\u200dna\uDB40\uDC41"), "a zero-width joiner, and a tag character")
        assertEquals("Grandma", Caregivers.who("Grand\u2060ma"))
    }
}
