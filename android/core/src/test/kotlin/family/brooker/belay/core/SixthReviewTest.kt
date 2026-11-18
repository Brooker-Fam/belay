package family.brooker.belay.core

import family.brooker.belay.core.calls.AfterRestart
import family.brooker.belay.core.calls.AndroidLogCall
import family.brooker.belay.core.calls.CallEntry
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallsNow
import family.brooker.belay.core.calls.CallsPlan
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.PhoneNumbers
import family.brooker.belay.core.calls.WireCallAction
import family.brooker.belay.core.calls.WireCallDirection
import family.brooker.belay.core.calls.WireCallMode
import family.brooker.belay.core.calls.WireCallOutcome
import family.brooker.belay.core.calls.WireCalls
import family.brooker.belay.core.calls.WireContact
import family.brooker.belay.core.calls.WireOutgoing
import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.ScreenTimeState
import family.brooker.belay.core.screentime.Upkeep
import family.brooker.belay.core.screentime.WireDay
import family.brooker.belay.core.screentime.WireSchedule
import family.brooker.belay.core.screentime.WireScheduleKind
import family.brooker.belay.core.screentime.WireScreenTime
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The sixth security review's probes on the phone (commit 4528f67), turned to assert what holds
 * now: the fixes (G1, G2, G3, I1), and what the review found sound. The steps run through core's
 * own functions, as the app's calls/CallsStep.kt, enforce/CommandRunner.kt and sync/Sync.kt run
 * them. Made-up 555-01xx numbers only; nothing dials anything.
 */
class SixthReviewTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()
    private val minute = 60_000L
    private val hour = 60 * minute

    // ── G1: every 911 call before the first unlock keeps its own window ─────────────────

    private val us = object : EmergencyNumbers {
        override fun isEmergency(number: String) = number in setOf("911", "112")
        override fun e164(number: String): String? {
            PhoneNumbers.e164(number)?.let { return it }
            if (!number.all(Char::isDigit)) return null
            return when {
                number.length == 10 -> "+1$number"
                number.length == 11 && number.startsWith("1") -> "+$number"
                else -> null
            }
        }
    }
    private val sam = WireContact("c-sam", "Sam", listOf("+15555550123"), calls = true)
    private val strict = WireCalls(
        mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT,
        outgoing = WireOutgoing.CONTACTS, quiet = true, log = true,
    )
    private val rules = CallsNow(calls = strict, contacts = listOf(sam), now = 0)
    private var ids = 0

    private fun incoming(number: String, at: Long, durationS: Int = 600) =
        AndroidLogCall(number, at, WireCallDirection.IN, durationS, outcome = WireCallOutcome.ANSWERED)

    /**
     * The first agent step after the unlock, as calls/CallsStep.kt runs it: [known] (Belay's record
     * from before the restart, and every time LockedCalls kept) kept with the restart, then
     * Android's log read from 2 hours before it ([log]: the whole log; calls/AndroidCalls.log takes
     * what's in the read's range).
     */
    private fun firstStep(spell: AfterRestart, known: List<Long>, log: List<AndroidLogCall>): Pair<AfterRestart, List<CallEntry>> {
        val kept = CallsPlan.keepEmergencies(spell, known)
        val readable = log.filter { it.at in CallRecords.spellReadFrom(kept.bootAt)..kept.unlockedAt }
        val taken = CallRecords.whileLocked(readable, kept.bootAt, kept.unlockedAt, kept.seen, emptyList(), rules, { false }, kept.emergencyAt + known, emptySet(), us) { "call-${++ids}" }
        return CallsPlan.afterRead(kept, taken) { false } to taken.entries
    }

    /**
     * G1, fixed. An overnight update restarts the phone at 02:00 and the kid leaves it locked. 03:10:
     * 911 from the lock screen; 03:25: the dispatcher calls back from a 10-digit line, in the phone's
     * own app, answered; 05:40: 911 again; 06:30: the unlock. Telecom doesn't log 911 by default, so
     * only LockedCalls has those times, and it keeps both now (it kept only 05:40, whose window
     * doesn't reach 03:25): the callback is decided by 03:10's window, kept on the phone, never sent.
     */
    @Test
    fun `G1 - a dispatcher's callback to the first of two 911 calls before the unlock is never sent`() {
        val bootAt = at("2026-11-19T02:00:00")
        val first911 = at("2026-11-19T03:10:00")
        val callback = incoming("5555550160", at("2026-11-19T03:25:00"), durationS = 420)
        val second911 = at("2026-11-19T05:40:00")
        val unlockedAt = at("2026-11-19T06:30:00")
        // LockedCalls.record, as OutgoingCallReceiver calls it for each.
        var locked = CallsPlan.lockedRecord(emptyList(), first911)
        locked = CallsPlan.lockedRecord(locked, second911)
        assertEquals(listOf(first911, second911), locked, "both kept, though 03:10's window was over by 05:40")
        val spell = CallsPlan.afterRestart(
            AfterRestart(bootCount = 11, bootAt = bootAt - 24 * hour, unlockedAt = bootAt - 23 * hour, callsOn = true, read = true),
            bootCount = 12, bootAt = bootAt, unlockedAt = unlockedAt, callsWasOn = true,
        )
        val (read, entries) = firstStep(spell, known = listOfNotNull(null /* Belay's record: none */) + locked, log = listOf(callback))
        val entry = entries.single()
        assertTrue(entry.callback, "it rang only because of 03:10's window")
        assertEquals(null, CallRecords.toWire(entry, emptySet(), us), "never sent")
        assertFalse(read.again)
        // With only the newest time (what LockedCalls kept before), it would have been sent: the review's case.
        val (_, before) = firstStep(spell, known = listOf(second911), log = listOf(callback))
        assertEquals("+15555550160", CallRecords.toWire(before.single(), emptySet(), us)?.number)
        // Once the step has them, LockedCalls keeps only the times whose window is still open: 05:40's
        // until 07:40, then none.
        assertEquals(listOf(second911), CallsPlan.lockedOpen(locked, unlockedAt))
        assertEquals(emptyList(), CallsPlan.lockedOpen(locked, second911 + 2 * hour))
    }

    @Test
    fun `G1 - at most 20 times before the unlock, the newest, and the restart keeps each from the spell with its own window`() {
        val bootAt = at("2026-11-19T02:00:00")
        val unlockedAt = at("2026-11-19T23:00:00")
        val calls = (0 until 25).map { bootAt + 10 * minute + it * 40 * minute }
        val locked = calls.fold(emptyList<Long>()) { kept, t -> CallsPlan.lockedRecord(kept, t) }
        assertEquals(calls.takeLast(CallsPlan.MAX_LOCKED_EMERGENCIES), locked)
        assertEquals(locked, CallsPlan.lockedRecord(locked, locked.last()), "the same call twice is kept once")
        // With 988 calls from before the restart too: only the newest of those (its window reaches as
        // far into the spell as any older one's), and all 20 from the spell.
        val before988 = listOf(bootAt - 90 * minute, bootAt - 30 * minute)
        val spell = CallsPlan.keepEmergencies(AfterRestart(12, bootAt, unlockedAt, callsOn = true), before988 + locked)
        assertEquals(listOf(bootAt - 30 * minute) + locked, spell.emergencyAt)
        // A second read decides by these alone, once Belay's own record is forgotten: a counselor's
        // callback 20 minutes after the restart by the 988 call before it, which keeping only the
        // newest 20 of all the times would have dropped.
        val counselor = incoming("+15555550161", bootAt + 20 * minute)
        val second = CallRecords.whileLocked(listOf(counselor), bootAt, unlockedAt, emptyList(), emptyList(), rules, { false }, spell.emergencyAt, emptySet(), us) { "call-${++ids}" }
        assertTrue(second.entries.single().callback)
        val newest20 = (before988 + locked).sorted().takeLast(20)
        val without = CallRecords.whileLocked(listOf(counselor), bootAt, unlockedAt, emptyList(), emptyList(), rules, { false }, newest20, emptySet(), us) { "call-${++ids}" }
        assertFalse(without.entries.single().callback)
    }

    // ── G2: a phone that can't lock (platform notes S5) ─────────────────────────────────

    /** ScreenLock.NEEDS_RESTART and NOT_OWNER on the phone, word for word (app/enforce/ScreenLock.kt). */
    private val needsRestart = "Android lets Belay lock the screen only after the phone restarts once with this version of Belay."
    private val notOwner = "Belay isn't the device owner, so it can't lock the screen."

    /**
     * enforce/CommandRunner.lockNow, as it runs core's ScreenLocks.lockNow: when Belay can't lock
     * ([cannotLock], ScreenLock.cannotLock: hasGrantedPolicy's force-lock, or a refusal since Belay
     * started), each new command fails in those words with no try; when the lock waits, each is
     * done; else ScreenLock.lock runs ([lock]: null when it worked) and each is done or failed by it.
     */
    private fun runnerLockNow(
        plan: CommandPlan,
        due: LockDue?,
        bootAt: Long,
        now: Long,
        cannotLock: String?,
        waits: () -> Boolean,
        lock: () -> String?,
    ): Pair<List<WireCommandResult>, LockDue?> {
        val step = ScreenLocks.lockNow(plan, due, bootCount = 3, bootAt = bootAt, cannotLock = cannotLock, waits = waits)
        step.problem?.let { problem -> return step.report.map { CommandLog.failed(it, now, problem) } to null }
        if (!step.lock) return step.report.map { CommandLog.done(it, now) } to step.due
        val problem = lock()
        return step.report.map { if (problem == null) CommandLog.done(it, now) else CommandLog.failed(it, now, problem) } to null
    }

    private fun lockPlan(id: String, now: Long) =
        Commands.plan(listOf(WireCommand(id, WireCommand.LOCK_NOW, issuedAt = now, expiresAt = now + 10 * minute)), emptySet(), now, setOf(WireCommand.LOCK_NOW))

    @Test
    fun `G2 - on a phone that can't lock until it restarts, every lock_now is failed in the same words, a call on or not`() {
        val bootAt = at("2026-11-18T08:00:00")
        val t1 = at("2026-11-18T10:00:00")
        val t2 = at("2026-11-18T10:20:00")
        val neverTried = { error("Belay doesn't try a lock it knows Android refuses") }
        // 10:00, no call; 10:20, the kid on a call (988, say). The call isn't even asked about.
        val (quiet, quietDue) = runnerLockNow(lockPlan("lock-1", t1), null, bootAt, t1, needsRestart, waits = { error("not asked") }, lock = neverTried)
        val (during, duringDue) = runnerLockNow(lockPlan("lock-2", t2), null, bootAt, t2, needsRestart, waits = { error("not asked") }, lock = neverTried)
        assertEquals(listOf(WireCommandResult("lock-1", WireCommandOutcome.FAILED, t1, needsRestart)), quiet)
        assertEquals(listOf(WireCommandResult("lock-2", WireCommandOutcome.FAILED, t2, needsRestart)), during)
        assertEquals(null, quietDue)
        assertEquals(null, duringDue, "no lock waits for a call that couldn't happen")
        // What the review's probe showed before: done during the call, failed without one.
        val (was, wasDue) = runnerLockNow(lockPlan("lock-2", t2), null, bootAt, t2, cannotLock = null, waits = { true }, lock = neverTried)
        assertEquals(WireCommandOutcome.DONE, was.single().result)
        assertEquals(LockDue(3, bootAt), wasDue)
        // A lock due from before Belay found it can't lock goes too, and nothing more is reported.
        val empty = Commands.plan(emptyList(), setOf("lock-1", "lock-2"), t2, setOf(WireCommand.LOCK_NOW))
        assertEquals(emptyList<WireCommandResult>() to null, runnerLockNow(empty, LockDue(3, bootAt), bootAt, t2, needsRestart, waits = { error("not asked") }, lock = neverTried))
    }

    @Test
    fun `sound - while Belay isn't the device owner every lock_now fails, call or not, and none waits`() {
        val t = at("2026-11-18T10:00:00")
        val a = runnerLockNow(lockPlan("a", t), null, 0, t, notOwner, waits = { true }, lock = { notOwner })
        val b = runnerLockNow(lockPlan("b", t), null, 0, t, notOwner, waits = { false }, lock = { notOwner })
        assertEquals(WireCommandResult("a", WireCommandOutcome.FAILED, t, notOwner), a.first.single())
        assertEquals(WireCommandResult("b", WireCommandOutcome.FAILED, t, notOwner), b.first.single())
        assertEquals(null, a.second)
        // A lock due when Belay stops being device owner is dropped, so none fires after it becomes owner again.
        val empty = Commands.plan(emptyList(), setOf("x"), t, setOf(WireCommand.LOCK_NOW))
        assertEquals(null, runnerLockNow(empty, LockDue(3, 0), 0, t, notOwner, waits = { true }, lock = { notOwner }).second)
    }

    @Test
    fun `G2 - a schedule's lock that can't happen doesn't wait for a call either, so its problem comes as the schedule starts`() {
        val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", WireDay.entries.toList(), "21:00", "07:00", lock = true)
        val policy = WireScreenTime(schedules = listOf(bedtime))
        val start = at("2026-11-18T21:00:30")
        val decision = Rules.evaluate(Rules.Input(policy = policy, now = start, phoneZone = ny, usage = null, measured = true, apps = emptySet(), neverBlocked = emptySet()))
        // EnforcementStep asks a schedule's lock to wait for a call only when Belay can lock (cannotLock == null).
        val cannotLock: String? = needsRestart
        val callOn = true
        val (locks, after) = Upkeep.locks(decision, ScreenTimeState(), start, callOn = cannotLock == null && callOn)
        assertEquals(listOf("s-bed"), locks.map { it.scheduleId }, "done now, so its problem (S5's, already reported) is recorded now, not at the call's end")
        assertEquals(emptyList(), Upkeep.locks(decision, after, start + 30 * minute, callOn = false).first, "once")
    }

    // ── G3: the per-minute steps while a lock waits, and the check-in that comes due ─────

    /** One agent step's sync, as Agent.step asks it (Sync.request with the trigger's cause, then SyncRun). */
    private data class Step(val at: Long, val cause: StepCause, val asked: Boolean = false)

    /** The check-ins a sequence of steps sends after one at [from], by core's SyncPolicy.checkinNow. */
    private fun checkins(from: Long, steps: List<Step>): List<Long> {
        var last = from
        val sent = mutableListOf(from)
        for (step in steps.sortedBy { it.at }) {
            if (SyncPolicy.checkinNow(step.asked, step.cause.dueCheckin, last, step.at)) {
                sent += step.at
                last = step.at
            }
        }
        return sent
    }

    /**
     * A night: the hourly watchdog's steps (WatchdogWorker: Trigger.WATCHDOG, a check-in when due),
     * CheckinWorker's 2-hourly run (always checks in), and, while a lock waits for a call, the policy
     * timer's step every minute (Trigger.POLICY_TIMER: core's ScreenLocks.recheckAt) and the audio
     * mode's step at the call's end (Trigger.CALL).
     */
    private fun night(from: Long, until: Long, watchdogPhase: Long, workerPhase: Long, callUntil: Long?): List<Step> {
        val steps = mutableListOf<Step>()
        var w = from + watchdogPhase
        while (w < until) { steps += Step(w, StepCause.OTHER); w += hour }
        var c = from + workerPhase
        while (c < until) { steps += Step(c, StepCause.OTHER, asked = true); c += 2 * hour }
        if (callUntil != null) {
            var r = from
            while (r < callUntil) { r = ScreenLocks.recheckAt(waiting = true, now = r)!!; steps += Step(r, StepCause.TIME) }
            steps += Step(callUntil, StepCause.CALL)
        }
        return steps
    }

    @Test
    fun `G3 - while a lock waits for a call, the per-minute steps never send a check-in because one is due`() {
        val t0 = at("2026-11-19T01:00:02") // the check-in that carried lock_phone's done
        val rechecks = generateSequence(t0) { prev -> ScreenLocks.recheckAt(waiting = true, now = prev) }.drop(1).take(6 * 60).toList()
        // What the review saw: the first recheck past 110 minutes checked in, within a minute of due.
        val wasDue = rechecks.first { SyncPolicy.checkinDue(t0, it) }
        assertTrue(wasDue - (t0 + 110 * minute) in 0 until minute)
        // Now none of them does, however long the call; a step the workers bring still does.
        assertEquals(listOf(t0), checkins(t0, rechecks.map { Step(it, StepCause.TIME) }))
        assertEquals(listOf(t0), checkins(t0, listOf(Step(t0 + 3 * hour, StepCause.CALL))), "nor the call's end")
        assertEquals(listOf(t0, t0 + 2 * hour), checkins(t0, listOf(Step(t0 + 2 * hour, StepCause.OTHER))))
        // They still send a changed report (Sync.checkinSoon asks), and the workers' check-in.
        assertTrue(SyncPolicy.checkinNow(asked = true, dueToo = StepCause.TIME.dueCheckin, lastCheckinAt = t0, now = t0 + minute))
        assertTrue(StepCause.OTHER.dueCheckin)
        assertFalse(StepCause.TIME.dueCheckin)
        assertFalse(StepCause.CALL.dueCheckin)
    }

    @Test
    fun `G3 - over a night, a call after lock_phone leaves the check-ins exactly where they'd be without one`() {
        val from = at("2026-11-19T00:00:02")
        val until = at("2026-11-19T07:00:00")
        for (wp in listOf(7L, 23L, 41L, 58L)) for (cp in listOf(13L, 52L, 95L)) {
            val quiet = checkins(from, night(from, until, wp * minute, cp * minute, callUntil = null))
            val onCall = checkins(from, night(from, until, wp * minute, cp * minute, callUntil = until - 30 * minute))
            assertEquals(quiet, onCall, "watchdog :$wp, worker +$cp min")
            // What the review saw: gaps of 110 minutes to the minute, again and again, on a call.
            val before = mutableListOf(from)
            for (step in night(from, until, wp * minute, cp * minute, callUntil = until - 30 * minute).sortedBy { it.at }) {
                if (step.asked || SyncPolicy.checkinDue(before.last(), step.at)) before += step.at
            }
            assertTrue(before.zipWithNext { a, b -> (b - a) / minute }.count { it == 110L } >= 2, "the old rule: $before")
        }
    }

    // ── I1: the 2 minutes after a call ──────────────────────────────────────────────────

    private val onCall = CallNow(telecom = true)
    private val noCall = CallNow()

    /**
     * The steps while a lock is due, as the app takes them, from [start]: the policy timer a minute
     * after each step (ScreenLocks.recheckAt, re-armed by every step), and the audio mode's step a
     * second after each call in [calls] starts and ends (calls/InCall.listenForTheEnd). Each asks
     * ScreenLocks.waits, as EnforcementStep does, with what calls/InCall.kt kept from the last. The
     * first step at which the lock ([lost]: lost mode's) no longer waits, or null.
     */
    private fun lockAt(start: Long, calls: List<LongRange>, call: CallNow = onCall, heldOff: Boolean = false, lost: Boolean = false): Long? {
        val audioModeSteps = calls.flatMap { listOf(it.first + 1_000, it.last + 1 + 1_000) }
        var waiting = ScreenLocks.Waiting()
        var t = start
        repeat(10_000) {
            val w = ScreenLocks.waits(if (calls.any { t in it }) call else noCall, waiting, t, heldOff)
            waiting = w.next
            if (!(if (lost) w.lost else w.lock)) return t
            t = (audioModeSteps.filter { it > t } + ScreenLocks.recheckAt(waiting = true, now = t)!!).min()
        }
        return null
    }

    @Test
    fun `I1 - a lock that waited for a call happens 2 minutes after the call ends, so a dropped call to 988 can be made again`() {
        val start = at("2026-11-18T21:00:00")
        val first = start until start + 25 * minute + 30_000
        val ended = first.last + 1
        assertEquals(ended + 1_000 + ScreenLocks.AFTER_CALL_MS, lockAt(start, listOf(first)), "2 minutes from the step at its end")
        assertEquals(ended + 1_000 + ScreenLocks.AFTER_CALL_MS, lockAt(start, listOf(first), lost = true), "lost mode's too")
        // The call drops and the kid calls 988 again 50 seconds later, for 5 minutes: the lock waits for
        // that call too, and the 2 minutes start afresh at its end.
        val second = ended + 50_000 until ended + 50_000 + 5 * minute
        assertEquals(second.last + 1 + 1_000 + ScreenLocks.AFTER_CALL_MS, lockAt(start, listOf(first, second)))
        // A lock no call held off doesn't wait at all.
        assertEquals(start, lockAt(start, emptyList()))
    }

    @Test
    fun `I1 - a lock_now's due lock counts as held off after a restart of Belay, and a clock moved back starts the 2 minutes again`() {
        val start = at("2026-11-18T21:00:00")
        // Belay's process started again after the call (the wait's memory is gone); LockDue says a call held it.
        assertEquals(start + 2 * minute, lockAt(start, emptyList(), heldOff = true))
        // The clock goes back a minute after the call: the 2 minutes count from then.
        val quiet = ScreenLocks.waits(noCall, ScreenLocks.Waiting(heldOff = true), start)
        val back = ScreenLocks.waits(noCall, quiet.next, start - minute)
        assertTrue(back.lock)
        assertEquals(start - minute, back.next.quietSince)
        // What it keeps is only whether a call held a lock off and since when none was on: no call's time.
        assertEquals(ScreenLocks.Waiting(heldOff = true, quietSince = start), quiet.next)
        assertEquals(ScreenLocks.Waiting(heldOff = true), ScreenLocks.waits(onCall, quiet.next, start + minute).next)
    }

    @Test
    fun `I1 - a call only the audio mode shows holds a lock 30 minutes, then it locks mid-call, and lost mode's doesn't wait for one`() {
        val start = at("2026-11-18T21:00:00")
        val carrier = CallNow(carrier = true)
        // On since before the lock came.
        val allEvening = start - 5 * minute until start + 3 * hour
        assertEquals(start + 30 * minute, lockAt(start, listOf(allEvening), carrier), "the cap, with the call still on")
        assertEquals(start, lockAt(start, listOf(allEvening), carrier, lost = true))
        // Such a call ending before the cap: the 2 minutes after it too.
        val short = start - 5 * minute until start + 10 * minute
        assertEquals(short.last + 1 + 1_000 + ScreenLocks.AFTER_CALL_MS, lockAt(start, listOf(short), carrier))
    }

    // ── INFO, documented ────────────────────────────────────────────────────────────────

    /** I2: a due lock has nothing to do with the pause it came with (docs/protocol.md says so). */
    @Test
    fun `I2 - a lock_now's due lock locks after its pause ended or a parent resumed`() {
        val bootAt = at("2026-11-18T08:00:00")
        val t = at("2026-11-18T10:00:00")
        val (_, due) = runnerLockNow(lockPlan("lock-1", t), null, bootAt, t, cannotLock = null, waits = { true }, lock = { null })
        assertEquals(LockDue(3, bootAt), due)
        // 13:00: the 15-minute pause ended at 10:15; the call (and its 2 minutes) are over now.
        val later = Commands.plan(emptyList(), setOf("lock-1"), at("2026-11-18T13:00:00"), setOf(WireCommand.LOCK_NOW))
        assertTrue(ScreenLocks.lockNow(later, due, 3, bootAt) { false }.lock)
    }

    /** I3: without BOOT_COUNT a clock moved 10 minutes or more takes the boot for another, and drops a due lock. */
    @Test
    fun `I3 - without BOOT_COUNT a moved clock can drop a due lock, which was reported done`() {
        val bootAt = at("2026-11-18T08:00:00")
        val empty = Commands.plan(emptyList(), setOf("x"), bootAt + hour, setOf(WireCommand.LOCK_NOW))
        val moved = ScreenLocks.lockNow(empty, LockDue(null, bootAt), null, bootAt + 11 * minute) { false }
        assertFalse(moved.lock)
        assertEquals(null, moved.due)
        assertTrue(Boots.same(3, bootAt, 3, bootAt + 11 * minute), "with BOOT_COUNT (the Pixel, the emulator) it's the same boot")
    }
}
