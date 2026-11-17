package family.brooker.belay.core.calls

import kotlinx.serialization.Serializable

/**
 * One call as Belay keeps it on the phone, for its recent calls and (with `calls.log`) for
 * POST /api/v1/calls. Never a call with an emergency number, 988 or a private number: those are
 * never made into a CallEntry at all (CallRecords.entry), so nothing can store or send them.
 */
@Serializable
data class CallEntry(
    /** UUID made on the phone; also the record's id on the server. */
    val id: String,
    val at: Long,
    val direction: WireCallDirection,
    /** The other side's number, as PhoneNumbers.key makes it; null when the caller withheld it. */
    val number: String? = null,
    /** The approved contact it was with, when it was one Belay could trust. */
    val contactId: String? = null,
    val durationS: Int = 0,
    val outcome: WireCallOutcome,
    /** Why Belay refused it, if it did. */
    val reason: WireCallReason? = null,
)

/** A call in Android's own call log (CallLog.Calls), as the phone reads it, for what's below. */
data class AndroidLogCall(
    val number: String?,
    val at: Long,
    /** Null for an entry Belay can't place (an external call, say). */
    val direction: WireCallDirection?,
    val durationS: Int,
    /** Android blocked it (CallLog.Calls.BLOCKED_TYPE). */
    val blocked: Boolean = false,
)

/**
 * A call with an always-allowed or private number, shown in Belay's recent calls only because
 * Android's own call log has it (and only while it does). Never stored by Belay and never sent.
 */
data class PrivateCall(val number: String, val at: Long, val direction: WireCallDirection, val durationS: Int, val kind: AlwaysAllowedKind?)

/**
 * Call records (docs/protocol.md, "Calls rules", Records): what Belay keeps on the phone, what it
 * sends with `log`, and what it may take from Android's own call log. The decisions, JVM-tested:
 * - A call with an emergency number, 988 or one of the policy's `private_numbers` is never kept or
 *   sent. On the phone, Belay's recent calls show such a call only while Android's own call log
 *   has it (the kid can delete it there), read when the screen opens and never stored.
 * - A record names the contact by id, or carries the number for a caller who isn't a contact
 *   (so a parent can approve or block them), or neither for a withheld caller.
 */
object CallRecords {
    /** Belay's own recent calls are kept 30 days, at most 500. */
    const val KEEP_MS = 30L * 24 * 60 * 60 * 1000
    const val MAX_KEPT = 500

    /** Android's call log is read this far back for the recent calls screen. */
    const val ANDROID_LOG_MS = KEEP_MS

    /** Whether a call with [number] may be kept and sent: never an emergency number, 988 or a private number. */
    fun keepable(number: String?, privateNumbers: Set<String>, android: EmergencyNumbers): Boolean {
        if (AlwaysAllowed.allows(number, android)) return false
        val key = PhoneNumbers.key(number) ?: return true
        return key !in privateNumbers
    }

    /** The entry to keep for a call that ended, or null when it must never be kept (keepable). */
    fun entry(
        id: String,
        at: Long,
        direction: WireCallDirection,
        number: String?,
        contact: WireContact?,
        durationS: Int,
        outcome: WireCallOutcome,
        reason: WireCallReason?,
        privateNumbers: Set<String>,
        android: EmergencyNumbers,
    ): CallEntry? {
        if (!keepable(number, privateNumbers, android)) return null
        return CallEntry(
            id = id,
            at = at,
            direction = direction,
            number = PhoneNumbers.key(number),
            contactId = contact?.id,
            durationS = durationS.coerceIn(0, MAX_DURATION_S),
            outcome = outcome,
            reason = reason,
        )
    }

    /**
     * [entry] for POST /api/v1/calls, or null when it must not be sent: checked again against the
     * policy's private numbers as they are now (a number made private after the call stays on the
     * phone). The number goes only for a caller who isn't a contact, and only in E.164.
     */
    fun toWire(entry: CallEntry, privateNumbers: Set<String>, android: EmergencyNumbers): WireCallRecord? {
        if (!keepable(entry.number, privateNumbers, android)) return null
        return WireCallRecord(
            id = entry.id,
            at = entry.at,
            direction = entry.direction,
            contactId = entry.contactId,
            number = if (entry.contactId == null) PhoneNumbers.e164(entry.number) else null,
            durationS = entry.durationS.coerceIn(0, MAX_DURATION_S),
            outcome = entry.outcome,
            reason = entry.reason,
        )
    }

    /** Belay's recent calls as kept: the newest [MAX_KEPT] of the last 30 days, newest first. */
    fun kept(entries: List<CallEntry>, now: Long): List<CallEntry> =
        entries.filter { now - it.at < KEEP_MS }.sortedByDescending { it.at }.take(MAX_KEPT)

    /**
     * The calls from Android's call log that Belay's recent calls may show: only those with an
     * always-allowed or private number (Belay keeps every other call itself), and not blocked ones.
     */
    fun privateCalls(log: List<AndroidLogCall>, privateNumbers: Set<String>, android: EmergencyNumbers, now: Long): List<PrivateCall> =
        log.mapNotNull { call ->
            val direction = call.direction ?: return@mapNotNull null
            if (call.blocked || now - call.at >= ANDROID_LOG_MS) return@mapNotNull null
            val number = PhoneNumbers.key(call.number) ?: return@mapNotNull null
            val kind = AlwaysAllowed.kind(number, android)
            if (kind == null && number !in privateNumbers) return@mapNotNull null
            PrivateCall(number, call.at, direction, call.durationS.coerceAtLeast(0), kind)
        }.sortedByDescending { it.at }

    /**
     * The last time the kid called an emergency number or 988, as Android's call log shows it (a
     * call Belay's dialer didn't see: the preloaded dialer or the lock screen's emergency dialer),
     * within the callback window; null when there's none.
     */
    fun lastEmergencyContact(log: List<AndroidLogCall>, android: EmergencyNumbers, now: Long): Long? =
        log.filter { it.direction == WireCallDirection.OUT && !it.blocked && CallRules.callbackWindow(it.at, null, now) }
            .filter { AlwaysAllowed.opensCallbackWindow(it.number, android) }
            .maxOfOrNull { it.at }

    /** The server takes at most a day per call (its schema's duration_s). */
    const val MAX_DURATION_S = 86_400
}
