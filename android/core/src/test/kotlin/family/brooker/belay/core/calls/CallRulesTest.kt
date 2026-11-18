package family.brooker.belay.core.calls

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up contacts and numbers only (555-01xx). */
class CallRulesTest {
    private val android = EmergencyNumbers { it in setOf("911", "112") }

    private val mom = WireContact("c-mom", "Mom", listOf("+15555550100"), calls = true, parent = true)
    private val dadNoCalls = WireContact("c-dad", "Dad", listOf("+15555550101"), calls = false, parent = true)
    private val sam = WireContact("c-sam", "Sam", listOf("+15555550123", "+15555550125"), calls = true)
    private val riley = WireContact("c-riley", "Riley", listOf("+15555550124"), calls = false)
    private val contacts = listOf(mom, dadNoCalls, sam, riley)
    private val blocked = setOf("+15555550177")

    /** A caller in the table: who it is, and what the rules should know about it. */
    private data class Caller(
        val name: String,
        val call: IncomingCall,
        val always: Boolean = false,
        val parent: Boolean = false,
        val contact: WireContact? = null,
        val blocked: Boolean = false,
    )

    private fun number(n: String, verification: Verification = Verification.NOT_VERIFIED) = IncomingCall(n, Presentation.NUMBER, verification)

    private val callers = listOf(
        Caller("911", number("911"), always = true),
        Caller("911, verified", number("911", Verification.PASSED), always = true),
        Caller("112 (Android's)", number("112"), always = true),
        // 988 doesn't call anyone (a counselor calls back from their own number): a caller id showing
        // it, or its old number, is decided like any other caller.
        Caller("988", number("988")),
        Caller("988's old number", number("+18002738255")),
        Caller("mom", number("+15555550100"), parent = true, contact = mom),
        Caller("dad, a parent without calls", number("+15555550101"), parent = true, contact = dadNoCalls),
        Caller("mom, verification passed", number("+15555550100", Verification.PASSED), parent = true, contact = mom),
        Caller("sam", number("+15555550123"), contact = sam),
        Caller("sam's other number", number("+15555550125"), contact = sam),
        Caller("riley, a contact without calls", number("+15555550124"), contact = riley),
        Caller("a stranger", number("+15555550199")),
        Caller("a blocked stranger", number("+15555550177"), blocked = true),
        Caller("a withheld caller", IncomingCall(null, Presentation.WITHHELD)),
        Caller("a payphone with a number shown anyway", IncomingCall("+15555550123", Presentation.WITHHELD)),
        // A number that failed the network's check counts as unknown, even a contact's, a parent's or 911.
        Caller("mom's number, spoofed", number("+15555550100", Verification.FAILED)),
        Caller("sam's number, spoofed", number("+15555550123", Verification.FAILED)),
        Caller("911, spoofed", number("911", Verification.FAILED)),
        Caller("988, spoofed", number("988", Verification.FAILED)),
        Caller("988's old number, spoofed", number("+18002738255", Verification.FAILED)),
        Caller("a blocked number, spoofed", number("+15555550177", Verification.FAILED), blocked = true),
        // Telecom marked the call as part of an emergency (emergency callback mode, or the network
        // identified it as an emergency call): it rings whatever the rules say, like the window.
        Caller("a stranger, in emergency callback mode", number("+15555550199").copy(emergency = true)),
        Caller("a withheld caller the network identified as an emergency call", IncomingCall(null, Presentation.WITHHELD, emergency = true)),
        Caller("sam, in emergency callback mode", number("+15555550123").copy(emergency = true), contact = sam),
    )

    private val modes = WireCallMode.entries
    private val actions = WireCallAction.entries

    private fun Ring.of(action: WireCallAction) = when (action) {
        WireCallAction.RING -> Ring.RING
        WireCallAction.REJECT -> Ring.REJECT
        WireCallAction.VOICEMAIL -> Ring.VOICEMAIL
    }

