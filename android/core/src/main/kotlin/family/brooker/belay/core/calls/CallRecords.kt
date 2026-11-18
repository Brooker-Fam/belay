package family.brooker.belay.core.calls

import kotlinx.serialization.Serializable
import kotlin.math.abs

/**
 * One call as Belay keeps it on the phone, for its recent calls and (with `calls.log`) for
 * POST /api/v1/calls. Never a call with an emergency number, 988 or a private number: those are
 * never made into a CallEntry at all (CallRecords.entry), so nothing can store or send them. The
 * one exception is a caller id that failed the network's check ([unverified]), a stranger's call
 * whatever number it shows: it's kept like any unknown caller's.
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
    /**
     * It rang only because of the 2-hour callback window (RingBecause.EMERGENCY_CALLBACK): the kid
     * sees it in their recent calls, and it's never sent, because its record would tell a parent
     * that the kid called 911 or 988 (a 988 counselor calling back, say).
     */
    val callback: Boolean = false,
    /**
     * An incoming call whose caller id failed the network's check (STIR/SHAKEN): Belay treated it as
     * a stranger's, whatever number it shows, and the kid's recent calls say the number may be fake.
     * Sent without its number when that's an emergency number, 988 or a private one (CallRecords.toWire).
     */
    val unverified: Boolean = false,
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
    /** The caller withheld the number (CallLog.Calls.NUMBER_PRESENTATION other than allowed). */
    val withheld: Boolean = false,
    /**
     * What happened, as a record says it: answered, missed or declined (REJECTED_TYPE), an outgoing
     * call answered or not. Null for an entry Belay never records: a voicemail, a blocked call, one
     * answered on another device.
     */
    val outcome: WireCallOutcome? = null,
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
 *   sent, also when the kid dialed a caller-id code before it ("*67 988"). On the phone, Belay's
 *   recent calls show such a call only while Android's own call log has it (the kid can delete it
 *   there), read when the screen opens and never stored.
 * - An incoming call whose caller id failed the network's check is a stranger's: it's kept like any
 *   unknown caller's, and sent without its number when that number is one of those (the server
 *   would drop it, and the parents would never learn that a stranger called). Its record says
 *   nothing about 911, 988 or a private number: it reads like a withheld caller's.
 * - A record names the contact by id, or carries the number for a caller who isn't a contact
 *   (so a parent can approve or block them), or neither for a withheld caller. An outgoing call is
 *   kept with its number in E.164 (with any caller-id code taken off), or with the digits the kid
 *   dialed when Android can't write them so (211, a number without its area code): those are
 *   sent without the number, once they're known not to be 911, 988 or a private number.
 * - A call that rang only because of an emergency (the callback window, or Telecom's mark) is kept
 *   on the phone and never sent. The kid can remove any call from Belay's recent calls.
 */
object CallRecords {
    /** Belay's own recent calls are kept 30 days, at most 500. */
    const val KEEP_MS = 30L * 24 * 60 * 60 * 1000
    const val MAX_KEPT = 500

    /** Android's call log is read this far back for the recent calls screen. */
    const val ANDROID_LOG_MS = KEEP_MS

    /**
     * Whether a call with [number] may be kept and sent: never an emergency number, 988 or a private
     * number, also with caller-id codes before it.
     */
    fun keepable(number: String?, privateNumbers: Set<String>, android: EmergencyNumbers): Boolean =
        AlwaysAllowed.dialed(number, android) == null && !isPrivate(number, privateNumbers, android)

    /**
     * Whether [number] is one of the family's [privateNumbers] (E.164): as it is, or once the
     * caller-id codes dialed before it are taken off ("*67 555 555 0150"), written in E.164 as the
     * phone's Android writes any number it's given (EmergencyNumbers.e164). A number Android can't
     * write so counts as private when it's the last [LOCAL_DIGITS] or more digits of one: dialed
     * without its area code ("555 0150"), it may well be that number. That errs toward keeping no
     * record, never toward letting a call through: Belay matches contacts exactly (PhoneNumbers).
     */
    fun isPrivate(number: String?, privateNumbers: Set<String>, android: EmergencyNumbers): Boolean {
        if (privateNumbers.isEmpty()) return false
        val key = PhoneNumbers.key(number) ?: return false
        if (key in privateNumbers) return true
        return listOfNotNull(key, PhoneNumbers.withoutCodes(key)).any { rest ->
            val written = e164(rest, android)
            if (written != null) written in privateNumbers else endsAPrivateNumber(rest, privateNumbers)
        }
    }

    /** A number dialed without its area code has at least this many digits (North America's local numbers have 7). */
    const val LOCAL_DIGITS = 6

    private fun endsAPrivateNumber(dialed: String, privateNumbers: Set<String>): Boolean =
        dialed.length >= LOCAL_DIGITS && dialed.all(Char::isDigit) && privateNumbers.any { it.endsWith(dialed) }

    /**
     * The number an outgoing call to [number] reached, in E.164: as dialed, or with the caller-id
     * codes before it taken off; null when it can't be written so, or reads as two different numbers.
     */
    fun reached(number: String?, android: EmergencyNumbers): String? {
        val key = PhoneNumbers.key(number) ?: return null
        PhoneNumbers.e164(key)?.let { return it }
        return listOfNotNull(key, PhoneNumbers.withoutCodes(key)).mapNotNull { e164(it, android) }.distinct().singleOrNull()
    }

    private fun e164(number: String, android: EmergencyNumbers): String? =
        PhoneNumbers.e164(number) ?: try {
            android.e164(number)?.takeIf(PhoneNumbers::isE164)
        } catch (e: RuntimeException) {
            null
        }

    /**
     * The entry to keep for a call that ended, or null when it must never be kept: a call with an
     * always-allowed or private number (keepable), unless it's an incoming call whose caller id
     * failed the network's check ([unverified]: a stranger's). An outgoing call is kept with the
     * number it reached in E.164 ([reached]), or else with what the kid dialed: a short code like
     * 211, or a number without its area code, which Android can't write in E.164 (the fourth
     * review's N2). Such a call is sent without its number (toWire).
     */
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
        callback: Boolean = false,
        unverified: Boolean = false,
    ): CallEntry? {
        val spoofed = unverified && direction == WireCallDirection.IN
        if (!spoofed && !keepable(number, privateNumbers, android)) return null
        val kept = when (direction) {
            WireCallDirection.IN -> PhoneNumbers.key(number)
            WireCallDirection.OUT -> reached(number, android) ?: PhoneNumbers.key(number) ?: return null
        }
        return CallEntry(
            id = id,
            at = at,
            direction = direction,
            number = kept,
            contactId = contact?.id,
            durationS = durationS.coerceIn(0, MAX_DURATION_S),
            outcome = outcome,
            reason = reason,
            callback = callback,
            unverified = spoofed,
        )
    }

    /**
     * [entry] for POST /api/v1/calls, or null when it must not be sent: a call that rang only
     * because of an emergency, or one checked again against the policy's private numbers as they
     * are now (a number made private after the call stays on the phone). The number goes only for
     * someone who isn't a contact, only in E.164, and never when it's an always-allowed or private
     * number: then only a stranger's unverified caller id is sent at all, without it. A number
     * that isn't in E.164 (an outgoing call to 211, a number dialed without its area code) isn't
     * sent: the record says only that there was a call, when, and how long.
     */
    fun toWire(entry: CallEntry, privateNumbers: Set<String>, android: EmergencyNumbers): WireCallRecord? {
        if (entry.callback) return null
        val shielded = !keepable(entry.number, privateNumbers, android)
        if (shielded && !(entry.unverified && entry.direction == WireCallDirection.IN)) return null
        val number = if (entry.contactId == null && !shielded) PhoneNumbers.e164(entry.number) else null
        return WireCallRecord(
            id = entry.id,
            at = entry.at,
            direction = entry.direction,
            contactId = entry.contactId,
            number = number,
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
     * always-allowed or private number, also with caller-id codes before it (Belay keeps every other
     * call itself), and not blocked ones; nor one Belay keeps itself ([kept]: a stranger's
     * unverified caller id showing such a number, within [SAME_CALL_MS]).
     */
    fun privateCalls(
        log: List<AndroidLogCall>,
        privateNumbers: Set<String>,
        android: EmergencyNumbers,
        now: Long,
        kept: List<CallEntry> = emptyList(),
    ): List<PrivateCall> =
        log.mapNotNull { call ->
            val direction = call.direction ?: return@mapNotNull null
            if (call.blocked || now - call.at >= ANDROID_LOG_MS) return@mapNotNull null
            val number = PhoneNumbers.key(call.number) ?: return@mapNotNull null
            val kind = AlwaysAllowed.dialed(number, android)
            if (kind == null && !isPrivate(number, privateNumbers, android)) return@mapNotNull null
            val keptHere = kept.any { it.direction == direction && it.number == number && abs(it.at - call.at) < SAME_CALL_MS }
            if (keptHere) return@mapNotNull null
            PrivateCall(number, call.at, direction, call.durationS.coerceAtLeast(0), kind)
        }.sortedByDescending { it.at }

    /** Android's call log and Belay write a call's time a moment apart: within this, it's the same call. */
    const val SAME_CALL_MS = 60_000L

    /**
     * The last time the kid called an emergency number or 988, as Android's call log shows it (a
     * call Belay's dialer didn't see: the preloaded dialer or the lock screen's emergency dialer),
     * within the callback window; null when there's none.
     */
    fun lastEmergencyContact(log: List<AndroidLogCall>, android: EmergencyNumbers, now: Long): Long? =
        log.filter { it.direction == WireCallDirection.OUT && !it.blocked && CallRules.callbackWindow(it.at, null, now) }
            .filter { AlwaysAllowed.opensCallbackWindow(it.number, android) }
            .maxOfOrNull { it.at }

    /**
     * What [whileLocked] takes: the entries to keep (and, with `log`, send), every call log time read,
     * and the emergency times it decided callbacks by, from 2 hours before the restart to the
     * unlock (kept for a second read: CallsPlan.afterRead).
     */
    data class Taken(val entries: List<CallEntry>, val seen: List<Long>, val emergencyAt: List<Long> = emptyList())

    /**
     * Android's call log is read from this long before a restart for [whileLocked]: a call to 911 or
     * 988 then opened a window that reaches into the time the phone was locked (the fifth review's F1).
     */
    fun spellReadFrom(bootAt: Long): Long = bootAt - CallsWireLimits.EMERGENCY_CALLBACK_MS

    /**
     * The fourth review's N1: the calls Android's own log has from while Belay couldn't decide any,
     * from the restart ([from]) to about the unlock ([until]). Before the first unlock after a
     * restart Telecom gives every call to the phone's own app, and logs it in the call log's
     * direct-boot copy, which Android moves into the call log at the unlock (platform notes T19,
     * T22). Each is kept, and sent with `log`, like a call Belay decided and by the same rules:
     * never one with 911, an emergency number, 988 or a private number, and never sent when it rang
     * only because of an emergency: the family's [rules] would have refused it, and the callback
     * window was open then ([emergencyAt]: Belay's record from before the restart, the time kept
     * before the unlock, and the times an earlier read of the spell decided by; and calls to those
     * numbers in the log itself, which is read from 2 hours before the restart, [spellReadFrom],
     * so a call to 988 just before it counts). Its outcome is what
     * happened in the phone's own app (answered, missed, declined), with no reason: Belay refused
     * nothing. Never one Belay keeps itself ([kept]: the same way and number, within the call's
     * time), or one read before ([seen]), so no call is taken twice, nor one the kid removed.
     */
    fun whileLocked(
        log: List<AndroidLogCall>,
        from: Long,
        until: Long,
        seen: Collection<Long>,
        kept: List<CallEntry>,
        rules: CallsNow,
        quietAt: (Long) -> Boolean,
        emergencyAt: List<Long>,
        privateNumbers: Set<String>,
        android: EmergencyNumbers,
        newId: () -> String,
    ): Taken {
        val spell = log.filter { it.at in from..until }.sortedBy { it.at }
        // A call to 911 or 988 from 2 hours before the restart to the unlock opened a window into it.
        val reach = spellReadFrom(from)..until
        val called = log.filter { it.at in reach && it.direction == WireCallDirection.OUT && !it.blocked && AlwaysAllowed.opensCallbackWindow(it.number, android) }
        val emergencies = (emergencyAt + called.map { it.at }).distinct().sorted()
        val taken = mutableListOf<CallEntry>()
        for (call in spell) {
            if (call.at in seen || call.blocked) continue
            val direction = call.direction ?: continue
            val outcome = call.outcome ?: continue
            val number = if (call.withheld) null else PhoneNumbers.key(call.number, android)
            val callback = direction == WireCallDirection.IN && CallRules.incoming(
                IncomingCall(number, if (number == null) Presentation.WITHHELD else Presentation.NUMBER),
                rules.copy(
                    quietSchedule = quietAt(call.at),
                    lastEmergencyContactAt = emergencies.filter { CallRules.callbackWindow(it, null, call.at) }.maxOrNull(),
                    now = call.at,
                ),
                android,
            ).callback
            val contact = CallContacts.find(number, rules.contacts)
            val entry = entry(newId(), call.at, direction, number, contact, call.durationS, outcome, null, privateNumbers, android, callback = callback) ?: continue
            if ((kept + taken).any { sameCall(it, entry, call.durationS) }) continue
            taken += entry
        }
        return Taken(taken, (seen + spell.map { it.at }).distinct().takeLast(MAX_KEPT), emergencies.filter { it in reach })
    }

    /** [mine] (Belay's own) and [logged] (from Android's log, lasting [durationS]) are the same call. */
    private fun sameCall(mine: CallEntry, logged: CallEntry, durationS: Int): Boolean =
        mine.direction == logged.direction && mine.number == logged.number &&
            mine.at in (logged.at - SAME_CALL_MS)..(logged.at + durationS.coerceAtLeast(0) * 1000L + SAME_CALL_MS)

    /** The server takes at most a day per call (its schema's duration_s). */
    const val MAX_DURATION_S = 86_400
}
