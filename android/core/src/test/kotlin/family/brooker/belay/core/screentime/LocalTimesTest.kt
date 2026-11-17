package family.brooker.belay.core.screentime

import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.LA
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.at
import family.brooker.belay.core.screentime.Fx.atLater
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LocalTimesTest {
    private val midnight = DayClock(NY)
    private fun date(text: String): LocalDate = LocalDate.parse(text)

    @Test
    fun `clock times are HH colon MM from 00 00 to 23 59`() {
        assertEquals(LocalTime.of(0, 0), LocalTimes.clock("00:00"))
        assertEquals(LocalTime.of(23, 59), LocalTimes.clock("23:59"))
        assertEquals(LocalTime.of(7, 5), LocalTimes.clock("07:05"))
        listOf("7:00", "24:00", "12:60", "07:00:00", "", " 07:00", "noon").forEach {
            assertNull(LocalTimes.clock(it), it)
        }
        assertEquals("07:05", LocalTimes.clockText(LocalTime.of(7, 5)))
    }

    @Test
    fun `dates must be written in full and exist`() {
        assertEquals(date("2026-11-17"), LocalTimes.date("2026-11-17"))
        listOf("2026-02-30", "2026-1-7", "17/11/2026", "").forEach { assertNull(LocalTimes.date(it), it) }
    }

    @Test
    fun `a zone is an IANA name, or the phone's own`() {
        assertEquals(LA, LocalTimes.zone("phone", LA))
        assertEquals(NY, LocalTimes.zone("America/New_York", LA))
        assertNull(LocalTimes.zone("Mars/Olympus_Mons", LA))
        assertNull(LocalTimes.zone("", LA))
    }

    @Test
    fun `a day is 24 hours, 23 when clocks go forward and 25 when they go back`() {
        val nov17 = date("2026-11-17")
        assertEquals(Instant.parse("2026-11-17T05:00:00Z").toEpochMilli(), midnight.startOf(nov17))
        assertEquals(24 * HOUR, midnight.endOf(nov17) - midnight.startOf(nov17))
        val spring = date("2026-03-08")
        assertEquals(23 * HOUR, midnight.endOf(spring) - midnight.startOf(spring))
        val fall = date("2026-11-01")
        assertEquals(25 * HOUR, midnight.endOf(fall) - midnight.startOf(fall))
    }

    @Test
    fun `the day an instant belongs to`() {
        assertEquals(date("2026-11-17"), midnight.dayAt(at("2026-11-17T00:00")))
        assertEquals(date("2026-11-16"), midnight.dayAt(at("2026-11-17T00:00") - 1))
        assertEquals(date("2026-11-01"), midnight.dayAt(atLater("2026-11-01T01:30")), "the second 1:30 a.m. is the same day")
        // The same instant is still the 16th in Los Angeles.
        assertEquals(date("2026-11-16"), DayClock(LA).dayAt(at("2026-11-17T01:00")))
    }

    @Test
    fun `a day that starts at 4 am holds the small hours of the next date`() {
        val four = DayClock(NY, LocalTime.of(4, 0))
        assertEquals(date("2026-11-16"), four.dayAt(at("2026-11-17T03:59")))
        assertEquals(date("2026-11-17"), four.dayAt(at("2026-11-17T04:00")))
        assertEquals(at("2026-11-17T04:00"), four.startOf(date("2026-11-17")))
        assertEquals(at("2026-11-18T04:00"), four.endOf(date("2026-11-17")))
    }

    @Test
    fun `a day start in the DST gap moves later by the gap, so the day before is longer`() {
        val halfPastTwo = DayClock(NY, LocalTime.of(2, 30))
        val spring = date("2026-03-08")
        assertEquals(at("2026-03-08T03:30"), halfPastTwo.startOf(spring))
        assertEquals(date("2026-03-07"), halfPastTwo.dayAt(at("2026-03-08T03:15")))
        assertEquals(spring, halfPastTwo.dayAt(at("2026-03-08T03:30")))
        // Saturday 2:30 EST to Sunday 3:30 EDT: 24 hours of elapsed time.
        assertEquals(24 * HOUR, halfPastTwo.endOf(date("2026-03-07")) - halfPastTwo.startOf(date("2026-03-07")))
        assertEquals(23 * HOUR, halfPastTwo.endOf(spring) - halfPastTwo.startOf(spring))
    }

    @Test
    fun `a day start in the overlap is the first of the two`() {
        val halfPastOne = DayClock(NY, LocalTime.of(1, 30))
        val fall = date("2026-11-01")
        assertEquals(at("2026-11-01T01:30"), halfPastOne.startOf(fall))
        assertEquals(fall, halfPastOne.dayAt(atLater("2026-11-01T01:30")))
    }

    @Test
    fun `the days a range overlaps`() {
        assertEquals(
            listOf(date("2026-10-31"), date("2026-11-01"), date("2026-11-02")),
            midnight.daysIn(at("2026-10-31T23:00"), at("2026-11-02T00:30")),
        )
        assertEquals(listOf(date("2026-11-17")), midnight.daysIn(at("2026-11-17T00:00"), at("2026-11-18T00:00")))
        assertEquals(emptyList(), midnight.daysIn(at("2026-11-17T10:00"), at("2026-11-17T10:00")))
    }

    @Test
    fun `half-hour zones work like any other`() {
        val kolkata = DayClock(ZoneId.of("Asia/Kolkata"))
        assertEquals(Instant.parse("2026-11-16T18:30:00Z").toEpochMilli(), kolkata.startOf(date("2026-11-17")))
    }
}
