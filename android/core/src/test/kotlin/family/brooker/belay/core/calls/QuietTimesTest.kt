package family.brooker.belay.core.calls

import family.brooker.belay.core.screentime.Fx
import family.brooker.belay.core.screentime.WireDay
import family.brooker.belay.core.screentime.WireSchedule
import family.brooker.belay.core.screentime.WireScheduleKind
import family.brooker.belay.core.screentime.WireScreenTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class QuietTimesTest {
    private val schoolNights = listOf(WireDay.SUN, WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU)
    private val weekdays = listOf(WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU, WireDay.FRI)
    private val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", schoolNights, "21:00", "07:00")
    private val school = WireSchedule("s-school", WireScheduleKind.SCHOOL, "School", weekdays, "08:00", "15:00", skip = listOf("2026-11-26"))
    private val practice = WireSchedule("s-practice", WireScheduleKind.CUSTOM, "Practice", weekdays, "16:00", "17:00")
    private val screenTime = WireScreenTime(zone = "America/New_York", schedules = listOf(bedtime, school, practice))

    private fun quiet(local: String) = QuietTimes.quiet(screenTime, Fx.at(local), Fx.LA)

    @Test
    fun `bedtime and school are quiet, as screen time's rules see them`() {
        // Tuesday 2026-11-17.
        assertTrue(quiet("2026-11-17T22:30"), "Tuesday night bedtime")
        assertTrue(quiet("2026-11-18T06:59"), "until 07:00 the next morning")
        assertFalse(quiet("2026-11-18T07:00"))
        assertTrue(quiet("2026-11-18T10:00"), "school")
        assertFalse(quiet("2026-11-18T15:00"))
        assertEquals(listOf("s-school"), QuietTimes.on(screenTime, Fx.at("2026-11-18T10:00"), Fx.LA))
    }

    @Test
    fun `a custom schedule, a skipped day and a Friday night aren't quiet`() {
        assertFalse(quiet("2026-11-18T16:30"), "practice is a custom schedule")
        assertFalse(quiet("2026-11-26T10:00"), "school skipped that day")
        assertFalse(quiet("2026-11-20T22:30"), "Friday isn't a school night")
        assertTrue(quiet("2026-11-22T22:30"), "Sunday is")
    }

    @Test
    fun `the policy's zone counts, or the phone's`() {
        // 22:30 in Los Angeles is 01:30 in New York: bedtime there.
        assertTrue(QuietTimes.quiet(screenTime, Fx.at("2026-11-17T22:30", Fx.LA), Fx.LA))
        val phoneZone = screenTime.copy(zone = WireScreenTime.ZONE_PHONE)
        // 18:00 in Los Angeles is 21:00 in New York: not bedtime by the phone's own zone.
        assertFalse(QuietTimes.quiet(phoneZone, Fx.at("2026-11-17T18:00", Fx.LA), Fx.LA))
        assertTrue(QuietTimes.quiet(phoneZone, Fx.at("2026-11-17T21:00", Fx.LA), Fx.LA))
    }

    @Test
    fun `no screen time, no quiet time`() {
        assertFalse(QuietTimes.quiet(null, Fx.at("2026-11-17T22:30"), Fx.NY))
        assertFalse(QuietTimes.quiet(WireScreenTime(), Fx.at("2026-11-17T22:30"), Fx.NY))
    }
}
