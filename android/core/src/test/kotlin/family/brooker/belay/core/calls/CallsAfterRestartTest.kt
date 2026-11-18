package family.brooker.belay.core.calls

import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The fourth review's N1: before the first unlock after a restart Belay decides no calls, so the
 * phone's own app takes them all. Afterwards Belay takes them from Android's call log, by the same
 * rules as every record, and says how long the phone stayed locked. Made-up 555-01xx numbers only.
 */
class CallsAfterRestartTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()
    private val minute = 60_000L

    /** Android on a US phone: 911 and 112, and a national number written in E.164 with its +1. */
    private val android = object : EmergencyNumbers {
        override fun isEmergency(number: String) = number in setOf("911", "112")

        override fun e164(number: String): String? =
            PhoneNumbers.e164(number) ?: ("+1$number").takeIf { number.length == 10 && number.all(Char::isDigit) }
    }

    private val mom = WireContact("c-mom", "Mom", listOf("+15555550100"), calls = true, parent = true)
    private val sam = WireContact("c-sam", "Sam", listOf("+15555550123"), calls = true)
    private val strict = WireCalls(mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT, quiet = true, log = true)
    private val rules = CallsNow(calls = strict, contacts = listOf(mom, sam), now = 0)
    private val private = setOf("+15555550177")

    // The kid restarts the phone at 22:00 and leaves it locked until 23:30.
    private val bootAt = at("2026-11-18T22:00:00")
    private val unlockedAt = at("2026-11-18T23:30:00")

    private fun inCall(number: String?, at: Long, outcome: WireCallOutcome = WireCallOutcome.ANSWERED, durationS: Int = 600) =
        AndroidLogCall(number ?: "", at, WireCallDirection.IN, durationS, withheld = number == null, outcome = outcome)

    private fun take(
        log: List<AndroidLogCall>,
        kept: List<CallEntry> = emptyList(),
        seen: List<Long> = emptyList(),
        emergencyAt: List<Long> = emptyList(),
        quiet: Boolean = false,
    ): CallRecords.Taken {
        var n = 0
        return CallRecords.whileLocked(log, bootAt, unlockedAt, seen, kept, rules, { quiet }, emergencyAt, private, android) { "call-${++n}" }
    }

    @Test
    fun `the calls that rang in the phone's own app while it was locked are kept and sent, with what happened`() {
        val stranger = inCall("5555550199", at("2026-11-18T22:10:00"))
        val missed = inCall("+15555550198", at("2026-11-18T22:20:00"), WireCallOutcome.MISSED, 0)
        val declined = inCall("+15555550197", at("2026-11-18T22:25:00"), WireCallOutcome.REJECTED, 0)
        val contact = inCall("+15555550123", at("2026-11-18T22:30:00"))
        val withheld = inCall(null, at("2026-11-18T22:40:00"))
        val taken = take(listOf(withheld, contact, declined, missed, stranger))
        assertEquals(5, taken.entries.size)
        val first = taken.entries.first()
        assertEquals("+15555550199", first.number, "written in E.164, as Belay's own records are")
        assertEquals(WireCallOutcome.ANSWERED, first.outcome)
        assertEquals(600, first.durationS)
        assertNull(first.reason, "Belay refused nothing: it rang")
        assertEquals(listOf(WireCallOutcome.ANSWERED, WireCallOutcome.MISSED, WireCallOutcome.REJECTED, WireCallOutcome.ANSWERED, WireCallOutcome.ANSWERED), taken.entries.map { it.outcome })
        assertEquals("c-sam", taken.entries[3].contactId)
        assertNull(taken.entries[4].number, "a withheld caller")
        // Sent like any record: the stranger's number, the contact by id, nothing for the withheld caller.
        val wire = taken.entries.map { assertNotNull(CallRecords.toWire(it, private, android)) }
        assertEquals("+15555550199", wire[0].number)
        assertEquals("c-sam", wire[3].contactId)
        assertNull(wire[3].number)
        assertNull(wire[4].number)
        assertEquals(listOf(stranger, missed, declined, contact, withheld).map { it.at }, taken.seen)
    }

    @Test
    fun `never a call with 911, 988, an emergency number or a private number`() {
        val never = listOf("911", "988", "+18002738255", "112", "+15555550177", "5555550177")
        val log = never.mapIndexed { i, n -> inCall(n, bootAt + (i + 1) * minute) } +
            // The kid's own emergency call from the lock screen, when the carrier logs it.
            AndroidLogCall("911", bootAt + 30 * minute, WireCallDirection.OUT, 120, outcome = WireCallOutcome.ANSWERED)
        val taken = take(log)
        assertEquals(emptyList(), taken.entries)
        assertEquals(log.size, taken.seen.size, "read, so never read again")
    }

    @Test
    fun `a call in the 2 hours after an emergency contact is kept on the phone and never sent, unless the rules let it ring`() {
        val dispatcher = inCall("+15555550160", at("2026-11-18T22:50:00"))
        val sams = inCall("+15555550123", at("2026-11-18T22:55:00"))
        // The 911 call from the lock screen at 22:45, as Android logged it.
        val nineOneOne = AndroidLogCall("911", at("2026-11-18T22:45:00"), WireCallDirection.OUT, 60, outcome = WireCallOutcome.ANSWERED)
        val fromTheLog = take(listOf(nineOneOne, dispatcher, sams))
        val callback = fromTheLog.entries.single { it.number == "+15555550160" }
        assertTrue(callback.callback, "it rang only because of the window: the rules would have refused it")
        assertNull(CallRecords.toWire(callback, private, android), "never sent: it would say the kid called 911")
        assertFalse(fromTheLog.entries.single { it.contactId == "c-sam" }.callback, "a contact rings for its own reason")
        // The time kept before the unlock (LockedCalls), or Belay's record from before the restart, opens it too.
        val kept = take(listOf(dispatcher), emergencyAt = listOf(at("2026-11-18T21:30:00")))
        assertTrue(kept.entries.single().callback)
        // Once the window is over, it's an ordinary stranger's call, sent.
        val late = take(listOf(inCall("+15555550160", at("2026-11-18T23:40:00").coerceAtMost(unlockedAt))), emergencyAt = listOf(at("2026-11-18T21:00:00")))
        assertFalse(late.entries.single().callback)
        assertNotNull(CallRecords.toWire(late.entries.single(), private, android))
    }

    @Test
    fun `during quiet time, a contact's call in the window rang only because of it`() {
        val sams = inCall("+15555550123", at("2026-11-18T22:55:00"))
        val quiet = take(listOf(sams), emergencyAt = listOf(at("2026-11-18T22:45:00")), quiet = true)
        assertTrue(quiet.entries.single().callback)
        assertFalse(take(listOf(sams), quiet = true).entries.single().callback, "no window: an ordinary record")
    }

    @Test
    fun `no call is taken twice, nor one Belay decided itself`() {
        val stranger = inCall("+15555550199", at("2026-11-18T22:10:00"))
        val first = take(listOf(stranger))
        assertEquals(1, first.entries.size)
        // Read again (after a call that was still on): what was read before isn't taken again,
        // also when the kid removed it from Belay's recent calls since.
        val later = inCall("+15555550196", at("2026-11-18T23:00:00"), durationS = 3600)
        val again = take(listOf(stranger, later), seen = first.seen)
        assertEquals(listOf("+15555550196"), again.entries.map { it.number })
        // A call Belay's own in-call service had (after the unlock, in the gap before the first step).
        val mine = CallEntry("mine", at("2026-11-18T23:29:30"), WireCallDirection.IN, "+15555550195", outcome = WireCallOutcome.ANSWERED)
        val gap = inCall("5555550195", at("2026-11-18T23:29:20"), durationS = 20)
        assertEquals(emptyList(), take(listOf(gap), kept = listOf(mine)).entries)
    }

    @Test
    fun `only the calls between the restart and the unlock, and only the ones a record can say`() {
        val before = inCall("+15555550199", bootAt - minute)
        val after = inCall("+15555550198", unlockedAt + minute)
        val voicemail = AndroidLogCall("+15555550194", bootAt + minute, WireCallDirection.IN, 30, outcome = null)
        val blocked = AndroidLogCall("+15555550193", bootAt + 2 * minute, WireCallDirection.IN, 0, blocked = true, outcome = null)
        val elsewhere = AndroidLogCall("+15555550192", bootAt + 3 * minute, null, 0, outcome = null)
        val taken = take(listOf(before, after, voicemail, blocked, elsewhere))
        assertEquals(emptyList(), taken.entries)
        assertEquals(listOf(voicemail.at, blocked.at, elsewhere.at), taken.seen, "only the restart's")
        // An outgoing call (from a car kit, say) is kept like the kid's own, with the number it reached.
        val out = AndroidLogCall("5555550199", bootAt + 5 * minute, WireCallDirection.OUT, 90, outcome = WireCallOutcome.ANSWERED)
        assertEquals("+15555550199", take(listOf(out)).entries.single().number)
    }

    @Test
    fun `the first step after a restart records it, and reads its calls only when calls was on through it`() {
        val earlier = AfterRestart(bootCount = 11, bootAt = bootAt - 86_400_000, unlockedAt = bootAt - 86_000_000, callsOn = true, read = true)
        val now = CallsPlan.afterRestart(earlier, bootCount = 12, bootAt = bootAt, unlockedAt = unlockedAt, callsWasOn = true)
        assertEquals(AfterRestart(12, bootAt, unlockedAt, callsOn = true, read = false), now)
        // The same restart at every later step.
        assertEquals(now, CallsPlan.afterRestart(now, 12, bootAt + 5_000, unlockedAt + HOUR, callsWasOn = true))
        // Calls off before it, or no record before (calls just turned on, or this Belay just installed): nothing to read.
        assertFalse(CallsPlan.afterRestart(earlier, 12, bootAt, unlockedAt, callsWasOn = false).callsOn)
        assertFalse(CallsPlan.afterRestart(null, 12, bootAt, unlockedAt, callsWasOn = true).callsOn)
        // Without a boot count, by when the phone started.
        val noCount = AfterRestart(bootAt = bootAt, unlockedAt = unlockedAt)
        assertTrue(CallsPlan.sameBoot(noCount, null, bootAt + 2 * minute))
        assertFalse(CallsPlan.sameBoot(noCount, null, bootAt + HOUR))
        assertFalse(CallsPlan.sameBoot(now, 13, bootAt), "a new boot count is a new restart")
    }

    @Test
    fun `the call log is read once, and once more after a call that was still on then`() {
        val spell = AfterRestart(12, bootAt, unlockedAt, callsOn = true)
        assertTrue(CallsPlan.readLockedCalls(spell, callsOn = true) { true })
        val read = spell.copy(read = true)
        assertFalse(CallsPlan.readLockedCalls(read, callsOn = true) { error("not asked") })
        val again = read.copy(again = true)
        assertFalse(CallsPlan.readLockedCalls(again, callsOn = true) { true }, "while that call is still on")
        assertTrue(CallsPlan.readLockedCalls(again, callsOn = true) { false })
        assertFalse(CallsPlan.readLockedCalls(spell, callsOn = false) { false }, "calls off now")
        assertFalse(CallsPlan.readLockedCalls(spell.copy(callsOn = false), callsOn = true) { false })
    }

    @Test
    fun `a call to 988 in the 2 hours before the restart opens the window into it`() {
        // The log is read from 2 hours before the restart: the kid called 988 at 21:30, then restarted.
        val nineEightEight = AndroidLogCall("988", at("2026-11-18T21:30:00"), WireCallDirection.OUT, 900, outcome = WireCallOutcome.ANSWERED)
        val counselor = inCall("+15555550161", at("2026-11-18T22:40:00"))
        val taken = take(listOf(nineEightEight, counselor))
        assertTrue(taken.entries.single().callback, "it rang only because of the window")
        assertNull(CallRecords.toWire(taken.entries.single(), private, android))
        assertEquals(listOf(nineEightEight.at), taken.emergencyAt, "what the read decided by")
        assertEquals(listOf(counselor.at), taken.seen, "the call before the restart isn't one of the spell's")
        // One from longer ago opens nothing: its window was over before the restart.
        val old = nineEightEight.copy(at = CallRecords.spellReadFrom(bootAt) - minute)
        assertFalse(take(listOf(old, counselor)).entries.single().callback)
        assertEquals(emptyList(), take(listOf(old, counselor)).emergencyAt)
        assertEquals(bootAt - 2 * HOUR, CallRecords.spellReadFrom(bootAt))
    }

    @Test
    fun `the emergency times a read decides by are kept for the next read, and only while one is due`() {
        val spell = AfterRestart(12, bootAt, unlockedAt, callsOn = true)
        val times = listOf(bootAt - 3 * HOUR, bootAt - HOUR, bootAt + 10 * minute, unlockedAt + HOUR)
        // Only those whose 2 hours reach into the spell: from 2 hours before the restart to the unlock.
        val kept = CallsPlan.keepEmergencies(spell, times)
        assertEquals(listOf(bootAt - HOUR, bootAt + 10 * minute), kept.emergencyAt)
        // A later step that has forgotten them keeps them, while the second read is still due.
        val waiting = kept.copy(read = true, again = true)
        assertEquals(kept.emergencyAt, CallsPlan.keepEmergencies(waiting, emptyList()).emergencyAt)
        // After the last read, or with calls off through the restart, none are kept.
        assertEquals(emptyList(), CallsPlan.keepEmergencies(waiting.copy(again = false), times).emergencyAt)
        assertEquals(emptyList(), CallsPlan.keepEmergencies(spell.copy(callsOn = false), times).emergencyAt)
        // A few at most.
        val many = (1..50).map { bootAt + it * minute }
        assertEquals(CallsPlan.MAX_SPELL_EMERGENCIES, CallsPlan.keepEmergencies(spell, many).emergencyAt.size)
        assertEquals(many.takeLast(CallsPlan.MAX_SPELL_EMERGENCIES), CallsPlan.keepEmergencies(spell, many).emergencyAt, "the newest")
        // Calls off: the spell's calls are never read, and the times go.
        val off = CallsPlan.noMoreReads(waiting)
        assertEquals(emptyList(), off.emergencyAt)
        assertFalse(CallsPlan.readLockedCalls(off, callsOn = true) { false })
        assertFalse(CallsPlan.readLockedCalls(CallsPlan.noMoreReads(spell), callsOn = true) { false }, "not even a first read")
    }

    @Test
    fun `a read keeps what it decided by for the second read only`() {
        val nineOneOne = at("2026-11-18T22:05:00")
        val spell = CallsPlan.keepEmergencies(AfterRestart(12, bootAt, unlockedAt, callsOn = true), listOf(nineOneOne))
        val first = CallsPlan.afterRead(spell, take(emptyList(), emergencyAt = spell.emergencyAt)) { true }
        assertTrue(first.read)
        assertTrue(first.again, "a call Belay didn't have is still on")
        assertEquals(listOf(nineOneOne), first.emergencyAt)
        val second = CallsPlan.afterRead(first, take(emptyList(), emergencyAt = first.emergencyAt)) { error("not asked after the first read") }
        assertFalse(second.again)
        assertEquals(emptyList(), second.emergencyAt, "gone after the last read")
        // A first read with no call still on keeps none.
        assertEquals(emptyList(), CallsPlan.afterRead(spell, take(emptyList(), emergencyAt = spell.emergencyAt)) { false }.emergencyAt)
    }

    @Test
    fun `the report says how long the phone stayed locked, for a day, when it was 10 minutes or more`() {
        val spell = AfterRestart(12, bootAt, unlockedAt, callsOn = true)
        val note = assertNotNull(CallsPlan.lockedNote(spell, unlockedAt + minute))
        assertEquals(
            "The phone restarted and stayed locked for about 2 hours. Until it's unlocked after a restart, Belay can't decide calls: they ring in the phone's own app, whatever the rules.",
            note,
        )
        assertEquals(WireCallsStatus(dialer = true, problem = note), CallsPlan.report(on = true, isDialer = true, note = note))
        assertEquals(CallsPlan.NOT_THE_DIALER, CallsPlan.report(on = true, isDialer = false, note = note)?.problem, "not the dialer says more")
        assertNull(CallsPlan.lockedNote(spell, unlockedAt + 24 * HOUR), "a day later")
        assertNull(CallsPlan.lockedNote(spell.copy(unlockedAt = bootAt + 9 * minute), bootAt + 10 * minute), "a quick restart")
        assertNull(CallsPlan.lockedNote(spell.copy(callsOn = false), unlockedAt + minute), "calls weren't on")
        assertNull(CallsPlan.lockedNote(null, unlockedAt))
        // In the phone's own words, within the report's 200 characters, and never a time.
        for (locked in listOf(10 * minute, 59 * minute, 61 * minute, 23 * HOUR + 59 * minute, 47 * HOUR, 9 * 24 * HOUR)) {
            val words = assertNotNull(CallsPlan.lockedNote(spell.copy(unlockedAt = bootAt + locked), bootAt + locked))
            assertTrue(words.length <= 200, words)
            assertFalse(Regex("[0-9]{1,2}:[0-9]{2}").containsMatchIn(words), words)
        }
        assertTrue(assertNotNull(CallsPlan.lockedNote(spell.copy(unlockedAt = bootAt + 25 * minute), bootAt + 25 * minute)).contains("for 25 minutes"))
        assertTrue(assertNotNull(CallsPlan.lockedNote(spell.copy(unlockedAt = bootAt + 3 * 24 * HOUR), bootAt + 3 * 24 * HOUR)).contains("about 3 days"))
    }

    private companion object {
        const val HOUR = 3_600_000L
    }
}
