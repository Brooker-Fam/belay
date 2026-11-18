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
     * A code dialed before a number for that one call: North America's vertical service codes
     * (`*67` hides the caller id, `*82` shows it; any `*NN` or `*NNN`) and GSM's (`#31#` hides it,
     * `*31#` shows it; any `#NN#` or `*NN#`).
     */
    private val LEADING_CODES = listOf(Regex("^\\*[0-9]{2}"), Regex("^\\*[0-9]{3}"), Regex("^\\*[0-9]{2}#"), Regex("^#[0-9]{2}#"))

    /** At most this many codes before a number are taken off. */
    private const val MAX_CODES = 3

    /**
     * What [raw] may reach once the codes dialed before it are taken off ("*67 911" reaches 911),
     * every way of reading them; empty when it starts with none. A code isn't always clear:
     * "*272911" is `*27` then 2911, or `*272` then 911, so both are listed. Belay looks at these
     * only to tell whether a call reaches a number that always works or a private one (then it
     * goes through, or isn't recorded: AlwaysAllowed.dialed, CallRecords.isPrivate), never to let
     * a call through to a contact.
     */
    fun withoutCodes(raw: String?): List<String> {
        val found = LinkedHashSet<String>()
        var level = listOf(dialable(raw))
        repeat(MAX_CODES) {
            level = level.flatMap { number ->
                LEADING_CODES.mapNotNull { code -> code.find(number)?.let { number.substring(it.value.length) } }
            }.filter { it.isNotEmpty() && found.add(it) }
        }
        return found.toList()
    }

    private fun String.substringBefore(chars: CharArray): String {
        val at = indexOfAny(chars)
        return if (at < 0) this else substring(0, at)
    }
}
