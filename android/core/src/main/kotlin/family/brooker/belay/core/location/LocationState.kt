package family.brooker.belay.core.location

import kotlinx.serialization.Serializable

/**
 * A fix Belay wants, kept until a fix (or a failure) answers it, across restarts: one for each
 * `locate_now` command, the periodic one, lost mode's, and the one a kid shares with a help
 * request. A fix taken for several wants answers each with its own id.
 */
@Serializable
data class FixWant(
    val reason: WireFixReason,
    /** When Belay first wanted it. */
    val since: Long,
    /** locate_now: the command it answers. */
    val commandId: String? = null,
    /** locate_now: the AI app a parent used, by its name (untrusted, shown to the kid as a name). */
    val via: String? = null,
    /** help: the request the fix goes in. */
    val requestId: String? = null,
    /** Phase 12, locate_now: the caregiver who sent it, by their name (kid.Caregivers.who); never with [via]. */
    val caregiver: String? = null,
) {
    /** Each command, each help request, lost mode and periodic mode want at most one fix at a time. */
    val key: String
        get() = when {
            commandId != null -> "command:$commandId"
            requestId != null -> "help:$requestId"
            reason == WireFixReason.LOST -> "lost"
            else -> "periodic"
        }
}

/** Lost mode as Belay applied it, for the `lost.since` it's for. */
@Serializable
data class LostApplied(
    val since: Long,
    /** The message Belay put on the lock screen; null before it did. */
    val message: String? = null,
    /** The screen was locked once for this lost mode. */
    val locked: Boolean = false,
    /** Fixes sent in this lost mode, for the kid's list. */
    val fixes: Int = 0,
    val lastFixAt: Long? = null,
)

/**
 * The kid chose to share where the phone is with help request [requestId] while the family has
 * location off: Belay holds location (by policy) for that one fix, and denies it again once the
 * fix is done and Belay's screens are closed (Android restarts Belay when it loses a permission,
 * which would close the help screen; platform notes L7).
 */
@Serializable
data class HelpShare(
    val requestId: String,
    val at: Long,
    /** The fix came, or failed: the grant can go. */
    val done: Boolean = false,
)

/** Why Belay turned the phone's location on itself, so it turns it back off when that ends. */
@Serializable
enum class TurnedOnFor { LOST, HELP }

/**
 * What the phone keeps for location between steps (one Room row, as JSON): where each place
 * stands, the last fix (for the next one near a place's edge, and the report), when Belay last
 * tried, the fixes it still wants, lost mode as applied, a help fix's grant, and what failed last.
 * No history of fixes: they go to the server and leave the phone.
 */
@Serializable
data class LocationState(
    val places: Map<String, PlaceTrack> = emptyMap(),
    val last: PlaceFix? = null,
    val periodicTriedAt: Long? = null,
    val lostTriedAt: Long? = null,
    val wants: List<FixWant> = emptyList(),
    val lost: LostApplied? = null,
    val help: HelpShare? = null,
    val turnedOn: Set<TurnedOnFor> = emptySet(),
    /** Belay's own words for what failed last, for `enforcement.location.problem`; null once a fix worked. */
    val problem: String? = null,
    /** `enforcement.location` as the last step saw it; null while location is off. */
    val report: WireLocationStatus? = null,
)

/** What the collector read: one location, or nothing. */
data class FixReading(
    /** The fix's own time. */
    val at: Long,
    val lat: Double,
    val lng: Double,
    /** Meters, rounded up; 0 when the provider gave none. */
    val accuracyM: Int,
    val provider: WireLocationProvider,
    val mock: Boolean,
)

/**
 * One line of "What Belay told your parent" (Phase 7): a check a parent asked for (`locate_now`),
 * a lost mode (all its fixes on one line), or a fix the kid shared with a help request. From the
 * phone's own record of what it ran, so it can't leave one out. Kept 30 days.
 */
@Serializable
data class ToldEntry(
    /** The command's id, "lost:<since>" or "help:<request id>". */
    val id: String,
    val kind: ToldKind,
    val at: Long,
    /** The AI app a parent used, by its name; null when a parent asked on the parent page. */
    val via: String? = null,
    /** Where the phone was went to the parent's Belay server. */
    val sent: Boolean,
    /** Belay's own words when it didn't. */
    val problem: String? = null,
    /** Lost mode: how many fixes it sent, and when the last one was. */
    val count: Int = 0,
    val lastAt: Long? = null,
    /** Phase 12: a check a caregiver sent, by their name ("Grandma checked where this phone is"); never with [via]. */
    val caregiver: String? = null,
)

@Serializable
enum class ToldKind {
    /** A parent (or their AI app, or Phase 12's caregiver) asked where the phone is. */
    CHECK,

    /** Lost mode: where the phone is, every 5 minutes. */
    LOST,

    /** The kid shared where the phone is with "I need help". */
    HELP,
}
