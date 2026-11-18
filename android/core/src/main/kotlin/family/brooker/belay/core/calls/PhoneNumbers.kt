package family.brooker.belay.core.calls

/**
 * Phone numbers as Belay compares them. The policy's numbers are E.164 ("+15555550100"); a call's
 * number is whatever the network presented, which the phone turns into E.164 with Android's own
 * formatter (PhoneNumberUtils.formatNumberToE164, with the phone's country) before anything here
 * compares it. Matching is exact on E.164: a looser match (the last seven digits, say) could let a
 * stranger's number pass for a contact's.
 */
object PhoneNumbers {
    private val E164 = Regex("^\\+[1-9][0-9]{6,14}$")

    /** Characters that end the number Android dials: what follows is post-dial (pauses, waits, extensions). */
    private val POST_DIAL = charArrayOf(',', ';', 'p', 'P', 'w', 'W')

    /**
     * What Android dials from [raw]: digits, `+`, `*` and `#`, without spaces, dashes, dots or
     * brackets, and without post-dial digits. "" for null or nothing dialable.
     */
    fun dialable(raw: String?): String {
        if (raw == null) return ""
        val number = raw.substringBefore(POST_DIAL)
        return number.filter { it in '0'..'9' || it == '+' || it == '*' || it == '#' }
            // A '+' only counts at the start.
            .let { if (it.startsWith('+')) "+" + it.drop(1).filter { c -> c != '+' } else it.filter { c -> c != '+' } }
    }

    /** E.164 when [raw] is written internationally ("+1 (555) 555-0100"); null otherwise. */
    fun e164(raw: String?): String? = dialable(raw).takeIf { E164.matches(it) }

    /** Whether [number] is E.164, as the protocol and the server's schemas write it. */
    fun isE164(number: String?): Boolean = number != null && E164.matches(number)

    /** The form Belay compares: E.164 when it can be, else what Android dials; null when nothing is left. */
    fun key(raw: String?): String? = e164(raw) ?: dialable(raw).takeIf { it.isNotEmpty() }

    /**
     * The codes dialed before a number that hide or show the caller's number for that one call,
     * the only ones Android's own code reads so (platform notes T17): North America's `*67`
     * (hide) and `*82` (show), which telephony's MMI readers turn into GSM's `#31#` (hide) and
     * `*31#` (show), TS 22.030's CLIR. No other code comes off: a three-digit one, or a two-digit
     * one Belay doesn't know, could swallow a digit of the number ("*67 1911" isn't 911).
     */
    private val CALLER_ID_CODES = listOf("*67", "*82", "#31#", "*31#")

    /**
     * A string that starts with a TS 22.030 supplementary service code (an action, a two- or
     * three-digit service code, up to four `*` parts, then `#`), as telephony's GSM and IMS
     * readers match one (GsmMmiCode.sPatternSuppService): Android reads it as that code, not as
     * a number to dial. `#31#` and `*31#` are such codes, and Android dials the number after them;
     * `*67` and `*82` aren't, unless what follows makes them one ("*67#", "*67*31#").
     */
    private val SUPPLEMENTARY_SERVICE = Regex("^(\\*|#|\\*#|\\*\\*|##)[0-9]{2,3}(\\*[^*#]*){0,4}#")

    /**
     * What [raw] reaches once the caller-id codes dialed before it are taken off, one or more of
     * them ("*67 911" and "*67 #31# 911" reach 911); null when it starts with none, or nothing
     * follows them. One reading only: `*67` or `*82` stays when what follows makes the string
     * another code (then Android reads that code, not a call), and so does every code after it.
     * Belay looks at this only to tell whether a call reaches a number that always works or a
     * private one (then it goes through, or isn't recorded: AlwaysAllowed.dialed,
     * CallRecords.isPrivate), never to let a call through to a contact.
     */
    fun withoutCodes(raw: String?): String? {
        var rest = dialable(raw)
        var taken = 0
        while (true) {
            val code = CALLER_ID_CODES.firstOrNull { rest.startsWith(it) } ?: break
            if (code.startsWith('*') && !code.endsWith('#') && SUPPLEMENTARY_SERVICE.containsMatchIn(rest)) break
            rest = rest.substring(code.length)
            taken++
        }
        return rest.takeIf { taken > 0 && it.isNotEmpty() }
    }

    private fun String.substringBefore(chars: CharArray): String {
        val at = indexOfAny(chars)
        return if (at < 0) this else substring(0, at)
    }
}
