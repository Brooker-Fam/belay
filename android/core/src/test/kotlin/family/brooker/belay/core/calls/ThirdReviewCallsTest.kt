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
 * The third security review's probes on the phone's calls, as they should come out now (they were
 * written to show what went wrong): a spoofed caller id that shows 988 or 911, 911 and 988 dialed
 * with a caller-id code before them, a private number dialed so, and a dispatcher's callback after
 * a 911 call Belay didn't see. Made-up 555-01xx numbers only. The locking-schedules probe is in
 * UpkeepTest.
 */
class ThirdReviewCallsTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()

    /** Android as on a US phone with a SIM: 911 and 112 are emergency numbers, and it writes national numbers with +1. */
    private val android = object : EmergencyNumbers {
        override fun isEmergency(number: String) = number in setOf("911", "112")

        override fun e164(number: String): String? =
            PhoneNumbers.e164(number) ?: ("+1$number").takeIf { number.length == 10 && number.all(Char::isDigit) }
    }

    @Test
    fun `a caller id showing 988's number that failed the network's check is refused, kept, and sent without the number`() {
        val strict = WireCalls(mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT, quiet = true, log = true)
        val mom = WireContact("c-mom", "Mom", listOf("+15555550100"), calls = true, parent = true)
        // Bedtime is on (quiet), only contacts may call, unknown callers are refused.
        val now = CallsNow(calls = strict, contacts = listOf(mom), quietSchedule = true, now = at("2026-11-18T01:30:00"))
        for (shown in listOf("+18002738255", "988", "911")) {
            val decision = CallRules.incoming(IncomingCall(shown, Presentation.NUMBER, Verification.FAILED), now, android)
            assertEquals(Ring.REJECT, decision.action, shown)
            assertEquals(WireCallReason.UNKNOWN, decision.reason, shown)
            assertTrue(decision.unverified, shown)
            val entry = assertNotNull(
                CallRecords.entry("call-$shown", now.now, WireCallDirection.IN, shown, null, 0, WireCallOutcome.REJECTED, decision.reason, emptySet(), android, unverified = decision.unverified),
                "$shown is kept on the phone, like any unknown caller's",
            )
            val wire = assertNotNull(CallRecords.toWire(entry, emptySet(), android), "$shown is sent: a stranger called")
            assertNull(wire.number, "$shown: without the number")
            assertEquals(WireCallOutcome.REJECTED, wire.outcome)
        }
        // The same stranger from their own number is refused too.
        assertEquals(Ring.REJECT, CallRules.incoming(IncomingCall("+15555550166", Presentation.NUMBER), now, android).action)
    }

    @Test
    fun `911 and 988 dialed with a caller-id code before them always go through, open the window, and are never recorded`() {
        val contactsOnly = CallsNow(calls = WireCalls(mode = WireCallMode.CONTACTS, outgoing = WireOutgoing.CONTACTS), contacts = emptyList(), now = at("2026-11-18T22:00:00"))
        for (dialed in listOf("*67911", "*67 988", "#31#988", "*82988")) {
            val key = assertNotNull(PhoneNumbers.key(dialed))
            val decision = CallRules.outgoing(key, contactsOnly, android)
            assertTrue(decision.allowed, dialed)
            assertNotNull(decision.alwaysAllowed, "$dialed opens the callback window")
            assertTrue(AlwaysAllowed.opensCallbackWindow(key, android), dialed)
            assertNull(CallRecords.entry("call-1", at("2026-11-18T23:10:00"), WireCallDirection.OUT, key, null, 1800, WireCallOutcome.ANSWERED, null, emptySet(), android), dialed)
        }
        val any = contactsOnly.copy(calls = WireCalls(outgoing = WireOutgoing.ANY))
        assertEquals(AlwaysAllowedKind.CRISIS_988, CallRules.outgoing(PhoneNumbers.key("*67988"), any, android).alwaysAllowed)
    }

    @Test
    fun `a private number dialed with a caller-id code is never recorded or sent`() {
        val private = setOf("+15555550177")
        assertNull(CallRecords.entry("call-2", at("2026-11-18T23:30:00"), WireCallDirection.OUT, PhoneNumbers.key("*675555550177"), null, 2400, WireCallOutcome.ANSWERED, null, private, android))
        assertNull(CallRecords.entry("call-3", at("2026-11-18T23:30:00"), WireCallDirection.OUT, "+15555550177", null, 2400, WireCallOutcome.ANSWERED, null, private, android))
        // An ordinary number dialed so is recorded by the number it reached, never without one.
        val ordinary = assertNotNull(CallRecords.entry("call-4", at("2026-11-18T23:30:00"), WireCallDirection.OUT, PhoneNumbers.key("*675555550199"), null, 60, WireCallOutcome.ANSWERED, null, private, android))
        assertEquals("+15555550199", assertNotNull(CallRecords.toWire(ordinary, private, android)).number)
    }

    @Test
    fun `a dispatcher's callback rings with Belay's record of the 911 call, or with Telecom's emergency mark`() {
        val rules = WireCalls(mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT)
        val mom = WireContact("c-mom", "Mom", listOf("+15555550100"), calls = true, parent = true)
        val dispatcher = IncomingCall("+15555550160", Presentation.NUMBER)
        val now = at("2026-11-18T23:40:00")
        val known = CallsNow(calls = rules, contacts = listOf(mom), lastEmergencyContactAt = now - 20 * 60_000L, now = now)
        val missed = known.copy(lastEmergencyContactAt = null)
        assertEquals(RingBecause.EMERGENCY_CALLBACK, CallRules.incoming(dispatcher, known, android).because)
        // Belay didn't see the 911 call (before the first unlock, say), but Telecom says the phone is in
        // emergency callback mode: it rings.
        assertEquals(RingBecause.EMERGENCY_MODE, CallRules.incoming(dispatcher.copy(emergency = true), missed, android).because)
        // Neither: the rules refuse it (the Pixel checklist checks that the window opens before the first unlock).
        assertFalse(CallRules.incoming(dispatcher, missed, android).action == Ring.RING)
    }
}
