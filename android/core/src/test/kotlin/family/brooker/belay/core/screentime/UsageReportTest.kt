package family.brooker.belay.core.screentime

import family.brooker.belay.core.Wire
import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.DIALER
import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.LA
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.SEC
import family.brooker.belay.core.screentime.Fx.VIDEO
import family.brooker.belay.core.screentime.Fx.at
import java.time.LocalDate
import java.time.LocalTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class UsageReportTest {
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")
    private fun date(text: String): LocalDate = LocalDate.parse(text)
    private val midnight = DayClock(NY)

    private fun event(time: String, type: UsageEventType, pkg: String = "android") =
        UsageEvent(t(time), type, pkg, if (pkg == "android") null else "$pkg.Main")

    private fun usage(from: String, until: String, vararg events: UsageEvent, screenOn: Boolean? = false): UsageLog =
        ScreenTime.advance(
            ScreenTime.start(t(from), screenOn, keyguardShown = screenOn?.not()),
            events.toList(),
            UsageReading(wall = t(until), elapsed = t(until) - t("2026-01-01T00:00"), bootCount = 3, usageAccess = true),
        ).usage

    /** Two sessions on Tuesday: the morning bus and after school. */
    private val tuesday = usage(
        "2026-11-17T00:00", "2026-11-18T00:10",
        event("07:00", UsageEventType.SCREEN_INTERACTIVE), event("07:01", UsageEventType.KEYGUARD_HIDDEN),
        event("07:02", UsageEventType.ACTIVITY_RESUMED, BLOCKS), event("07:32", UsageEventType.ACTIVITY_STOPPED, BLOCKS),
        event("07:32", UsageEventType.ACTIVITY_RESUMED, VIDEO), event("07:40", UsageEventType.ACTIVITY_STOPPED, VIDEO),
        event("07:45", UsageEventType.SCREEN_NON_INTERACTIVE), event("07:45", UsageEventType.KEYGUARD_SHOWN),
        event("16:00", UsageEventType.SCREEN_INTERACTIVE), event("16:00", UsageEventType.KEYGUARD_HIDDEN),
        event("16:01", UsageEventType.ACTIVITY_RESUMED, BLOCKS), event("16:30", UsageEventType.SCREEN_NON_INTERACTIVE),
    )

    @Test
    fun `a day's screen time, unlocks, apps and hours`() {
        val day = UsageReport.day(tuesday, midnight, date("2026-11-17"))
        assertEquals(74 * MIN, day.screenMillis)
        assertEquals(2, day.unlocks)
        assertEquals(AppDay(59 * MIN, opens = 2), day.apps[BLOCKS])
        assertEquals(AppDay(8 * MIN, opens = 1), day.apps[VIDEO])
        assertEquals(44 * MIN, day.byHour[7])
        assertEquals(30 * MIN, day.byHour[16])
        assertEquals(74 * MIN, day.byHour.sum())
        assertTrue(day.complete)
        assertEquals(day.to, day.asOf)
        assertEquals(emptyList(), day.gaps)
    }

    @Test
    fun `the report rounds to minutes, with the server's names`() {
        val wire = UsageReport.wire(UsageReport.day(tuesday, midnight, date("2026-11-17")))
        assertEquals("2026-11-17", wire.day)
        assertEquals("America/New_York", wire.zone)
        assertEquals(74, wire.screenMinutes)
        assertEquals(listOf(WireUsageApp(BLOCKS, 59, 2), WireUsageApp(VIDEO, 8, 1)), wire.apps, "most used first")
        assertEquals(24, wire.byHour.size)
        assertEquals(44, wire.byHour[7])
        assertTrue(wire.complete)
    }

    @Test
    fun `apps under a minute are left out, and never-blocked apps aren't listed but still count as screen time`() {
        val u = usage(
            "10:00", "11:00",
            event("10:00", UsageEventType.ACTIVITY_RESUMED, DIALER), event("10:10", UsageEventType.ACTIVITY_STOPPED, DIALER),
            UsageEvent(t("10:10"), UsageEventType.ACTIVITY_RESUMED, VIDEO, "$VIDEO.Main"),
            UsageEvent(t("10:10") + 50 * SEC, UsageEventType.ACTIVITY_STOPPED, VIDEO, "$VIDEO.Main"),
            screenOn = true,
        )
        val wire = UsageReport.wire(UsageReport.day(u, midnight, date("2026-11-17")), unlisted = setOf(DIALER))
        assertEquals(emptyList(), wire.apps)
        assertEquals(60, wire.screenMinutes)
        assertEquals(listOf(WireUsageApp(DIALER, 10, 1)), UsageReport.wire(UsageReport.day(u, midnight, date("2026-11-17"))).apps)
    }

    @Test
    fun `at most 500 apps, the most used`() {
        val from = t("10:00")
        val apps = (1..510).associate { "com.example.app$it" to listOf(Span(from, from + it * MIN)) }
        val log = UsageLog(from = t("00:00"), asOf = t("23:00"), apps = apps)
        val wire = UsageReport.wire(UsageReport.day(log, midnight, date("2026-11-17")))
        assertEquals(500, wire.apps.size)
        assertEquals("com.example.app510", wire.apps.first().packageName)
        assertEquals("com.example.app11", wire.apps.last().packageName)
    }

    @Test
    fun `the day clocks go back has two 1 a m hours in one entry, and the day they go forward skips 2 a m`() {
        val fall = UsageReport.day(usage("2026-11-01T00:00", "2026-11-02T00:00", screenOn = true), midnight, date("2026-11-01"))
        assertEquals(25 * HOUR, fall.screenMillis)
        assertEquals(2 * HOUR, fall.byHour[1])
        assertEquals(List(24) { if (it == 1) 120 else 60 }, UsageReport.wire(fall).byHour)
        val spring = UsageReport.day(usage("2026-03-08T00:00", "2026-03-09T00:00", screenOn = true), midnight, date("2026-03-08"))
        assertEquals(23 * HOUR, spring.screenMillis)
        assertEquals(0L, spring.byHour[2])
        assertEquals(23 * 60, UsageReport.wire(spring).byHour.sum())
    }

    @Test
    fun `a day that starts at 4 a m keeps the small hours with the day before`() {
        val four = DayClock(NY, LocalTime.of(4, 0))
        val u = usage("2026-11-17T02:00", "2026-11-17T06:00", event("03:00", UsageEventType.SCREEN_INTERACTIVE), event("05:00", UsageEventType.SCREEN_NON_INTERACTIVE), screenOn = null)
        val monday = UsageReport.day(u, four, date("2026-11-16"))
        assertEquals(HOUR, monday.screenMillis)
        assertEquals(HOUR, monday.byHour[3])
        val tuesday = UsageReport.day(u, four, date("2026-11-17"))
        assertEquals(HOUR, tuesday.byHour[4])
        assertEquals(0, tuesday.unlocks, "the screen came on during Monday's day")
        assertEquals(1, monday.unlocks)
    }

    @Test
    fun `today so far isn't complete, and as_of is how far it was counted`() {
        val u = usage("2026-11-17T00:00", "2026-11-17T10:00", screenOn = true)
        val wire = UsageReport.wire(UsageReport.day(u, midnight, date("2026-11-17")))
        assertFalse(wire.complete)
        assertEquals(t("10:00"), wire.asOf)
        assertEquals(600, wire.screenMinutes)
    }

    @Test
    fun `gaps are cut to the day, and the time before Belay started counting is unknown`() {
        val u = usage(
            "2026-11-17T09:00", "2026-11-18T02:00",
            event("23:00", UsageEventType.DEVICE_SHUTDOWN), event("2026-11-18T01:00", UsageEventType.DEVICE_STARTUP),
            screenOn = true,
        )
        val tue = UsageReport.day(u, midnight, date("2026-11-17"))
        assertEquals(
            listOf(Gap(t("00:00"), t("09:00"), WireGapReason.UNKNOWN), Gap(t("23:00"), t("2026-11-18T00:00"), WireGapReason.PHONE_OFF)),
            tue.gaps,
        )
        val wed = UsageReport.day(u, midnight, date("2026-11-18"))
        assertEquals(listOf(Gap(t("2026-11-18T00:00"), t("2026-11-18T01:00"), WireGapReason.PHONE_OFF)), wed.gaps)
        assertEquals(listOf(date("2026-11-17"), date("2026-11-18")), UsageReport.days(u, midnight).map { it.day })
    }

    @Test
    fun `the same usage reported in another zone`() {
        val wire = UsageReport.wire(UsageReport.day(tuesday, DayClock(LA), date("2026-11-17")))
        assertEquals("America/Los_Angeles", wire.zone)
        // 7:00 a.m. in New York is 4:00 a.m. in Los Angeles.
        assertEquals(44, wire.byHour[4])
        assertEquals(30, wire.byHour[13])
    }

    @Test
    fun `minutes round to the nearest`() {
        assertEquals(0, UsageReport.minutes(29_999))
        assertEquals(1, UsageReport.minutes(30_000))
        assertEquals(1, UsageReport.minutes(89_999))
        assertEquals(2, UsageReport.minutes(90_000))
    }

    @Test
    fun `uploads go in batches of at most 31 days and under the size limit`() {
        val day = UsageReport.wire(UsageReport.day(tuesday, midnight, date("2026-11-17")))
        val forty = List(40) { day.copy(day = date("2026-10-01").plusDays(it.toLong()).toString()) }
        assertEquals(listOf(31, 9), UsageReport.batches(forty).map { it.days.size })
        val size = Wire.json.encodeToString(WireUsageDay.serializer(), day).toByteArray().size
        assertEquals(listOf(2, 2, 1), UsageReport.batches(forty.take(5), maxBytes = 11 + 2 * (size + 1)).map { it.days.size })
        assertEquals(listOf(1, 1), UsageReport.batches(forty.take(2), maxBytes = 10).map { it.days.size }, "a day too big alone still goes")
        UsageReport.batches(forty).forEach {
            assertTrue(Wire.json.encodeToString(UsageRequest.serializer(), it).toByteArray().size <= UsageReport.MAX_BODY_BYTES)
        }
    }
}
