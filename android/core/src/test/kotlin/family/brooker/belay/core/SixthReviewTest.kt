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
}
