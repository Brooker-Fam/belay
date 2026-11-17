package family.brooker.belay.core.screentime

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * A schedule the phone can enforce: the policy's [wire] schedule with its times and dates read.
 * A schedule runs from [start] on each of its [days] (calendar dates in the zone) to [end] that
 * day, or the next day when [end] is at or before [start]; a date in [skip] doesn't start one.
 * So bedtime 21:00 to 07:00 on school nights (Sunday to Thursday) holds Friday morning too, and
 * skipping Thursday frees Thursday night and Friday morning.
 */
class ScheduleRule private constructor(
    val wire: WireSchedule,
    val start: LocalTime,
    val end: LocalTime,
    val days: Set<DayOfWeek>,
    val skip: Set<LocalDate>,
    val allow: Set<String>,
) {
    val id: String get() = wire.id

    /** The time it runs when it starts on [date] in [zone]; null when it doesn't start that day. */
    fun occurrence(date: LocalDate, zone: ZoneId): Occurrence? {
        if (date.dayOfWeek !in days || date in skip) return null
        val from = LocalTimes.at(date, start, zone)
        val to = LocalTimes.at(if (end <= start) date.plusDays(1) else date, end, zone)
        // A start pushed past the end by a DST gap (02:30 to 03:00 on the night clocks go forward).
        return if (to > from) Occurrence(this, date, from, to) else null
    }

    /** Every time it runs that starts on a date from [first] to [last]. */
    fun occurrences(first: LocalDate, last: LocalDate, zone: ZoneId): List<Occurrence> {
        val out = mutableListOf<Occurrence>()
        var date = first
        while (date <= last) {
            occurrence(date, zone)?.let { out += it }
            date = date.plusDays(1)
        }
        return out
    }

    override fun toString() = "ScheduleRule($id ${LocalTimes.clockText(start)}-${LocalTimes.clockText(end)})"

    companion object {
        /**
         * Null, with a problem, when its times can't be read: a schedule that decides nothing is
         * ignored, never guessed. Unreadable skip dates are left out, with a problem.
         */
        fun of(wire: WireSchedule, problems: MutableList<String>): ScheduleRule? {
            val start = LocalTimes.clock(wire.start)
            val end = LocalTimes.clock(wire.end)
            if (start == null || end == null) {
                problems += "Schedule ${wire.id}: its start or end isn't a time like 21:00, so it's ignored."
                return null
            }
            val skip = wire.skip.mapNotNullTo(HashSet()) { text ->
                LocalTimes.date(text).also {
                    if (it == null) problems += "Schedule ${wire.id}: \"${text.take(20)}\" isn't a date, so it's ignored."
                }
            }
            return ScheduleRule(wire, start, end, wire.days.mapTo(HashSet()) { it.dayOfWeek }, skip, wire.allow.toSet())
        }
    }
}

/** One time a schedule runs, from [start] to [end] (epoch millis); it started on [date]. */
data class Occurrence(val rule: ScheduleRule, val date: LocalDate, val start: Long, val end: Long) {
    fun activeAt(at: Long): Boolean = at in start until end

    /** Stable for this one time it runs, for "lock the screen once when it starts". */
    val key: String get() = "schedule:${rule.id}:$start"
}
