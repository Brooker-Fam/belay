package family.brooker.belay.core.calls

/** How the network presented an incoming caller's number. */
enum class Presentation {
    /** A number Belay can read. */
    NUMBER,

    /** No caller id: withheld (restricted), unknown, unavailable or a payphone, or no number at all. */
    WITHHELD,
}

/** The network's check of the caller's number (STIR, ATIS-1000082; Call.Details.getCallerNumberVerificationStatus). */
enum class Verification { NOT_VERIFIED, PASSED, FAILED }

/** An incoming call as Belay's rules see it. */
data class IncomingCall(
    /** The caller's number, as PhoneNumbers.key makes it (E.164 when it can be); null when withheld. */
    val number: String?,
    val presentation: Presentation,
    val verification: Verification = Verification.NOT_VERIFIED,
    /** Telecom's own time of the last emergency call, when it put one on the call (Call.EXTRA_LAST_EMERGENCY_CALLBACK_TIME_MILLIS). */
    val lastEmergencyCallAt: Long? = null,
    /**
     * Telecom marked the call as part of an emergency: the phone is in emergency callback mode
     * after an emergency call (Call.Details.PROPERTY_EMERGENCY_CALLBACK_MODE), or the network
     * identified the call as an emergency call (PROPERTY_NETWORK_IDENTIFIED_EMERGENCY_CALL).
     * Telecom itself skips call filtering for both (platform notes T18).
     */
    val emergency: Boolean = false,
)

/** What Belay does with an incoming call. Only [RING] rings: Belay plays the ringtone itself. */
enum class Ring {
    RING,

    /** Ended at once, as if declined (the network may still offer voicemail). */
    REJECT,

    /** Never rings and isn't answered, so the network sends it to voicemail. */
    VOICEMAIL,
}

/**
 * Why a call may ring, for the debug state (never the log). [EMERGENCY_CALLBACK]: it rings only
 * because of the 2-hour callback window, and [EMERGENCY_MODE] only because Telecom marked it as
 * part of an emergency (the rules would have refused either otherwise), so neither is ever sent:
 * its record would tell a parent that the kid called 911 or 988 (CallRecords).
 */
enum class RingBecause { CALLS_OFF, ALWAYS_ALLOWED, EMERGENCY_CALLBACK, EMERGENCY_MODE, PARENT, OPEN, CONTACT, RULE }

data class IncomingDecision(
    val action: Ring,
    /** Why it was refused; null when it rings. */
    val reason: WireCallReason? = null,
    /** The approved contact it's from, when it's one Belay can trust. */
    val contact: WireContact? = null,
    /** Why it rings; null when it's refused. */
    val because: RingBecause? = null,
    /** The network's check of the caller id failed: Belay treated it as a stranger's, whatever number it shows. */
    val unverified: Boolean = false,
) {
    /** It rang only because of an emergency (the window, or Telecom's mark): kept on the phone, never sent. */
    val callback: Boolean get() = because == RingBecause.EMERGENCY_CALLBACK || because == RingBecause.EMERGENCY_MODE
}

/** Whether an outgoing call may connect. */
data class OutgoingDecision(
    val allowed: Boolean,
    val contact: WireContact? = null,
    /** The number always works (an emergency number or 988): it also opens the callback window. */
    val alwaysAllowed: AlwaysAllowedKind? = null,
)

/** Everything the rules need about the phone right now, from the stored policy and Belay's own state. */
data class CallsNow(
    /** The policy's `calls`; null: Belay isn't the dialer and decides nothing. */
    val calls: WireCalls?,
    val contacts: List<WireContact> = emptyList(),
    /** The policy's blocked numbers, as PhoneNumbers.key makes them. */
    val blocked: Set<String> = emptySet(),
    /** A bedtime or school schedule is on now, as screen time's rules see it (QuietTimes). */
    val quietSchedule: Boolean = false,
    /** When the kid last called an emergency number or 988, or texted 988, as Belay saw it. */
    val lastEmergencyContactAt: Long? = null,
    val now: Long,
)

/**
 * Who rings and whom the kid can call (docs/protocol.md, "Calls rules"). Pure: the same inputs give
 * the same answer, and every case is in CallRulesTest. In order, for an incoming call:
 *
 * 1. With `calls` null, Belay isn't the dialer: everything rings.
 * 2. A caller id that failed the network's check (STIR/SHAKEN) is a stranger's, whatever number it
 *    shows: an unknown caller, no contact, no parent, and not 911 (IncomingDecision.unverified).
 * 3. 911 or another emergency number (AlwaysAllowed) rings, so a dispatcher's callback that shows
 *    one gets through. 988 doesn't call anyone (a counselor calls back from their own number), so a
 *    caller id showing 988, or its old 1-800 number, is decided like any other caller below.
 * 4. A `parent` contact rings in every mode, quiet time included.
 * 5. A number a parent blocked is rejected (Android's block list usually stops it first).
 * 6. `mode: open` lets everyone ring. `mode: contacts`: contacts with `calls` ring; callers with no
 *    caller id follow `withheld`; other callers follow `unknown` (a contact without `calls` too, with
 *    the reason `not_allowed`).
 * 7. With `quiet`, during a bedtime or school schedule, a call that would ring goes to voicemail.
 *    Quiet time never loosens: a call already refused stays refused, with its own reason.
 * 8. For 2 hours after the kid called an emergency number or 988 (or texted 988), every caller rings,
 *    withheld, blocked and unverified ones too, so a dispatcher or a counselor can call back from any
 *    number; and so does a call Telecom marked as part of an emergency (IncomingCall.emergency). A
 *    call steps 4 to 7 let ring rings for its own reason, with its contact; one they'd refuse rings
 *    because of the emergency (RingBecause.EMERGENCY_CALLBACK or EMERGENCY_MODE), and is never sent.
 */
