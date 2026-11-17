package family.brooker.belay.core.location

import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LocationScheduleTest {
    private val zone: ZoneId = ZoneId.of("America/New_York")
    private val minute = LocationSchedule.MINUTE_MS
    private val school = WirePlace("p-school", "School", 40.0, -75.0, 150)
    private val perMeter = 1 / (Geo.EARTH_RADIUS_M * Math.PI / 180)

    private fun at(text: String): Long = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()

    private fun periodic(every: Int = 30, hours: WireHours? = null, places: List<WirePlace> = emptyList()) =
        WireLocation(mode = WireLocationMode.PERIODIC, everyMinutes = every, hours = hours, places = places)

    /** A fix [metersNorth] of the school's center. */
    private fun fixNorth(metersNorth: Double, accuracy: Int = 10, mock: Boolean = false) =
        PlaceFix("fix-1", 0, 40.0 + metersNorth * perMeter, -75.0, accuracy, mock)

    @Test
    fun `periodic fixes come every_minutes, and the first one at once`() {
        val now = at("2026-11-17T10:00")
        assertEquals(LocationSchedule.Due(now, WireFixReason.PERIODIC), LocationSchedule.nextPeriodic(periodic(), null, null, now, zone))
        val tried = now - 10 * minute
        assertEquals(tried + 30 * minute, LocationSchedule.nextPeriodic(periodic(), tried, null, now, zone)?.at)
    }

    @Test
    fun `only periodic mode has periodic fixes`() {
        val now = at("2026-11-17T10:00")
        assertNull(LocationSchedule.nextPeriodic(WireLocation(mode = WireLocationMode.ON_DEMAND), null, null, now, zone))
        assertNull(LocationSchedule.nextPeriodic(null, null, null, now, zone))
        assertNull(LocationSchedule.nextPeriodic(WireLocation(), null, null, now, zone))
    }

    @Test
    fun `every_minutes is kept between 15 and 120, and defaults to 30`() {
        assertEquals(15 * minute, LocationSchedule.interval(periodic(every = 5), null).first)
        assertEquals(120 * minute, LocationSchedule.interval(periodic(every = 600), null).first)
        assertEquals(30 * minute, LocationSchedule.interval(WireLocation(mode = WireLocationMode.PERIODIC), null).first)
    }

    @Test
    fun `near a place's edge the next fix comes sooner, never under 5 minutes`() {
        val location = periodic(every = 60, places = listOf(school))
        // 30 km from the edge at 30 m/s is 1000 s, 16 minutes and 40 seconds: sooner than an hour.
        val (soon, why) = LocationSchedule.interval(location, fixNorth(150.0 + 30_000.0 + 10))
        assertEquals(1_000_000.0, soon.toDouble(), 5.0)
        assertEquals(WireFixReason.PLACE, why)
        // Right at the edge: 5 minutes.
        assertEquals(5 * minute to WireFixReason.PLACE, LocationSchedule.interval(location, fixNorth(150.0)))
        // 200 km away: the usual hour.
        assertEquals(60 * minute to WireFixReason.PERIODIC, LocationSchedule.interval(location, fixNorth(200_000.0)))
        // A mock fix, or no places: the usual interval.
        assertEquals(60 * minute to WireFixReason.PERIODIC, LocationSchedule.interval(location, fixNorth(150.0, mock = true)))
        assertEquals(60 * minute to WireFixReason.PERIODIC, LocationSchedule.interval(periodic(every = 60), fixNorth(150.0)))
    }

    @Test
    fun `fixes only within hours, the next start otherwise`() {
        val hours = WireHours("07:00", "21:00")
        val location = periodic(hours = hours)
        val night = at("2026-11-17T23:00")
        assertEquals(LocationSchedule.Due(at("2026-11-18T07:00"), WireFixReason.PERIODIC), LocationSchedule.nextPeriodic(location, null, null, night, zone))
        val early = at("2026-11-17T05:00")
        assertEquals(at("2026-11-17T07:00"), LocationSchedule.nextPeriodic(location, null, null, early, zone)?.at)
        // 20:50 plus 30 minutes is past 21:00: the next morning.
        val tried = at("2026-11-17T20:50")
        assertEquals(at("2026-11-18T07:00"), LocationSchedule.nextPeriodic(location, tried, null, tried + minute, zone)?.at)
        assertTrue(LocationSchedule.within(hours, at("2026-11-17T07:00"), zone))
        assertFalse(LocationSchedule.within(hours, at("2026-11-17T21:00"), zone))
    }

    @Test
    fun `hours that end at or before they start run past midnight, and equal ones all day`() {
        val night = WireHours("21:00", "07:00")
        assertTrue(LocationSchedule.within(night, at("2026-11-17T23:30"), zone))
        assertTrue(LocationSchedule.within(night, at("2026-11-18T06:59"), zone))
        assertFalse(LocationSchedule.within(night, at("2026-11-18T12:00"), zone))
        assertEquals(at("2026-11-18T21:00"), LocationSchedule.nextWithin(night, at("2026-11-18T12:00"), zone))
        assertTrue(LocationSchedule.within(WireHours("08:00", "08:00"), at("2026-11-18T03:00"), zone))
        assertTrue(LocationSchedule.within(null, at("2026-11-18T03:00"), zone))
        assertTrue(LocationSchedule.within(WireHours("8 am", "9 pm"), at("2026-11-18T03:00"), zone), "hours that don't parse: all day")
    }

    @Test
    fun `a window's start on the night clocks go forward moves past the gap`() {
        // 2027-03-14 02:00 doesn't exist in New York: 02:30 is 03:30.
        val hours = WireHours("02:30", "06:00")
        assertEquals(at("2027-03-14T03:30"), LocationSchedule.nextWithin(hours, at("2027-03-14T01:00"), zone))
    }

    @Test
    fun `lost mode takes a fix every 5 minutes, at any hour, and the first at once`() {
        val now = at("2026-11-17T03:00")
        val lost = WireLocation(lost = WireLost(now - minute, "This phone is lost. Please call 555-0100"))
        assertEquals(now, LocationSchedule.nextLost(lost, null, now))
        assertEquals(now - minute + 5 * minute, LocationSchedule.nextLost(lost, now - minute, now))
        assertNull(LocationSchedule.nextLost(WireLocation(mode = WireLocationMode.PERIODIC), null, now))
    }

    @Test
    fun `a last try in the future, after the clock went back, counts as now`() {
        val now = at("2026-11-17T10:00")
        assertEquals(now, LocationSchedule.nextPeriodic(periodic(), now + 3_600_000, null, now, zone)?.at)
        val lost = WireLocation(lost = WireLost(now, "Lost"))
        assertEquals(now, LocationSchedule.nextLost(lost, now + 3_600_000, now))
    }
}
