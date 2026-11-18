package family.brooker.belay.core

import family.brooker.belay.core.kid.CaregiverLock
import family.brooker.belay.core.kid.Caregivers
import family.brooker.belay.core.mobiledata.DataUse
import family.brooker.belay.core.mobiledata.DataUseUploads
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The seventh security review's probes on the phone (commit c7063d1), turned to assert what holds
 * now. The steps run through core's own functions, as the app's Agent (each trigger's StepCause),
 * enforce/EnforcementStep.kt, mobiledata/MobileDataStep.kt and service/PauseNotice.kt run them.
 * Made-up names only.
 * - M2: mobile data use is read only at a step neither a time passing nor a call brought
 *   (StepCause.dueReads): a night on a call, with the policy timer stepping every minute while a
 *   lock waits for it, sends the same days at the same steps, counted up to the same times, as a
 *   quiet night (the review's probe, which showed the reads keeping the minute from before the
 *   call where a quiet night's moved to the hourly watchdog's).
 * - M3: today so far is counted up to noon or 6 PM, whenever it's read, so a day is told in at
 *   most three parts, however often the phone steps or anyone asks.
 * - H2: a caregiver's lock names them on the kid's phone, whoever's pause it came with.
 * - J5: a caregiver's name keeps no invisible or format character.
 */
class SeventhReviewTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()
    private val minute = 60_000L
    private val hour = 60 * minute

    /** One agent step: when, and what brought it (the app's Trigger.cause: the watchdog's OTHER, the policy timer's TIME, a call's CALL). */
    private data class Step(val at: Long, val cause: StepCause)

    /**
     * What the phone reads and queues at each of [steps], and so sends then: MobileDataStep runs in
     * every enforcement step, and every step's sync drains the outbox, TIME- and CALL-caused ones too
     * (sync/Sync.kt). Each with the step's time; a range's `to` is the `as_of` that get_mobile_data
     * and the parent page show as "counted until".
     */
    private fun sent(steps: List<Step>, start: DataUseUploads.State): List<Pair<Long, List<DataUse.Range>>> {
        var state = start
        val out = mutableListOf<Pair<Long, List<DataUse.Range>>>()
        for (step in steps.sortedBy { it.at }) {
            val plan = DataUseUploads.plan(measure = true, state = state, zone = ny, now = step.at, cause = step.cause)
            if (plan.read.isNotEmpty()) out += step.at to plan.read
            state = plan.state
        }
        return out
    }

    private val minuteOf = { ms: Long -> Instant.ofEpochMilli(ms).atZone(ny).minute }

    @Test
    fun `M2 - a night on a call sends the same days at the same steps, counted to the same times, as a quiet night`() {
        // Measuring on since the 19th began; today so far went at 6:07 PM, counted up to 6 PM. At 9:40 PM a lock comes
        // due (an AI app's lock_phone, or a bedtime that locks) during a call that goes on all night and into the next
        // afternoon, past noon.
        val start = DataUseUploads.State(since = at("2026-11-19T00:00:00"), lastAt = at("2026-11-19T18:00:00"))
        val callFrom = at("2026-11-19T21:40:00")
        val callTo = at("2026-11-20T12:30:00")
        val until = at("2026-11-20T23:00:00")
        // The hourly watchdog, at its own minute (:07): OTHER.
        val watchdog = generateSequence(at("2026-11-19T22:07:00")) { it + hour }.takeWhile { it < until }.map { Step(it, StepCause.OTHER) }.toList()
        // On the call: the policy timer every minute while the lock waits (ScreenLocks.recheckAt: TIME), through the 2
        // minutes after it, and the call's own start and end (CALL).
        val rechecks = generateSequence(callFrom) { ScreenLocks.recheckAt(waiting = true, now = it) }
            .takeWhile { it < callTo + ScreenLocks.AFTER_CALL_MS }
            .map { Step(it, StepCause.TIME) }
            .toList()
        val call = listOf(Step(callFrom, StepCause.CALL), Step(callTo, StepCause.CALL))
        val quiet = sent(watchdog, start)
        val onCall = sent(watchdog + rechecks + call, start)
        println("M2 quiet: ${quiet.map { minuteOf(it.first) }}; on a call: ${onCall.map { minuteOf(it.first) }}")
        assertEquals(quiet, onCall)
        // What went: the 19th whole once it was over, then the 20th so far at noon and at 6 PM, each at the watchdog's
        // minute, counted up to a time on the hour that says nothing of when it went.
        assertEquals(listOf(at("2026-11-20T03:07:00"), at("2026-11-20T12:07:00"), at("2026-11-20T18:07:00")), quiet.map { it.first })
        assertEquals(
            listOf(
                listOf(DataUse.Range("2026-11-19", ny.id, at("2026-11-19T00:00:00"), at("2026-11-20T00:00:00"), complete = true)),
                listOf(DataUse.Range("2026-11-20", ny.id, at("2026-11-20T00:00:00"), at("2026-11-20T12:00:00"), complete = false)),
                listOf(DataUse.Range("2026-11-20", ny.id, at("2026-11-20T00:00:00"), at("2026-11-20T18:00:00"), complete = false)),
            ),
            quiet.map { it.second },
        )
    }

    @Test
    fun `M3 - however often the phone steps, a day is told up to noon, up to 6 PM, and whole, never by the hour`() {
        // The kid uses the phone all day: screen and app events every 10 minutes (OTHER), and the watchdog.
        val start = DataUseUploads.State(since = at("2026-11-19T00:00:00"), lastAt = at("2026-11-19T00:00:00"))
        val steps = generateSequence(at("2026-11-19T00:03:00")) { it + 10 * minute }.takeWhile { it < at("2026-11-20T04:00:00") }.map { Step(it, StepCause.OTHER) }.toList()
        val ranges = sent(steps, start).flatMap { it.second }.filter { it.day == "2026-11-19" }
        assertEquals(listOf(at("2026-11-19T12:00:00"), at("2026-11-19T18:00:00"), at("2026-11-20T00:00:00")), ranges.map { it.to })
        assertEquals(listOf(false, false, true), ranges.map { it.complete })
        // Each is read at the first step after its time, but counted up to that time: when it went says nothing.
        assertTrue(ranges.all { minuteOf(it.to) == 0 })
    }

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