    /** The protocol's "Calls rules", written out on their own: what each combination should do. */
    private fun expected(c: Caller, calls: WireCalls, quietNow: Boolean, window: Boolean): Pair<Ring, WireCallReason?> {
        if (c.always) return Ring.RING to null
        if (window || c.call.emergency) return Ring.RING to null
        if (c.parent) return Ring.RING to null
        if (c.blocked) return Ring.REJECT to WireCallReason.NOT_ALLOWED
        val withheld = c.call.presentation == Presentation.WITHHELD
        val (action, reason) = when {
            calls.mode == WireCallMode.OPEN -> Ring.RING to null
            withheld -> Ring.RING.of(calls.withheld) to WireCallReason.WITHHELD
            c.contact != null && c.contact.calls -> Ring.RING to null
            c.contact != null -> Ring.RING.of(calls.unknown) to WireCallReason.NOT_ALLOWED
            else -> Ring.RING.of(calls.unknown) to WireCallReason.UNKNOWN
        }
        if (action == Ring.RING) return if (calls.quiet && quietNow) Ring.VOICEMAIL to WireCallReason.QUIET else Ring.RING to null
        return action to reason
    }

    private fun now(calls: WireCalls?, quietNow: Boolean = false, window: Boolean = false) = CallsNow(
        calls = calls,
        contacts = contacts,
        blocked = blocked,
        quietSchedule = quietNow,
        lastEmergencyContactAt = if (window) T0 - HOUR else null,
        now = T0,
    )

    @Test
    fun `every mode, unknown, withheld, quiet, callback window, parent and blocked combination`() {
        var cases = 0
        for (mode in modes) for (unknown in actions) for (withheld in actions) for (quiet in listOf(false, true)) {
            val calls = WireCalls(mode = mode, unknown = unknown, withheld = withheld, quiet = quiet)
            for (quietNow in listOf(false, true)) for (window in listOf(false, true)) for (caller in callers) {
                val decision = CallRules.incoming(caller.call, now(calls, quietNow, window), android)
                val (action, reason) = expected(caller, calls, quietNow, window)
                val what = "${caller.name} with $calls, quiet now $quietNow, callback window $window"
                assertEquals(action, decision.action, what)
                assertEquals(reason, decision.reason, what)
                assertEquals(caller.contact, decision.contact, what)
                if (decision.action == Ring.RING) assertTrue(decision.because != null && decision.reason == null, what)
                // Only a call the rules would refuse rings because of an emergency (and is never sent):
                // Telecom's mark first, else the window.
                val ordinary = caller.copy(call = caller.call.copy(emergency = false))
                val refusedOtherwise = !caller.always && expected(ordinary, calls, quietNow, window = false).first != Ring.RING
                val because = when {
                    refusedOtherwise && caller.call.emergency -> RingBecause.EMERGENCY_MODE
                    refusedOtherwise && window -> RingBecause.EMERGENCY_CALLBACK
                    else -> null
                }
                if (because != null) assertEquals(because, decision.because, what)
                assertEquals(because != null, decision.callback, what)
                // A caller id that failed the network's check is always decided as a stranger's.
                assertEquals(caller.call.verification == Verification.FAILED, decision.unverified, what)
                cases++
            }
        }
        assertEquals(2 * 3 * 3 * 2 * 2 * 2 * callers.size, cases)
    }

    @Test
    fun `911 and Android's emergency numbers ring under the strictest rules there are, and the kid can always call them and 988`() {
        val strict = WireCalls(WireCallMode.CONTACTS, WireCallAction.REJECT, WireCallAction.REJECT, WireOutgoing.CONTACTS, quiet = true, log = true)
        // Even if a broken policy listed them as blocked, which Belay never puts on the block list either.
        val now = CallsNow(strict, contacts = emptyList(), blocked = setOf("911", "988", "112"), quietSchedule = true, now = T0)
        for (n in listOf("911", "112", "9-1-1", "(911)")) {
            for (verification in listOf(Verification.NOT_VERIFIED, Verification.PASSED)) {
                val decision = CallRules.incoming(number(n, verification), now, android)
                assertEquals(IncomingDecision(Ring.RING, because = RingBecause.ALWAYS_ALLOWED), decision, "$n, $verification")
            }
        }
        for (n in listOf("911", "988", "112", "9-1-1", "(988)", "+18002738255", "1-800-273-8255")) {
            assertTrue(CallRules.outgoing(n, now, android).allowed, n)
            assertTrue(CallRules.outgoing(n, now, android).alwaysAllowed != null, n)
        }
    }

