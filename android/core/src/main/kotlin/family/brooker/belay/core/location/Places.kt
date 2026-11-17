package family.brooker.belay.core.location

import kotlinx.serialization.Serializable
import kotlin.math.abs
import kotlin.math.max

/** A fix as places see it: where, how accurate, and whether a mock provider made it. */
@Serializable
data class PlaceFix(
    val id: String,
    val at: Long,
    val lat: Double,
    val lng: Double,
    val accuracyM: Int,
    val mock: Boolean,
)

/** Fixes in a row on one side of a place's edge: inside or outside, with the first of them. */
@Serializable
data class Streak(val inside: Boolean, val count: Int, val firstAt: Long, val firstFixId: String)

/**
 * What the phone knows about one place between fixes. [shape] is the place as it was evaluated
 * ("lat,lng,radius"): a moved or resized place starts again, unknown.
 */
@Serializable
data class PlaceTrack(
    val shape: String,
    /** Inside (true), outside (false), or not known yet (null). */
    val inside: Boolean? = null,
    /** The latest fixes in a row on one side; null after a fix near the edge. */
    val streak: Streak? = null,
)

data class PlacesOutcome(val tracks: Map<String, PlaceTrack>, val events: List<WirePlaceEvent>)

/**
 * Arrivals and departures, computed on the phone from its own fixes (docs/design/phase4-location.md):
 * - a fix counts as inside when it's within `radius_m − accuracy` of the center, and as outside when
 *   it's farther than `radius_m + accuracy`; one in between is near the edge, and starts the count
 *   again;
 * - two fixes in a row on the same side decide: from outside, "arrived"; from inside, "left". The
 *   hysteresis keeps a phone at the edge of school from flapping;
 * - a fix less accurate than the radius decides nothing, and a mock fix (`isMock()`) never counts:
 *   neither changes anything;
 * - the first decision for a place (when periodic mode or the place is new, or the place moved) is
 *   made quietly: a phone already at school when the place is added didn't just arrive;
 * - each place on its own, so overlapping places each get their events.
 * An event's `at` is the first of the two fixes (when the phone was first seen on that side), and
 * its `fix_id` the second, which decided. Pure: the same inputs give the same outcome.
 */
object Places {
    const val FIXES_TO_DECIDE = 2

    fun shapeOf(place: WirePlace): String = "${place.lat},${place.lng},${place.radiusM}"

    fun evaluate(places: List<WirePlace>, tracks: Map<String, PlaceTrack>, fix: PlaceFix, newId: () -> String): PlacesOutcome {
        val next = LinkedHashMap<String, PlaceTrack>()
        val events = mutableListOf<WirePlaceEvent>()
        for (place in places.distinctBy { it.id }) {
            val shape = shapeOf(place)
            val before = tracks[place.id]?.takeIf { it.shape == shape } ?: PlaceTrack(shape)
            val side = side(place, fix)
            when {
                side == null -> next[place.id] = before
                side == Side.EDGE -> next[place.id] = before.copy(streak = null)
                else -> {
                    val inside = side == Side.INSIDE
                    val streak = before.streak?.takeIf { it.inside == inside }
                        ?.let { it.copy(count = minOf(it.count + 1, FIXES_TO_DECIDE)) }
                        ?: Streak(inside, 1, fix.at, fix.id)
                    if (streak.count >= FIXES_TO_DECIDE && before.inside != inside) {
                        if (before.inside != null) {
                            val kind = if (inside) WirePlaceEventKind.ARRIVED else WirePlaceEventKind.LEFT
                            events += WirePlaceEvent(newId(), place.id, kind, streak.firstAt, fix.id)
                        }
                        next[place.id] = PlaceTrack(shape, inside, streak)
                    } else {
                        next[place.id] = before.copy(streak = streak)
                    }
                }
            }
        }
        return PlacesOutcome(next, events)
    }

    /**
     * How far [fix] is from the nearest edge of [places], in meters, less its accuracy (so an
     * uncertain fix counts as nearer); null with no places, or a mock fix.
     */
    fun edgeDistanceM(places: List<WirePlace>, fix: PlaceFix): Double? {
        if (fix.mock || places.isEmpty()) return null
        return places.minOf { place ->
            val d = Geo.distanceM(fix.lat, fix.lng, place.lat, place.lng)
            max(0.0, abs(d - place.radiusM) - fix.accuracyM)
        }
    }

    private enum class Side { INSIDE, OUTSIDE, EDGE }

    /** Null: the fix decides nothing for [place] (a mock, or less accurate than the radius). */
    private fun side(place: WirePlace, fix: PlaceFix): Side? {
        if (fix.mock || fix.accuracyM < 0 || fix.accuracyM > place.radiusM) return null
        val d = Geo.distanceM(fix.lat, fix.lng, place.lat, place.lng)
        return when {
            d <= place.radiusM - fix.accuracyM -> Side.INSIDE
            d > place.radiusM + fix.accuracyM -> Side.OUTSIDE
            else -> Side.EDGE
        }
    }
}
