package family.brooker.belay.core.location

/**
 * What the policy's `location` means on the phone (docs/protocol.md, "Location rules"). Pure.
 * Off by default: null or `mode: off` collects nothing, unless the phone is in lost mode.
 */
object LocationRules {
    /** Periodic mode's interval when the policy gives none. */
    const val DEFAULT_EVERY_MINUTES = 30

    /** Lost mode takes a fix this often, in any mode. */
    const val LOST_EVERY_MINUTES = 5

    fun mode(location: WireLocation?): WireLocationMode = location?.mode ?: WireLocationMode.OFF

    /**
     * The location data category is on: the family chose a mode, or the phone is in lost mode.
     * Only then does Belay hold a location permission (besides the one fix a kid shares with a
     * help request) and report `enforcement.location`.
     */
    fun collecting(location: WireLocation?): Boolean = mode(location) != WireLocationMode.OFF || location?.lost != null

    /** `locate_now` runs only in on_demand or periodic mode (lost mode takes its own fixes). */
    fun canLocateNow(location: WireLocation?): Boolean = mode(location) != WireLocationMode.OFF

    fun periodic(location: WireLocation?): Boolean = mode(location) == WireLocationMode.PERIODIC

    /**
     * Location has to stay on, and the kid can't turn it off (setLocationEnabled and
     * DISALLOW_CONFIG_LOCATION): `keep_on` while a mode is on, or lost mode. With the mode off,
     * `keep_on` does nothing: Belay doesn't hold the phone's location on when it collects none.
     */
    fun keepOn(location: WireLocation?): Boolean =
        location?.lost != null || (location?.keepOn == true && mode(location) != WireLocationMode.OFF)

    /** Periodic mode's interval in minutes, within the protocol's 15 to 120. */
    fun everyMinutes(location: WireLocation?): Int =
        (location?.everyMinutes ?: DEFAULT_EVERY_MINUTES).coerceIn(LocationWireLimits.MIN_EVERY_MINUTES, LocationWireLimits.MAX_EVERY_MINUTES)

    /** The places the phone evaluates: periodic mode only, at most 20, valid radii. */
    fun places(location: WireLocation?): List<WirePlace> {
        if (!periodic(location)) return emptyList()
        return location?.places.orEmpty()
            .filter { it.radiusM in LocationWireLimits.MIN_RADIUS_M..LocationWireLimits.MAX_RADIUS_M && it.lat in -90.0..90.0 && it.lng in -180.0..180.0 }
            .distinctBy { it.id }
            .take(LocationWireLimits.MAX_PLACES)
    }

    /** The provider to ask first; [fallback]: fused after a GPS timeout, if the family allowed it. */
    data class Providers(val first: WireLocationProvider, val fallback: WireLocationProvider?)

    fun providers(location: WireLocation?): Providers {
        val first = location?.provider ?: WireLocationProvider.GPS
        val fallback = WireLocationProvider.FUSED.takeIf { first == WireLocationProvider.GPS && location?.fallbackFused == true }
        return Providers(first, fallback)
    }

    /** The parent's lost-mode message for the lock screen: trimmed, at most 120 characters. */
    fun lostMessage(lost: WireLost?): String? =
        lost?.message?.trim()?.take(LocationWireLimits.MAX_LOST_MESSAGE)?.takeIf { it.isNotEmpty() }
}
