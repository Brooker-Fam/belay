package family.brooker.belay.core.location

import family.brooker.belay.core.screentime.LocalTimes
import java.time.LocalTime
import java.time.ZoneId

/**
 * When the next fix is due, by the clock alone (docs/protocol.md, "Location rules"). Pure.
 * - Periodic mode: a fix every `every_minutes` within `hours` (in the phone's zone; an end at or
 *   before the start ends the next day, and the same start and end mean all day), sooner near a
 *   place's edge: the distance to the nearest edge at an assumed 30 m/s, between 5 minutes and
 *   `every_minutes`. The first fix comes as soon as periodic mode is on, within `hours`.
 * - Lost mode: a fix every 5 minutes, in any mode, at any hour.
 * Each counts from the last time Belay tried, so a fix that failed waits a whole interval too.
 */
object LocationSchedule {
    /** How fast the phone is assumed to move toward a place's edge: about 100 km/h. */
    const val EDGE_SPEED_MPS = 30.0
    const val MINUTE_MS = 60_000L
    const val MIN_INTERVAL_MS = 5 * MINUTE_MS
    const val LOST_INTERVAL_MS = LocationRules.LOST_EVERY_MINUTES * MINUTE_MS

    /** A fix due [at], taken for [reason]: periodic, or place when it comes sooner for a place's edge. */
    data class Due(val at: Long, val reason: WireFixReason)

    /**
     * The interval after [last], the last fix: `every_minutes`, or sooner near the nearest place's
     * edge (Places.edgeDistanceM at 30 m/s), never under 5 minutes. With the reason the next fix
     * is taken for.
     */
    fun interval(location: WireLocation?, last: PlaceFix?): Pair<Long, WireFixReason> {
        val every = LocationRules.everyMinutes(location) * MINUTE_MS
        val edge = last?.let { Places.edgeDistanceM(LocationRules.places(location), it) } ?: return every to WireFixReason.PERIODIC
        val toEdge = (edge / EDGE_SPEED_MPS * 1000).toLong()
        val interval = toEdge.coerceIn(MIN_INTERVAL_MS, every)
        return interval to if (interval < every) WireFixReason.PLACE else WireFixReason.PERIODIC
    }

    /**
     * The next periodic fix, or null unless the mode is periodic: [triedAt] (the last periodic
     * try) plus the [interval], or now when Belay hasn't tried yet; moved to the next start of
     * `hours` when it falls outside them. A [triedAt] in the future (the clock went back) counts
     * as now.
     */
    fun nextPeriodic(location: WireLocation?, triedAt: Long?, last: PlaceFix?, now: Long, zone: ZoneId): Due? {
        if (!LocationRules.periodic(location)) return null
        val (interval, reason) = interval(location, last)
        val from = triedAt?.takeIf { it <= now }
        val at = if (from == null) now else from + interval
        val within = nextWithin(location?.hours, at, zone)
        return Due(within, if (within == at) reason else WireFixReason.PERIODIC)
    }

    /** The next lost-mode fix, or null when not lost: 5 minutes after the last try, or now. */
    fun nextLost(location: WireLocation?, triedAt: Long?, now: Long): Long? {
        if (location?.lost == null) return null
        val from = triedAt?.takeIf { it <= now } ?: return now
        return from + LOST_INTERVAL_MS
    }

    /** Whether [at] is within [hours] in [zone]. Null hours, or hours that don't parse: all day. */
    fun within(hours: WireHours?, at: Long, zone: ZoneId): Boolean {
        val (start, end) = clocks(hours) ?: return true
        if (start == end) return true
        val time = LocalTimes.local(at, zone).toLocalTime()
        return if (start < end) time >= start && time < end else time >= start || time < end
    }

    /** [at] if it's within [hours], else the next start of them. */
    fun nextWithin(hours: WireHours?, at: Long, zone: ZoneId): Long {
        if (within(hours, at, zone)) return at
        val (start, _) = clocks(hours) ?: return at
        val date = LocalTimes.local(at, zone).toLocalDate()
        val today = LocalTimes.at(date, start, zone)
        return if (today > at) today else LocalTimes.at(date.plusDays(1), start, zone)
    }

    private fun clocks(hours: WireHours?): Pair<LocalTime, LocalTime>? {
        hours ?: return null
        val start = LocalTimes.clock(hours.start) ?: return null
        val end = LocalTimes.clock(hours.end) ?: return null
        return start to end
    }
}
