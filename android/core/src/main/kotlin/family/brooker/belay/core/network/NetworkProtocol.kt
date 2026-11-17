package family.brooker.belay.core.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Phase 3's network logging half of the device API (docs/protocol.md, "POST /api/v1/network"),
// with core/Protocol.kt's conventions: snake_case names, nulls left out. The policy's
// `network_log` and the report's `enforcement.network_log` are in screentime/ScreenTimeProtocol.kt
// (WireNetworkLog, WireNetworkLogStatus); server/src/device/schemas.ts mirrors all of them.

/** How many times one app looked up one domain on one day. */
@Serializable
data class WireNetworkEntry(
    @SerialName("package") val packageName: String,
    /**
     * A lowercase hostname in Punycode, at most 253 characters: the registrable part of what the app
     * looked up (Domains). The app's developer chose it, so it's untrusted text.
     */
    val domain: String,
    val lookups: Int,
)

/**
 * One local day of lookups. Idempotent by [day]: a day sent again replaces the server's, so the
 * phone always sends the whole day as it has it now.
 */
@Serializable
data class WireNetworkDay(
    /** "YYYY-MM-DD" in [zone]. */
    val day: String,
    /** IANA: the phone's own zone. */
    val zone: String,
    /** The newest lookup counted. */
    @SerialName("as_of") val asOf: Long,
    /** At most 5000, most looked up first. */
    val entries: List<WireNetworkEntry> = emptyList(),
    /** Entries cut to stay under 5000 (and the day's size): the least looked up. */
    val dropped: Int = 0,
)

/** At most 31 days and 512 KB. */
@Serializable
data class NetworkRequest(val days: List<WireNetworkDay>)

@Serializable
data class NetworkResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
)

/** The server's limits (docs/protocol.md); the phone stays below them. */
object NetworkWireLimits {
    const val MAX_DAYS = 31
    const val MAX_ENTRIES = 5000
    const val MAX_BODY_BYTES = 512 * 1024
    const val MAX_DOMAIN = 253

    /** One entry's lookups in a day, and a day's `dropped`, at most. */
    const val MAX_COUNT = 1_000_000
}