    @Test
    fun `a caller id showing 911 or 988 that failed the network's check is a stranger's, and 988 is decided like any caller`() {
        // Contacts only, strangers refused, quiet time at bedtime: a stranger spoofing an always-allowed
        // number at 1:30 AM. The same stranger from their own number is refused too.
        val strict = WireCalls(WireCallMode.CONTACTS, WireCallAction.REJECT, WireCallAction.REJECT, quiet = true, log = true)
        val bedtime = CallsNow(strict, contacts = contacts, blocked = blocked, quietSchedule = true, now = T0)
        for (shown in listOf("+18002738255", "988", "911", "112")) {
            val spoofed = CallRules.incoming(number(shown, Verification.FAILED), bedtime, android)
            assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.UNKNOWN, unverified = true), spoofed, shown)
            assertFalse(spoofed.callback, shown)
        }
        assertEquals(Ring.REJECT, CallRules.incoming(number("+15555550166"), bedtime, android).action)
        // A caller id showing 988 or its old number, unchecked or checked: the rules apply.
        for (shown in listOf("988", "+18002738255")) {
            for (verification in listOf(Verification.NOT_VERIFIED, Verification.PASSED)) {
                assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.UNKNOWN), CallRules.incoming(number(shown, verification), bedtime, android), "$shown $verification")
            }
            assertEquals(Ring.RING, CallRules.incoming(number(shown), now(WireCalls(WireCallMode.OPEN)), android).action, "open: everyone rings")
        }
        // 911 that didn't fail the check still always rings: a dispatcher's callback can show it.
        assertEquals(RingBecause.ALWAYS_ALLOWED, CallRules.incoming(number("911"), bedtime, android).because)
        // During the callback window everyone rings, a spoofed caller id too (and it's never sent).
        val window = bedtime.copy(lastEmergencyContactAt = T0 - HOUR)
        for (shown in listOf("911", "988", "+15555550100")) {
            val decision = CallRules.incoming(number(shown, Verification.FAILED), window, android)
            assertEquals(IncomingDecision(Ring.RING, because = RingBecause.EMERGENCY_CALLBACK, unverified = true), decision, shown)
        }
    }

    @Test
    fun `a call Telecom marks as part of an emergency always rings, and is never sent`() {
        // The phone is in emergency callback mode after a 911 call Belay didn't see (the lock screen,
        // before the first unlock): the dispatcher's callback, from a number that isn't a contact.
        val strict = WireCalls(WireCallMode.CONTACTS, WireCallAction.REJECT, WireCallAction.REJECT, quiet = true)
        val bedtime = CallsNow(strict, contacts = contacts, blocked = blocked, quietSchedule = true, now = T0)
        val dispatcher = number("+15555550160").copy(emergency = true)
        assertEquals(IncomingDecision(Ring.RING, because = RingBecause.EMERGENCY_MODE), CallRules.incoming(dispatcher, bedtime, android))
        assertTrue(CallRules.incoming(dispatcher, bedtime, android).callback)
        // Withheld, blocked, unverified: it rings all the same.
        for (call in listOf(IncomingCall(null, Presentation.WITHHELD, emergency = true), number("+15555550177").copy(emergency = true), number("+15555550160", Verification.FAILED).copy(emergency = true))) {
            assertEquals(RingBecause.EMERGENCY_MODE, CallRules.incoming(call, bedtime, android).because, "$call")
        }
        // Without the mark, the same caller is refused.
        assertEquals(Ring.REJECT, CallRules.incoming(dispatcher.copy(emergency = false), bedtime, android).action)
        // A parent rings for being a parent; a contact quiet time would send to voicemail rings for the mark.
        assertEquals(IncomingDecision(Ring.RING, contact = mom, because = RingBecause.PARENT), CallRules.incoming(number("+15555550100").copy(emergency = true), bedtime, android))
        assertEquals(IncomingDecision(Ring.RING, contact = sam, because = RingBecause.EMERGENCY_MODE), CallRules.incoming(number("+15555550123").copy(emergency = true), bedtime, android))
    }

    @Test
    fun `a few rows of the table, as the family would read them`() {
        val contactsOnly = WireCalls(WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.VOICEMAIL)
        fun decide(caller: IncomingCall, calls: WireCalls = contactsOnly, quietNow: Boolean = false) = CallRules.incoming(caller, now(calls, quietNow), android)
        assertEquals(IncomingDecision(Ring.RING, contact = sam, because = RingBecause.CONTACT), decide(number("+15555550123")))
        assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.UNKNOWN), decide(number("+15555550199")))
        assertEquals(IncomingDecision(Ring.VOICEMAIL, WireCallReason.WITHHELD), decide(IncomingCall(null, Presentation.WITHHELD)))
        assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.NOT_ALLOWED, riley), decide(number("+15555550124")))
        assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.UNKNOWN, unverified = true), decide(number("+15555550123", Verification.FAILED)))
        assertEquals(IncomingDecision(Ring.RING, contact = mom, because = RingBecause.PARENT), decide(number("+15555550100"), contactsOnly.copy(quiet = true), quietNow = true))
        assertEquals(IncomingDecision(Ring.VOICEMAIL, WireCallReason.QUIET, sam), decide(number("+15555550123"), contactsOnly.copy(quiet = true), quietNow = true))
        // Quiet time never loosens: a stranger stays rejected, for being unknown.
        assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.UNKNOWN), decide(number("+15555550199"), contactsOnly.copy(quiet = true), quietNow = true))
        // Open: everyone rings, withheld callers too; a blocked number doesn't.
        val open = WireCalls(WireCallMode.OPEN, withheld = WireCallAction.REJECT)
        assertEquals(Ring.RING, decide(IncomingCall(null, Presentation.WITHHELD), open).action)
        assertEquals(Ring.RING, decide(number("+15555550199"), open).action)
        assertEquals(IncomingDecision(Ring.REJECT, WireCallReason.NOT_ALLOWED), decide(number("+15555550177"), open))
        // Calls off: Belay isn't the dialer and refuses nothing.
        assertEquals(IncomingDecision(Ring.RING, because = RingBecause.CALLS_OFF), CallRules.incoming(number("+15555550177"), now(null), android))
    }

    @Test
    fun `the callback window, 2 hours after an emergency number or 988, every caller rings`() {
        val strict = WireCalls(WireCallMode.CONTACTS, WireCallAction.REJECT, WireCallAction.REJECT, quiet = true)
        fun decide(caller: IncomingCall, last: Long?) =
            CallRules.incoming(caller, CallsNow(strict, contacts, blocked, quietSchedule = true, lastEmergencyContactAt = last, now = T0), android)
        val strangers = listOf(number("+15555550199"), IncomingCall(null, Presentation.WITHHELD), number("+15555550177"), number("+15555550100", Verification.FAILED))
        for (caller in strangers) {
            assertEquals(RingBecause.EMERGENCY_CALLBACK, decide(caller, T0 - 1).because, "$caller just after")
            assertEquals(RingBecause.EMERGENCY_CALLBACK, decide(caller, T0 - 2 * HOUR + 1).because, "$caller at the end")
            assertEquals(Ring.REJECT, decide(caller, T0 - 2 * HOUR).action, "$caller once it's over")
            assertEquals(Ring.REJECT, decide(caller, null).action, "$caller without one")
        }
        // Telecom's own time of the last emergency call opens it too.
        val withExtra = number("+15555550199").copy(lastEmergencyCallAt = T0 - 30 * 60_000)
        assertEquals(RingBecause.EMERGENCY_CALLBACK, decide(withExtra, null).because)
        assertEquals(Ring.REJECT, decide(number("+15555550199").copy(lastEmergencyCallAt = 0), null).action)
        // A call that would ring anyway rings for its own reason, with its contact, so its record
        // looks like any other; a contact the quiet time would send to voicemail rings for the window.
        assertEquals(IncomingDecision(Ring.RING, contact = mom, because = RingBecause.PARENT), decide(number("+15555550100"), T0 - 1))
        assertEquals(IncomingDecision(Ring.RING, contact = sam, because = RingBecause.EMERGENCY_CALLBACK), decide(number("+15555550123"), T0 - 1))
        val open = CallsNow(WireCalls(WireCallMode.OPEN), contacts, blocked, lastEmergencyContactAt = T0 - 1, now = T0)
        assertEquals(IncomingDecision(Ring.RING, contact = sam, because = RingBecause.OPEN), CallRules.incoming(number("+15555550123"), open, android))
        assertEquals(IncomingDecision(Ring.RING, because = RingBecause.OPEN), CallRules.incoming(number("+15555550199"), open, android))
    }

    @Test
    fun `the window survives a clock moved back a little, and ends`() {
        assertTrue(CallRules.callbackWindow(T0 + HOUR, null, T0), "an hour ahead: the clock moved back")
        assertFalse(CallRules.callbackWindow(T0 + 3 * HOUR, null, T0), "far ahead doesn't hold it open")
        assertEquals(T0 - HOUR + 2 * HOUR, CallRules.callbackWindowEnds(T0 - HOUR, T0))
        assertEquals(T0 + 2 * HOUR, CallRules.callbackWindowEnds(T0 + HOUR, T0), "from now, when the time is ahead")
        assertNull(CallRules.callbackWindowEnds(T0 - 2 * HOUR, T0))
        assertNull(CallRules.callbackWindowEnds(null, T0))
    }

    @Test
    fun `outgoing, contacts allows contacts with calls, parents and the always-allowed numbers`() {
        val contactsOnly = WireCalls(mode = WireCallMode.CONTACTS, outgoing = WireOutgoing.CONTACTS)
        val now = now(contactsOnly)
        assertEquals(OutgoingDecision(true, sam), CallRules.outgoing("+15555550123", now, android))
        assertEquals(OutgoingDecision(true, sam), CallRules.outgoing("+1 555-555-0125", now, android))
        assertEquals(OutgoingDecision(true, mom), CallRules.outgoing("+15555550100", now, android))
        assertEquals(OutgoingDecision(true, dadNoCalls), CallRules.outgoing("+15555550101", now, android), "a parent can always be called")
        assertEquals(OutgoingDecision(false, riley), CallRules.outgoing("+15555550124", now, android))
        assertEquals(OutgoingDecision(false), CallRules.outgoing("+15555550199", now, android))
        assertEquals(OutgoingDecision(false), CallRules.outgoing(null, now, android))
        assertEquals(OutgoingDecision(true, alwaysAllowed = AlwaysAllowedKind.EMERGENCY), CallRules.outgoing("911", now, android))
        assertEquals(OutgoingDecision(true, alwaysAllowed = AlwaysAllowedKind.CRISIS_988), CallRules.outgoing("988", now, android))
        assertEquals(OutgoingDecision(true, alwaysAllowed = AlwaysAllowedKind.EMERGENCY), CallRules.outgoing("112", now, android))
    }

    @Test
    fun `outgoing, any allows any number, and calls off allows everything`() {
        val any = now(WireCalls(mode = WireCallMode.CONTACTS, outgoing = WireOutgoing.ANY))
        for (n in listOf("+15555550199", "+15555550124", "+15555550177", "5550199")) assertTrue(CallRules.outgoing(n, any, android).allowed, n)
        assertTrue(CallRules.outgoing("+15555550199", now(null), android).allowed)
        assertEquals(AlwaysAllowedKind.CRISIS_988, CallRules.outgoing("988", any, android).alwaysAllowed)
    }

    @Test
    fun `911 and 988 dialed with a caller-id code before them always go through, and open the window`() {
        val contactsOnly = now(WireCalls(mode = WireCallMode.CONTACTS, outgoing = WireOutgoing.CONTACTS))
        val any = now(WireCalls(outgoing = WireOutgoing.ANY))
        val emergency = listOf("*67911", "*67 911", "*82911", "#31#911", "*31#911", "*67#911", "*67112", "*272911", "*67*82911")
        val crisis = listOf("*67988", "*67 988", "#31#988", "*82988", "*31#988", "*67 1-800-273-8255", "*6718002738255", "#31#+18002738255")
        for (now in listOf(contactsOnly, any, now(null))) {
            emergency.forEach { assertEquals(OutgoingDecision(true, alwaysAllowed = AlwaysAllowedKind.EMERGENCY), CallRules.outgoing(PhoneNumbers.key(it), now, android), it) }
            crisis.forEach { assertEquals(OutgoingDecision(true, alwaysAllowed = AlwaysAllowedKind.CRISIS_988), CallRules.outgoing(PhoneNumbers.key(it), now, android), it) }
        }
        // A code before an ordinary number doesn't make it allowed: Belay takes codes off only to see
        // a number that always works, never to match a contact.
        assertEquals(OutgoingDecision(false), CallRules.outgoing("*675555550199", contactsOnly, android))
        assertEquals(OutgoingDecision(false), CallRules.outgoing("*67+15555550123", contactsOnly, android))
        assertEquals(OutgoingDecision(true), CallRules.outgoing("*675555550199", any, android))
        // Not an emergency number with digits after it, or a code that isn't one.
        for (n in listOf("*679115", "**67911", "*6", "*67", "#31#", "*6791")) assertFalse(CallRules.outgoing(n, contactsOnly, android).allowed, n)
    }
}
