package family.brooker.belay.core.screentime

import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.at
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SchedulesTest {
    private fun date(text: String): LocalDate = LocalDate.parse(text)
    private val weekdays = listOf(WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU, WireDay.FRI)
    private val schoolNights = listOf(WireDay.SUN, WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU)

    private fun rule(start: String, end: String, days: List<WireDay> = WireDay.entries, skip: List<String> = emptyList()) =
        ScheduleRule.of(WireSchedule("s", WireScheduleKind.CUSTOM, "Test", days, start, end, skip = skip), mutableListOf())!!

    @Test
    fun `school runs from start to end, on its days only`() {
        val school = rule("08:00", "15:00", weekdays)
        val tuesday = school.occurrence(date("2026-11-17"), NY)!!
        assertEquals(at("2026-11-17T08:00"), tuesday.start)
        assertEquals(at("2026-11-17T15:00"), tuesday.end)
        assertTrue(tuesday.activeAt(at("2026-11-17T08:00")))
        assertTrue(tuesday.activeAt(at("2026-11-17T14:59")))
        assertFalse(tuesday.activeAt(at("2026-11-17T15:00")), "the end is when apps open again")
        assertNull(school.occurrence(date("2026-11-21"), NY), "Saturday")
    }

    @Test
    fun `bedtime past midnight ends the next morning, and the morning belongs to the night before`() {
        val bedtime = rule("21:00", "07:00", schoolNights)
        val thursday = bedtime.occurrence(date("2026-11-19"), NY)!!
        assertEquals(at("2026-11-19T21:00"), thursday.start)
        assertEquals(at("2026-11-20T07:00"), thursday.end)
        assertTrue(thursday.activeAt(at("2026-11-20T06:59")), "Friday morning is Thursday night's")
        assertNull(bedtime.occurrence(date("2026-11-20"), NY), "no bedtime starts on Friday")
        assertNotNull(bedtime.occurrence(date("2026-11-22"), NY), "Sunday is a school night")
    }

    @Test
    fun `a skipped date frees that night and the morning after`() {
        val bedtime = rule("21:00", "07:00", schoolNights, skip = listOf("2026-11-26"))
        assertNull(bedtime.occurrence(date("2026-11-26"), NY), "Thanksgiving")
        val week = bedtime.occurrences(date("2026-11-22"), date("2026-11-28"), NY)
        assertEquals(listOf("2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"), week.map { it.date.toString() })
        assertFalse(week.any { it.activeAt(at("2026-11-27T06:00")) }, "Friday morning is free too")
    }

    @Test
    fun `the same start and end is a whole day`() {
        val allDay = rule("00:00", "00:00").occurrence(date("2026-11-17"), NY)!!
        assertEquals(24 * HOUR, allDay.end - allDay.start)
    }

    @Test
    fun `bedtime is an hour shorter the night clocks go forward, and an hour longer the night they go back`() {
        val bedtime = rule("21:00", "07:00")
        val spring = bedtime.occurrence(date("2026-03-07"), NY)!!
        assertEquals(at("2026-03-08T07:00"), spring.end)
        assertEquals(9 * HOUR, spring.end - spring.start)
        val fall = bedtime.occurrence(date("2026-10-31"), NY)!!
        assertEquals(11 * HOUR, fall.end - fall.start)
    }

    @Test
    fun `a start in the DST gap moves later, and an end in the overlap is the first one`() {
        val early = rule("02:30", "06:00").occurrence(date("2026-03-08"), NY)!!
        assertEquals(at("2026-03-08T03:30"), early.start)
        val late = rule("22:00", "01:30").occurrence(date("2026-10-31"), NY)!!
        assertEquals(at("2026-11-01T01:30"), late.end)
        assertEquals(3 * HOUR + 30 * Fx.MIN, late.end - late.start)
    }

    @Test
    fun `a schedule the DST gap squeezes to nothing doesn't run`() {
        assertNull(rule("02:30", "03:00").occurrence(date("2026-03-08"), NY))
        assertNotNull(rule("02:30", "03:00").occurrence(date("2026-03-09"), NY))
    }

    @Test
    fun `unreadable times leave the schedule out, and unreadable skip dates are dropped`() {
        val problems = mutableListOf<String>()
        assertNull(ScheduleRule.of(WireSchedule("s-1", WireScheduleKind.BEDTIME, "Bed", WireDay.entries, "9pm", "07:00"), problems))
        val kept = ScheduleRule.of(
            WireSchedule("s-2", WireScheduleKind.BEDTIME, "Bed", WireDay.entries, "21:00", "07:00", skip = listOf("someday", "2026-11-26")),
            problems,
        )
        assertEquals(setOf(date("2026-11-26")), kept?.skip)
        assertEquals(2, problems.size)
        assertTrue(problems[0].startsWith("Schedule s-1"))
        assertTrue(problems[1].startsWith("Schedule s-2"))
    }

    @Test
    fun `a schedule with no days never runs`() {
        assertEquals(emptyList(), rule("08:00", "15:00", days = emptyList()).occurrences(date("2026-11-16"), date("2026-11-22"), NY))
    }
}
