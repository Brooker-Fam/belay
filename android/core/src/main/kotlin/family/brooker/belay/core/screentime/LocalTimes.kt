package family.brooker.belay.core.screentime

import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Clock times and dates as the policy writes them, and when they happen in a zone. Times are
 * stored as epoch milliseconds (UTC) everywhere; local dates and clock times only exist here and
 * in what the kid sees.
 */
object LocalTimes {
    private val CLOCK = Regex("([01][0-9]|2[0-3]):([0-5][0-9])")
    private val DATE = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")

    /** "HH:MM" from 00:00 to 23:59; null for anything else ("7:00", "24:00", "07:00:00"). */
    fun clock(text: String): LocalTime? {
        val match = CLOCK.matchEntire(text) ?: return null
        return LocalTime.of(match.groupValues[1].toInt(), match.groupValues[2].toInt())
    }

    /** "HH:MM", the policy's form. */
    fun clockText(time: LocalTime): String =
        time.hour.toString().padStart(2, '0') + ":" + time.minute.toString().padStart(2, '0')

    /** "YYYY-MM-DD"; null for anything else, or a date that doesn't exist. */
    fun date(text: String): LocalDate? {
        if (!DATE.matches(text)) return null
        return try {
            LocalDate.parse(text)
        } catch (e: DateTimeException) {
            null
        }
    }

    /** The zone a policy names: an IANA zone, or "phone" for [phone]. Null when the name isn't a zone. */
    fun zone(name: String, phone: ZoneId): ZoneId? {
        if (name == WireScreenTime.ZONE_PHONE) return phone
        if (name.isBlank()) return null
        return try {
            ZoneId.of(name)
        } catch (e: DateTimeException) {
            null
        }
    }

    /**
     * When [time] on [date] happens in [zone]. In a DST gap (2:30 a.m. on the night clocks go
     * forward) it is later by the gap's length (3:30 a.m.); in an overlap (1:30 a.m. on the night
     * they go back) it is the first of the two. That's java.time's rule (ZonedDateTime.of).
     */
    fun at(date: LocalDate, time: LocalTime, zone: ZoneId): Long =
        ZonedDateTime.of(date, time, zone).toInstant().toEpochMilli()

    fun local(at: Long, zone: ZoneId): ZonedDateTime = Instant.ofEpochMilli(at).atZone(zone)
}

/**
 * Days that start at [starts] in [zone]: the policy's `day_starts`, when a day's limits reset.
 * A day is 23 or 25 hours long when the clocks change during it. When [starts] falls in a DST gap
 * that day starts later by the gap's length (LocalTimes.at).
 */
data class DayClock(val zone: ZoneId, val starts: LocalTime = LocalTime.MIDNIGHT) {
    fun startOf(day: LocalDate): Long = LocalTimes.at(day, starts, zone)

    fun endOf(day: LocalDate): Long = startOf(day.plusDays(1))

    /** The day [at] belongs to. */
    fun dayAt(at: Long): LocalDate {
        val date = LocalTimes.local(at, zone).toLocalDate()
        return when {
            at < startOf(date) -> date.minusDays(1)
            at >= endOf(date) -> date.plusDays(1)
            else -> date
        }
    }

    /** The days that overlap [from, to), oldest first. */
    fun daysIn(from: Long, to: Long): List<LocalDate> {
        if (to <= from) return emptyList()
        val days = mutableListOf<LocalDate>()
        var day = dayAt(from)
        val last = dayAt(to - 1)
        while (day <= last) {
            days += day
            day = day.plusDays(1)
        }
        return days
    }
}