object CallRules {
    /**
     * An incoming call whose decision takes longer than this rings anyway (calls fail open): Belay
     * plays the ringtone itself, so a slow read (the store on a cold start, the call log) would
     * otherwise leave the call silent. Call screening's own wait is the same.
     */
    const val DECIDE_WITHIN_MS = 2_000L

    fun incoming(call: IncomingCall, now: CallsNow, android: EmergencyNumbers): IncomingDecision {
        val calls = now.calls ?: return IncomingDecision(Ring.RING, because = RingBecause.CALLS_OFF)
        val number = call.number?.takeIf { call.presentation == Presentation.NUMBER }
        val unverified = call.verification == Verification.FAILED
        if (!unverified && number != null && AlwaysAllowed.kind(number, android) == AlwaysAllowedKind.EMERGENCY) {
            return IncomingDecision(Ring.RING, because = RingBecause.ALWAYS_ALLOWED)
        }
        val usual = byTheRules(number, unverified, calls, now)
        if (usual.action != Ring.RING) {
            val because = when {
                call.emergency -> RingBecause.EMERGENCY_MODE
                callbackWindow(now.lastEmergencyContactAt, call.lastEmergencyCallAt, now.now) -> RingBecause.EMERGENCY_CALLBACK
                else -> null
            }
            if (because != null) return IncomingDecision(Ring.RING, contact = usual.contact, because = because, unverified = unverified)
        }
        return usual
    }

    /** Steps 4 to 7, for a call that isn't an emergency number's. */
    private fun byTheRules(number: String?, unverified: Boolean, calls: WireCalls, now: CallsNow): IncomingDecision {
        val contact = if (unverified) null else CallContacts.find(number, now.contacts)
        val base = when {
            contact?.parent == true -> IncomingDecision(Ring.RING, contact = contact, because = RingBecause.PARENT)
            number != null && number in now.blocked -> IncomingDecision(Ring.REJECT, WireCallReason.NOT_ALLOWED, contact)
            calls.mode == WireCallMode.OPEN -> IncomingDecision(Ring.RING, contact = contact, because = RingBecause.OPEN)
            number == null -> act(calls.withheld, WireCallReason.WITHHELD, null)
            contact != null && contact.calls -> IncomingDecision(Ring.RING, contact = contact, because = RingBecause.CONTACT)
            contact != null -> act(calls.unknown, WireCallReason.NOT_ALLOWED, contact)
            else -> act(calls.unknown, WireCallReason.UNKNOWN, null)
        }
        val decided = if (base.action == Ring.RING && base.because != RingBecause.PARENT && calls.quiet && now.quietSchedule) {
            IncomingDecision(Ring.VOICEMAIL, WireCallReason.QUIET, base.contact)
        } else {
            base
        }
        return decided.copy(unverified = unverified)
    }

    /**
     * Whether the kid may call [number] (as PhoneNumbers.key makes it). Always-allowed numbers always
     * may, also with caller-id codes dialed before them ("*67 988": AlwaysAllowed.dialed), and a call
     * to one opens the callback window and is never recorded; `outgoing: any` allows any number;
     * `outgoing: contacts` allows contacts with `calls`, and parents (a parent can always be called).
     */
    fun outgoing(number: String?, now: CallsNow, android: EmergencyNumbers): OutgoingDecision {
        val always = AlwaysAllowed.dialed(number, android)
        val contact = CallContacts.find(number, now.contacts)
        val calls = now.calls ?: return OutgoingDecision(true, contact, always)
        if (always != null) return OutgoingDecision(true, contact, always)
        if (calls.outgoing == WireOutgoing.ANY) return OutgoingDecision(true, contact)
        return OutgoingDecision(contact != null && (contact.calls || contact.parent), contact)
    }

    /**
     * Within 2 hours after the kid last contacted an emergency number or 988 (Belay's own record), or
     * after the last emergency call Telecom put on the call. A time up to 2 hours ahead (the clock
     * moved back since) counts too, so the window errs toward ringing.
     */
    fun callbackWindow(lastEmergencyContactAt: Long?, lastEmergencyCallAt: Long?, now: Long): Boolean =
        listOfNotNull(lastEmergencyContactAt, lastEmergencyCallAt?.takeIf { it > 0 }).any { within(it, now) }

    /** When the window that [lastEmergencyContactAt] opened ends, while it's open at [now]. */
    fun callbackWindowEnds(lastEmergencyContactAt: Long?, now: Long): Long? {
        val at = lastEmergencyContactAt?.takeIf { within(it, now) } ?: return null
        return minOf(at, now) + CallsWireLimits.EMERGENCY_CALLBACK_MS
    }

    private fun within(at: Long, now: Long): Boolean =
        now - at < CallsWireLimits.EMERGENCY_CALLBACK_MS && at - now < CallsWireLimits.EMERGENCY_CALLBACK_MS

    private fun act(action: WireCallAction, reason: WireCallReason, contact: WireContact?): IncomingDecision = when (action) {
        WireCallAction.RING -> IncomingDecision(Ring.RING, contact = contact, because = RingBecause.RULE)
        WireCallAction.REJECT -> IncomingDecision(Ring.REJECT, reason, contact)
        WireCallAction.VOICEMAIL -> IncomingDecision(Ring.VOICEMAIL, reason, contact)
    }
}
