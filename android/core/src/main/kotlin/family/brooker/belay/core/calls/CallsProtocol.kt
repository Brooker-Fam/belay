package family.brooker.belay.core.calls

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Phase 5's calls half of the device API (docs/protocol.md, "Calls rules"), with core/Protocol.kt's
// conventions: snake_case names, and every policy field defaults to changing nothing. Protocol.kt's
// WirePolicy (calls, contacts), WireEnforcement (calls) and WireRequest (`contact`) carry these;
// server/src/device/schemas.ts mirrors them. 911, Android's emergency numbers and 988 are always
// allowed in code (AlwaysAllowed), never in the policy, so no policy or server bug can remove them.

@Serializable
enum class WireCallMode {
    /** Everyone may ring. */
    @SerialName("open") OPEN,

    /** Approved contacts with `calls` ring; others follow `unknown` and `withheld`. */
    @SerialName("contacts") CONTACTS,
}

@Serializable
enum class WireCallAction {
    @SerialName("reject") REJECT,
    @SerialName("voicemail") VOICEMAIL,
    @SerialName("ring") RING,
}

@Serializable
enum class WireOutgoing {
    /** Only approved contacts with `calls`, plus the always-allowed numbers. */
    @SerialName("contacts") CONTACTS,
    @SerialName("any") ANY,
}

/** The policy's `calls`. Null: Belay isn't the dialer, and nothing about calls changes. */
@Serializable
data class WireCalls(
    val mode: WireCallMode = WireCallMode.OPEN,
    /** With mode `contacts`: callers whose number isn't an approved contact's. */
    val unknown: WireCallAction = WireCallAction.RING,
    /** Callers with no caller id (withheld, unknown, payphone). */
    val withheld: WireCallAction = WireCallAction.RING,
    val outgoing: WireOutgoing = WireOutgoing.ANY,
    /** During Phase 3's bedtime and school schedules, only always-allowed numbers and parents ring. */
    val quiet: Boolean = false,
    /** Send call records (POST /api/v1/calls); never for emergency numbers, 988 or private numbers. */
    val log: Boolean = false,
)

/** An approved contact. [name] is the family's words, at most 60 characters. */
@Serializable
data class WireContact(
    val id: String,
    val name: String,
    /** E.164, at most 5. */
    val numbers: List<String> = emptyList(),
    val calls: Boolean = true,
    val texts: Boolean = true,
    /** Always rings, and is on the emergency card (Phase 7). */
    val parent: Boolean = false,
)

/** `enforcement.calls`: whether Belay is the default dialer, and Belay's own words for a problem. */
@Serializable
data class WireCallsStatus(
    val dialer: Boolean,
    val problem: String? = null,
)

@Serializable
enum class WireCallDirection {
    @SerialName("in") IN,
    @SerialName("out") OUT,
}

@Serializable
enum class WireCallOutcome {
    @SerialName("answered") ANSWERED,
    @SerialName("missed") MISSED,
    @SerialName("rejected") REJECTED,
    @SerialName("voicemail") VOICEMAIL,

    /** An outgoing call Belay didn't allow, ended before it connected. */
    @SerialName("not_placed") NOT_PLACED,
}

@Serializable
enum class WireCallReason {
    @SerialName("unknown") UNKNOWN,
    @SerialName("withheld") WITHHELD,
    @SerialName("quiet") QUIET,
    @SerialName("not_allowed") NOT_ALLOWED,
}

/**
 * One call's metadata (POST /api/v1/calls, only with `calls.log`). [number] (E.164) only when
 * [contactId] is null, so a parent can approve or block an unknown caller. Calls with emergency
 * numbers, 988 or the family's private numbers are never recorded at all.
 */
@Serializable
data class WireCallRecord(
    /** UUID made on the phone. */
    val id: String,
    val at: Long,
    val direction: WireCallDirection,
    @SerialName("contact_id") val contactId: String? = null,
    val number: String? = null,
    @SerialName("duration_s") val durationS: Int = 0,
    val outcome: WireCallOutcome,
    val reason: WireCallReason? = null,
)

@Serializable
data class CallsRequest(val calls: List<WireCallRecord>)

@Serializable
data class CallsResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
)

object CallsWireLimits {
    const val MAX_CONTACTS = 500
    const val MAX_CONTACT_NAME = 60
    const val MAX_NUMBERS_PER_CONTACT = 5
    const val MAX_CALLS_PER_REQUEST = 500
    const val MAX_BODY_BYTES = 128 * 1024

    /** The policy's `blocked_numbers` and `private_numbers`, at most. */
    const val MAX_BLOCKED_NUMBERS = 500
    const val MAX_PRIVATE_NUMBERS = 50

    /** After a call to an emergency number or 988, or a text to 988, every caller rings this long. */
    const val EMERGENCY_CALLBACK_MS = 2 * 60 * 60 * 1000L
}
