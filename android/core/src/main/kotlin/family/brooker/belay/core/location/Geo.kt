package family.brooker.belay.core.location

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** Distances on the Earth, and the protocol's rounding. No map service: plain arithmetic. */
object Geo {
    /** The mean Earth radius (IUGG), in meters. */
    const val EARTH_RADIUS_M = 6_371_008.8

    /** The great-circle distance between two points, in meters (haversine). */
    fun distanceM(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val p1 = Math.toRadians(lat1)
        val p2 = Math.toRadians(lat2)
        val dp = p2 - p1
        val dl = Math.toRadians(lng2 - lng1)
        val a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
    }

    /** 5 decimal places (about 1 m), as the protocol sends coordinates. */
    fun round5(value: Double): Double = Math.round(value * 1e5) / 1e5

    /** A latitude for the wire: rounded, within -90..90. */
    fun latitude(value: Double): Double = round5(value.coerceIn(-90.0, 90.0))

    /** A longitude for the wire: rounded, within -180..180. */
    fun longitude(value: Double): Double = round5(value.coerceIn(-180.0, 180.0))
}
