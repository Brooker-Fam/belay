package family.brooker.belay.core.kid

import family.brooker.belay.core.WireCaregiver
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.location.LocationRules

/** What a caregiver may see and do, as the policy names it, in the order the kid reads them. */
enum class CaregiverCan(val wire: String) {
    /** Whether the phone is online, when it last connected, its battery, and whether it's paused or on a schedule. */
    STATUS("status"),

    /** Pause the phone, or pause it and lock the screen now: only ever longer, never ending one early. */
    PAUSE("pause"),

    /** The kid's "I need help" requests, with what they write and where the phone is, if they share it. */
    HELP("help"),

    /** Check where the phone is now, while its location takes checks. */
    LOCATE("locate"),
    ;

    companion object {
        fun of(wire: String): CaregiverCan? = entries.firstOrNull { it.wire == wire }
    }
}

/** A caregiver as the kid's phone lists them: their name (cleaned), until when, and what they may do. */
data class ShownCaregiver(val name: String, val until: Long, val can: List<CaregiverCan>)

/**
 * Phase 12: the caregivers a parent gave some access to this phone (a grandparent for a weekend, a
 * babysitter, a coach on a trip), from the policy's `caregivers`, for the kid's screens: "What your
 * parent can see" (DataCategories.caregiver), Home, Help, a caregiver's pause and a caregiver's
 * check (principle 4: the kid always sees who has access). A caregiver is listed only until their
 * `until`, by the phone's own clock, even before a new policy comes. Each name is a parent's words:
 * shown as plain text, on one line, at most 40 characters. Pure.
 */
object Caregivers {
    /** A caregiver's name, as the server caps it too. */
    const val MAX_NAME = 40

    /** At most this many are listed (the server keeps at most 20). */
    const val MAX = 20

    /** For a name with nothing left once cleaned: the server never sends one, but no caregiver goes unlisted. */
    const val UNNAMED = "A caregiver"

    /**
     * Every control and format character (Unicode Cc and Cf): zero-width spaces and joiners, the
     * word joiner, direction marks, overrides and isolates, the Arabic letter mark, the byte-order
     * mark, the soft hyphen, tags. None shows, and some reorder what's around them.
     */
    private val HIDDEN = Regex("[\\p{Cc}\\p{Cf}]")

    /** A run of spaces of any kind, line and paragraph separators too (Unicode's, not only ASCII's). */
    private val SPACES = Regex("[\\s\\p{Z}]+")

    /**
     * A caregiver's name as the kid sees it: one line, without a control, invisible or format
     * character, each run of spaces one space (as the server's text.ts nameLine, the seventh
     * review's J5: so "Grand", a word joiner and "ma" is "Grandma"), at most 40 characters (never half
     * of a pair that makes one character); null when nothing is left.
     */
    fun name(raw: String?): String? {
        if (raw == null) return null
        val clean = raw.replace(SPACES, " ").replace(HIDDEN, "").replace(SPACES, " ").trim()
        var capped = clean.take(MAX_NAME)
        if (capped.isNotEmpty() && Character.isHighSurrogate(capped.last())) capped = capped.dropLast(1)
        return capped.trim().takeIf { it.isNotEmpty() }
    }

    /**
     * Who set a pause or sent a check, when the policy names a caregiver: their name, or [UNNAMED]
     * when it named one with nothing left once cleaned (never "your parent" for a caregiver's); null
     * when it names none: a parent, their AI app or the server's command line did.
     */
    fun who(raw: String?): String? = if (raw == null) null else name(raw) ?: UNNAMED

    /** The caregivers to list now (see [current]). */
    fun current(policy: WirePolicy?, now: Long): List<ShownCaregiver> =
        current(policy?.caregivers.orEmpty(), now, locateWorks = LocationRules.canLocateNow(policy?.location))

    /**
     * The caregivers to list now: those whose access hasn't ended by this phone's clock, the soonest
     * end first, then by name, at most [MAX]. What each may do comes as the policy sends it, in
     * [CaregiverCan]'s order, without words this Belay doesn't know; checking where the phone is
     * only while it answers a check ([locateWorks]), so the kid never reads more than the phone does.
     */
    fun current(caregivers: List<WireCaregiver>, now: Long, locateWorks: Boolean): List<ShownCaregiver> =
        caregivers
            .filter { it.until > now }
            .map { c ->
                val can = c.can.mapNotNull(CaregiverCan::of).distinct().sorted()
                ShownCaregiver(name(c.name) ?: UNNAMED, c.until, if (locateWorks) can else can - CaregiverCan.LOCATE)
            }
            .sortedWith(compareBy<ShownCaregiver> { it.until }.thenBy { it.name.lowercase() }.thenBy { it.name })
            .take(MAX)

    /** The caregivers who get the kid's "I need help" too, for the Help screen. */
    fun gettingHelp(shown: List<ShownCaregiver>): List<ShownCaregiver> = shown.filter { CaregiverCan.HELP in it.can }
}
