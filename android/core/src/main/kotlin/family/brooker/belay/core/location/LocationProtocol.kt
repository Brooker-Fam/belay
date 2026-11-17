package family.brooker.belay.core.location

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Phase 4's part of the device API (docs/protocol.md, "Location rules"), with core/Protocol.kt's
// conventions: snake_case names, and every policy field defaults to collecting nothing. Protocol.kt's
// WirePolicy, WireEnforcement, WireRequest (a help request may carry a fix) and WireCommand
// (`locate_now`) carry these types; server/src/device/schemas.ts mirrors them.

@Serializable
enum class WireLocationMode {
    /** No location at all: Belay holds no location permission (the default). */
    @SerialName("off") OFF,

    /** A fix only when a parent asks (`locate_now`), or in lost mode. */
    @SerialName("on_demand") ON_DEMAND,

    /** On demand, plus a fix every `every_minutes` within `hours`, plus place events. */
    @SerialName("periodic") PERIODIC,
}

@Serializable
enum class WireLocationProvider {
    /** The satellite receiver only: private, slower indoors (the default). */
    @SerialName("gps") GPS,

    /** Android's combined provider (Google's on a Pixel): faster, works indoors. */
    @SerialName("fused") FUSED,
}

/** "HH:MM" to "HH:MM" in the phone's zone; an `end` at or before `start` ends the next day. */
@Serializable
data class WireHours(val start: String, val end: String)

@Serializable
enum class WirePlaceNotify {
    @SerialName("arrive") ARRIVE,
    @SerialName("leave") LEAVE,
}

/** A place the family named. [name] is the family's words, at most 40 characters, shown to the kid. */
@Serializable
data class WirePlace(
    val id: String,
    val name: String,
    val lat: Double,
    val lng: Double,
    /** 50 to 1000. */
    @SerialName("radius_m") val radiusM: Int,
    /** Which events notify the parents. */
    val notify: List<WirePlaceNotify> = emptyList(),
)

/** Lost mode: the parent's [message] on the lock screen, at most 120 characters. */
@Serializable
data class WireLost(val since: Long, val message: String)

/** The policy's `location`. Null, or `mode: off`: no location at all. */
@Serializable
data class WireLocation(
    val mode: WireLocationMode = WireLocationMode.OFF,
    /** Periodic: 15 to 120. */
    @SerialName("every_minutes") val everyMinutes: Int? = null,
    /** Periodic fixes only within these hours. Null: all day. */
    val hours: WireHours? = null,
    val provider: WireLocationProvider = WireLocationProvider.GPS,
    /** Use the fused provider when a GPS fix times out. */
    @SerialName("fallback_fused") val fallbackFused: Boolean = false,
    /** At most 20; periodic mode only. */
    val places: List<WirePlace> = emptyList(),
    /** The kid can't turn location off (`DISALLOW_CONFIG_LOCATION`). */
    @SerialName("keep_on") val keepOn: Boolean = false,
    /** Works in any mode, `off` included. */
    val lost: WireLost? = null,
)

/** `enforcement.location`: whether Belay can take a fix, and Belay's own words for what failed. */
@Serializable
data class WireLocationStatus(
    val permission: Boolean,
    @SerialName("location_on") val locationOn: Boolean,
    @SerialName("last_fix_at") val lastFixAt: Long? = null,
    val problem: String? = null,
)

@Serializable
enum class WireFixReason {
    @SerialName("on_demand") ON_DEMAND,
    @SerialName("periodic") PERIODIC,

    /** Taken sooner because the phone was near a place's edge. */
    @SerialName("place") PLACE,
    @SerialName("lost") LOST,

    /** Phase 7: the kid chose to share where the phone is with a help request. */
    @SerialName("help") HELP,
}

/** One fix. [lat] and [lng] have 5 decimal places (about 1 m). */
@Serializable
data class WireFix(
    /** UUID made on the phone. */
    val id: String,
    /** The fix's own time. */
    val at: Long,
    val lat: Double,
    val lng: Double,
    @SerialName("accuracy_m") val accuracyM: Int,
    /** The provider that answered. */
    val provider: WireLocationProvider,
    val reason: WireFixReason,
    /** The `locate_now` command it answers. */
    @SerialName("command_id") val commandId: String? = null,
    /** From `Location.isMock()`: never counts toward places. */
    val mock: Boolean = false,
)

@Serializable
enum class WirePlaceEventKind {
    @SerialName("arrived") ARRIVED,
    @SerialName("left") LEFT,
}

@Serializable
data class WirePlaceEvent(
    val id: String,
    @SerialName("place_id") val placeId: String,
    val kind: WirePlaceEventKind,
    val at: Long,
    @SerialName("fix_id") val fixId: String,
)

/** `POST /api/v1/locations`: idempotent by each item's id. */
@Serializable
data class LocationsRequest(
    val fixes: List<WireFix> = emptyList(),
    @SerialName("place_events") val placeEvents: List<WirePlaceEvent> = emptyList(),
)

@Serializable
data class LocationsResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
)

object LocationWireLimits {
    const val MAX_PLACES = 20
    const val MAX_PLACE_NAME = 40
    const val MIN_RADIUS_M = 50
    const val MAX_RADIUS_M = 1000
    const val MIN_EVERY_MINUTES = 15
    const val MAX_EVERY_MINUTES = 120
    const val MAX_LOST_MESSAGE = 120
    const val MAX_FIXES_PER_REQUEST = 200
    const val MAX_PLACE_EVENTS_PER_REQUEST = 200
    const val MAX_BODY_BYTES = 64 * 1024

    /** How long a `locate_now` may take on the phone before it's reported as failed. */
    const val FIX_TIMEOUT_MS = 60_000L
}
