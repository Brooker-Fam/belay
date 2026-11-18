package family.brooker.belay.core.mobiledata

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Phase 13's half of the device API (docs/protocol.md, "Mobile data"), with core/Protocol.kt's
// conventions: snake_case names, nulls left out. server/src/device/schemas.ts mirrors all of it.

/**
 * The policy's `mobile_data`: the apps that may not use mobile data (a parent's, or an AI app's
 * when it only adds), and whether the phone sends how much mobile data each app uses (a parent's
 * alone). Both off by default; a server from before Phase 13 sends none, which reads as this.
 */
@Serializable
data class WireMobileData(
    /** Package names, at most [MobileDataWireLimits.MAX_WIFI_ONLY]: kept off every metered network. */
    @SerialName("wifi_only") val wifiOnly: List<String> = emptyList(),
    /** Send `POST /api/v1/mobile-data`: how much mobile data each app uses each day. */
    val measure: Boolean = false,
)

/** The report's `enforcement.mobile_data`: what Android keeps off mobile data for Belay now. */
@Serializable
data class WireMobileDataStatus(
    /** The packages Android restricts (getMeteredDataDisabledPackages), sorted, at most 100. */
    @SerialName("wifi_only") val wifiOnly: List<String> = emptyList(),
)

/** One app's bytes on mobile data in one day (received and sent). */
@Serializable
data class WireMobileDataApp(
    @SerialName("package") val packageName: String,
    val bytes: Long,
)

/**
 * One local day of mobile data use, as Android counted it (NetworkStatsManager, platform notes
 * Q6 to Q8). Idempotent by [day]: a day sent again replaces the server's, so the phone always sends
 * the whole day as it has it now.
 */
@Serializable
data class WireMobileDataDay(
    /** "YYYY-MM-DD" in [zone]. */
    val day: String,
    /** IANA: the phone's own zone. */
    val zone: String,
    /** Counted from: the day's start, or when measuring turned on that day. */
    val from: Long,
    /** Counted up to: when the phone read it, or the day's end once [complete]. */
    @SerialName("as_of") val asOf: Long,
    /** The day is over, and Android's last bucket of it has closed. */
    val complete: Boolean,
    /** Everything on mobile data: the apps, the lines below, and what's past the listed apps. */
    @SerialName("mobile_bytes") val mobileBytes: Long,
    /** Everything on Wi-Fi, all apps together. */
    @SerialName("wifi_bytes") val wifiBytes: Long,
    /** Most first, at most [MobileDataWireLimits.MAX_APPS]; never the apps Belay never blocks. */
    val apps: List<WireMobileDataApp> = emptyList(),
    /** Android's own parts, shared uids and the apps Belay never blocks (calls, texting…), together. */
    @SerialName("android_bytes") val androidBytes: Long = 0,
    /** Apps removed since: Android keeps their use as removed apps. */
    @SerialName("removed_bytes") val removedBytes: Long = 0,
    /** What other devices used through this phone's own hotspot. */
    @SerialName("hotspot_bytes") val hotspotBytes: Long = 0,
)

/** At most 31 days and 256 KB. */
@Serializable
data class MobileDataRequest(val days: List<WireMobileDataDay>)

@Serializable
data class MobileDataResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
)

/** The server's limits (docs/protocol.md); the phone stays below them. */
object MobileDataWireLimits {
    const val MAX_WIFI_ONLY = 100
    const val MAX_DAYS = 31
    const val MAX_APPS = 500
    const val MAX_BODY_BYTES = 256 * 1024

    /** One day's bytes, at most: 100 TB, far past any phone. */
    const val MAX_BYTES = 100_000_000_000_000L
}
