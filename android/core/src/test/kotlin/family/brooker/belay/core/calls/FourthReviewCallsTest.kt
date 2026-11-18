package family.brooker.belay.core.calls

import family.brooker.belay.core.CallNow
import family.brooker.belay.core.CommandLog
import family.brooker.belay.core.Commands
import family.brooker.belay.core.ScreenLocks
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.location.LostApplied
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
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The fourth security review's probes on the phone, as they should come out now: review 3's
 * probes again (part 1), and the new ones (part 2), written to show what went wrong and turned to
 * assert the fixes (N2, N5, N7, N8; N1's are in CallsAfterRestartTest). Two probes show behavior
 * the threat model accepts (a spoof the network doesn't flag); they assert it stays as documented.
 * Made-up apps and 555-01xx numbers only; nothing dials anything.
 */
class FourthReviewCallsTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()

    /**
     * Android as on a US phone with a SIM: 911 and 112 are emergency numbers, exactly; its formatter
     * writes a valid 10-digit national number (or 1 and 10 digits) with +1 and nothing else, as
     * PhoneNumberUtils.formatNumberToE164 does for a number libphonenumber calls valid.
     */
    private val android = object : EmergencyNumbers {
        override fun isEmergency(number: String) = number in setOf("911", "112")

        override fun e164(number: String): String? = PhoneNumbers.e164(number)
            ?: number.takeIf { it.all(Char::isDigit) }?.let { d ->
                when {
                    d.length == 10 && d[0] in '2'..'9' && !d.startsWith("911") -> "+1$d"
                    d.length == 11 && d[0] == '1' && d[1] in '2'..'9' -> "+$d"
                    else -> null
                }
            }
    }

    private val strict = WireCalls(mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT, outgoing = WireOutgoing.CONTACTS, quiet = true, log = true)
    private val mom = WireContact("c-mom", "Mom", listOf("+15555550100"), calls = true, parent = true)

    private fun kept(direction: WireCallDirection, number: String?, durationS: Int = 60, private: Set<String> = emptySet()) =
        CallRecords.entry("c", at("2026-11-18T23:00:00"), direction, number, null, durationS, WireCallOutcome.ANSWERED, null, private, android)

    // ── Part 1: review 3's probes ──────────────────────────────────────────────────────────

    @Test
    fun `R3-1 a caller id showing 988, its old number or 911 that failed the check is a stranger's, kept and sent without the number`() {
        val now = CallsNow(calls = strict, contacts = listOf(mom), quietSchedule = true, now = at("2026-11-18T01:30:00"))
        for (shown in listOf("+18002738255", "988", "911")) {
            val decision = CallRules.incoming(IncomingCall(shown, Presentation.NUMBER, Verification.FAILED), now, android)
            assertEquals(Ring.REJECT, decision.action, shown)
            val entry = assertNotNull(CallRecords.entry("call-$shown", now.now, WireCallDirection.IN, shown, null, 0, WireCallOutcome.REJECTED, decision.reason, emptySet(), android, unverified = decision.unverified))
            assertNull(assertNotNull(CallRecords.toWire(entry, emptySet(), android)).number, shown)
        }
    }

    @Test
    fun `R3-2 911 and 988 dialed with a caller-id code always go, open the window, and are never recorded`() {
        val contactsOnly = CallsNow(calls = strict, contacts = emptyList(), now = at("2026-11-18T22:00:00"))
        for (dialed in listOf("*67911", "*67 988", "#31#988", "*31#911", "*82988", "*67 1 800 273 8255")) {
            val key = PhoneNumbers.key(dialed)
            val decision = CallRules.outgoing(key, contactsOnly, android)
            assertTrue(decision.allowed, dialed)
            assertNotNull(decision.alwaysAllowed, dialed)
            assertTrue(AlwaysAllowed.opensCallbackWindow(key, android), dialed)
            assertNull(kept(WireCallDirection.OUT, key, 1800), dialed)
        }
    }

    @Test
    fun `R3-2b a private number dialed with a code is never kept`() {
        val private = setOf("+15555550177")
        assertNull(kept(WireCallDirection.OUT, PhoneNumbers.key("*675555550177"), private = private))
        assertNull(kept(WireCallDirection.OUT, PhoneNumbers.key("#31#15555550177"), private = private))
    }

    @Test
    fun `R3-3 locking schedules lock once each, and never during a call Telecom has`() {
        val schedules = (0 until 20).map { i ->
            val start = 15 * 60 + 3 * i
            WireSchedule("s-$i", WireScheduleKind.CUSTOM, "Schedule", WireDay.entries.toList(), "%02d:%02d".format(start / 60, start % 60), "%02d:%02d".format((start + 1) / 60, (start + 1) % 60), lock = true)
        }
        val policy = WireScreenTime(schedules = schedules)
        fun locks(waits: Boolean): Int {
            var state = ScreenTimeState()
            var count = 0
            for (minute in 0..60) {
                val now = at("2026-11-18T15:00:00") + minute * 60_000L + 5_000L
                val decision = Rules.evaluate(Rules.Input(policy = policy, now = now, phoneZone = ny, usage = null, measured = true, apps = setOf("com.example.game"), neverBlocked = emptySet()))
                val (due, next) = Upkeep.locks(decision, state, now, callOn = waits)
                count += due.size
                state = next
            }
            return count
        }
        assertEquals(20, locks(waits = false))
        assertEquals(0, locks(waits = ScreenLocks.wait(CallNow(telecom = true), null, 0).waits))
    }

    @Test
    fun `R3-A a dispatcher's callback rings with Belay's record, or with Telecom's emergency mark`() {
        val rules = WireCalls(mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT)
        val dispatcher = IncomingCall("+15555550160", Presentation.NUMBER)
        val now = at("2026-11-18T23:40:00")
        val known = CallsNow(calls = rules, contacts = listOf(mom), lastEmergencyContactAt = now - 20 * 60_000L, now = now)
        val missed = known.copy(lastEmergencyContactAt = null)
        assertEquals(RingBecause.EMERGENCY_CALLBACK, CallRules.incoming(dispatcher, known, android).because)
        assertEquals(RingBecause.EMERGENCY_MODE, CallRules.incoming(dispatcher.copy(emergency = true), missed, android).because)
        assertEquals(Ring.RING, CallRules.incoming(IncomingCall(null, Presentation.WITHHELD, emergency = true), missed, android).action)
    }

    // ── Part 2: what the third review's fixes changed ──────────────────────────────────────

    @Test
    fun `code stripping - an ordinary number after a code isn't taken for 911 or 988`() {
        val contactsOnly = CallsNow(calls = strict, contacts = emptyList(), now = at("2026-11-18T22:00:00"))
        val any = contactsOnly.copy(calls = strict.copy(outgoing = WireOutgoing.ANY))
        for (dialed in listOf("*679115551234", "#31#9885551234", "*67988555", "*82 911 0", "*679884", "#31#9119", "*67*82*699885550199")) {
            val key = PhoneNumbers.key(dialed)
            assertNull(AlwaysAllowed.dialed(key, android), dialed)
            assertFalse(CallRules.outgoing(key, contactsOnly, android).allowed, dialed)
            assertTrue(CallRules.outgoing(key, any, android).allowed, dialed)
        }
    }

    @Test
    fun `N8 code stripping - only the codes that hide or show the number come off, so these aren't 911, 988 or 112`() {
        val contactsOnly = CallsNow(calls = strict, contacts = emptyList(), now = at("2026-11-18T22:00:00"))
        // The digit after a two-digit code, a three-digit code, or a code that reads as another one.
        for (dialed in listOf("*671911", "*671988", "*272911", "*679112", "*67#31#988")) {
            val key = PhoneNumbers.key(dialed)
            assertNull(AlwaysAllowed.dialed(key, android), dialed)
            assertFalse(CallRules.outgoing(key, contactsOnly, android).allowed, "$dialed is refused with only contacts")
            assertFalse(AlwaysAllowed.opensCallbackWindow(key, android), "$dialed opens no window")
        }
        // Real ones still do, one or more of them.
        assertEquals(AlwaysAllowedKind.EMERGENCY, AlwaysAllowed.dialed("*31#*67911", android))
        assertEquals(AlwaysAllowedKind.CRISIS_988, AlwaysAllowed.dialed("#31#*67988", android))
    }

    @Test
    fun `N2 an outgoing call Android can't write in E164 is kept with what was dialed, and sent without it`() {
        val any = CallsNow(calls = strict.copy(outgoing = WireOutgoing.ANY), contacts = emptyList(), now = at("2026-11-18T22:00:00"))
        for (dialed in listOf("5550199", "211", "511", "0115550199")) {
            val key = PhoneNumbers.key(dialed)
            assertTrue(CallRules.outgoing(key, any, android).allowed, dialed)
            val entry = assertNotNull(kept(WireCallDirection.OUT, key, 2400), "$dialed is kept on the phone")
            assertEquals(key, entry.number, "$dialed: the digits dialed")
            val wire = assertNotNull(CallRecords.toWire(entry, emptySet(), android), "$dialed is sent")
            assertNull(wire.number, "$dialed: without the number")
            assertEquals(2400, wire.durationS)
        }
    }

    @Test
    fun `accepted - an incoming caller id the network didn't flag showing 911 rings past every rule, and neither it nor 988 is kept`() {
        val now = CallsNow(calls = strict, contacts = listOf(mom), quietSchedule = true, now = at("2026-11-18T01:30:00"))
        val open = now.copy(calls = strict.copy(mode = WireCallMode.OPEN), quietSchedule = false)
        for ((shown, rules) in listOf("911" to now, "988" to open, "+18002738255" to open, "988" to now)) {
            val d = CallRules.incoming(IncomingCall(shown, Presentation.NUMBER, Verification.NOT_VERIFIED), rules, android)
            val entry = CallRecords.entry("c", rules.now, WireCallDirection.IN, shown, null, 3600, if (d.action == Ring.RING) WireCallOutcome.ANSWERED else WireCallOutcome.REJECTED, d.reason, emptySet(), android)
            assertNull(entry, "$shown is kept nowhere (threat model: a spoof the network doesn't flag)")
        }
        assertEquals(RingBecause.ALWAYS_ALLOWED, CallRules.incoming(IncomingCall("911", Presentation.NUMBER), now, android).because)
        assertEquals(Ring.REJECT, CallRules.incoming(IncomingCall("988", Presentation.NUMBER), now, android).action)
    }

    @Test
    fun `accepted - an incoming caller id with a code before 988 or a private number rings by the rules, and is kept nowhere`() {
        val open = CallsNow(calls = strict.copy(mode = WireCallMode.OPEN, quiet = false), contacts = listOf(mom), now = at("2026-11-18T01:30:00"))
        val private = setOf("+15555550177")
        for (shown in listOf("#31#988", "*67911", "*67+15555550177")) {
            val key = PhoneNumbers.key(shown)
            val d = CallRules.incoming(IncomingCall(key, Presentation.NUMBER, Verification.NOT_VERIFIED), open, android)
            assertEquals(RingBecause.OPEN, d.because, shown)
            assertNull(CallRecords.entry("c", open.now, WireCallDirection.IN, key, null, 3600, WireCallOutcome.ANSWERED, null, private, android), shown)
        }
    }

    @Test
    fun `N7 a parent's own number whose check failed goes to voicemail under contacts-only`() {
        val now = CallsNow(calls = strict, contacts = listOf(mom), now = at("2026-11-18T17:00:00"))
        val d = CallRules.incoming(IncomingCall("+15555550100", Presentation.NUMBER, Verification.FAILED), now, android)
        assertEquals(Ring.VOICEMAIL, d.action)
        assertEquals(WireCallReason.UNKNOWN, d.reason)
        assertNull(d.contact)
    }

    @Test
    fun `N5 screen locks - only a call an app can't make up holds one, the audio mode's for 30 minutes`() {
        // A lock_now that outlasts a call expires, reported as one a call was on until it expired.
        val lockNow = WireCommand("c-1", WireCommand.LOCK_NOW, issuedAt = at("2026-11-18T21:00:00"), expiresAt = at("2026-11-18T21:10:00"))
        val during = Commands.plan(listOf(lockNow), emptySet(), now = at("2026-11-18T21:01:00"), runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(emptyList(), ScreenLocks.lockNow(during, waits = true))
        val waiting = CommandLog().waiting(during.lockNow.map { it.id })
        val after = Commands.plan(listOf(lockNow), emptySet(), now = at("2026-11-18T21:30:00"), runs = setOf(WireCommand.LOCK_NOW))
        val outcome = CommandLog.notRun(after, at("2026-11-18T21:30:00"), waiting.waitingForCall).single()
        assertEquals(WireCommandOutcome.EXPIRED, outcome.result)
        assertEquals(true, outcome.waitedForCall)
        // Bedtime 21:00 to 07:00, locking, with the apps paused throughout.
        val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", WireDay.entries.toList(), "21:00", "07:00", lock = true)
        val policy = WireScreenTime(schedules = listOf(bedtime))
        fun locksAt(call: CallNow): List<Int> {
            var state = ScreenTimeState()
            var carrierSince: Long? = null
            val lockedAt = mutableListOf<Int>()
            for (minute in 0 until (10 * 60) step 5) {
                val now = at("2026-11-18T21:00:00") + minute * 60_000L
                val decision = Rules.evaluate(Rules.Input(policy = policy, now = now, phoneZone = ny, usage = null, measured = true, apps = setOf("com.example.game"), neverBlocked = emptySet()))
                assertTrue("com.example.game" in decision.suspend)
                val wait = ScreenLocks.wait(call, carrierSince, now)
                carrierSince = wait.carrierSince
                val (due, next) = Upkeep.locks(decision, state, now, callOn = wait.waits)
                if (due.isNotEmpty()) lockedAt += minute
                state = next
            }
            return lockedAt
        }
        // An app holding MODE_IN_COMMUNICATION (a voice chat left open, paused or not) is no call to Belay.
        assertEquals(listOf(0), locksAt(CallNow()), "it locks as bedtime starts")
        // A carrier call only the audio mode shows (Belay isn't the dialer): 30 minutes at most.
        assertEquals(listOf(30), locksAt(CallNow(carrier = true)))
        // A call Telecom has, all night: no lock, as designed (the screen never goes off mid-call).
        assertEquals(emptyList(), locksAt(CallNow(telecom = true)))
        // Lost mode's lock waits only for a call Telecom has.
        assertFalse(ScreenLocks.lostLockWaits(LostApplied(since = 0), telecom = false))
        assertTrue(ScreenLocks.lostLockWaits(LostApplied(since = 0), telecom = true))
    }
}
