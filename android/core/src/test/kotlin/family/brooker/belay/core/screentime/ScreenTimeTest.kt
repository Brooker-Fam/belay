package family.brooker.belay.core.screentime

import family.brooker.belay.core.Wire
import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.CHAT
import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.LA
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.SEC
import family.brooker.belay.core.screentime.Fx.VIDEO
import family.brooker.belay.core.screentime.Fx.at
import family.brooker.belay.core.screentime.UsageEventType.ACTIVITY_PAUSED
import family.brooker.belay.core.screentime.UsageEventType.ACTIVITY_RESUMED
import family.brooker.belay.core.screentime.UsageEventType.ACTIVITY_STOPPED
import family.brooker.belay.core.screentime.UsageEventType.DEVICE_SHUTDOWN
import family.brooker.belay.core.screentime.UsageEventType.DEVICE_STARTUP
import family.brooker.belay.core.screentime.UsageEventType.KEYGUARD_HIDDEN
import family.brooker.belay.core.screentime.UsageEventType.KEYGUARD_SHOWN
import family.brooker.belay.core.screentime.UsageEventType.SCREEN_INTERACTIVE
import family.brooker.belay.core.screentime.UsageEventType.SCREEN_NON_INTERACTIVE
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ScreenTimeTest {
    /** A time on Tuesday 2026-11-17 in New York, or a full local date-time. */
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")

    private val booted = at("2026-01-01T00:00")

    private fun reading(wall: Long, access: Boolean = true, boot: Int = 7, elapsed: Long = wall - booted) =
        UsageReading(wall = wall, elapsed = elapsed, bootCount = boot, usageAccess = access)

    private fun resumed(time: String, pkg: String, cls: String = "Main") = UsageEvent(t(time), ACTIVITY_RESUMED, pkg, "$pkg.$cls")
    private fun paused(time: String, pkg: String, cls: String = "Main") = UsageEvent(t(time), ACTIVITY_PAUSED, pkg, "$pkg.$cls")
    private fun stopped(time: String, pkg: String, cls: String = "Main") = UsageEvent(t(time), ACTIVITY_STOPPED, pkg, "$pkg.$cls")
    private fun device(time: String, type: UsageEventType) = UsageEvent(t(time), type, "android")
    private fun screenOn(time: String) = device(time, SCREEN_INTERACTIVE)
    private fun screenOff(time: String) = device(time, SCREEN_NON_INTERACTIVE)
    private fun locked(time: String) = device(time, KEYGUARD_SHOWN)
    private fun unlocked(time: String) = device(time, KEYGUARD_HIDDEN)

    /** A ledger from [from], with the screen on and unlocked unless said otherwise, read once at [until]. */
    private fun count(
        from: String,
        until: String,
        vararg events: UsageEvent,
        screenOn: Boolean? = true,
        keyguard: Boolean? = false,
    ): UsageUpdate = ScreenTime.advance(ScreenTime.start(t(from), screenOn, keyguard), events.toList(), reading(t(until)))

    private fun UsageLog.total(pkg: String) = millis(pkg, Long.MIN_VALUE, Long.MAX_VALUE)
    private fun UsageLog.screenTotal() = screenMillis(Long.MIN_VALUE, Long.MAX_VALUE)

    // What counts.

    @Test
    fun `an app counts from resumed to stopped, and the screen while it's on and unlocked`() {
        val u = count("10:00", "11:00", resumed("10:00", BLOCKS), paused("10:20", BLOCKS), stopped("10:20", BLOCKS))
        assertEquals(20 * MIN, u.usage.total(BLOCKS))
        assertEquals(60 * MIN, u.usage.screenTotal())
        assertEquals(t("11:00"), u.usage.asOf)
        assertTrue(u.measured)
    }

    @Test
    fun `picture in picture keeps counting until the window closes`() {
        val u = count(
            "10:00", "10:40",
            resumed("10:00", VIDEO), paused("10:10", VIDEO), // into picture in picture
            resumed("10:10", CHAT), paused("10:30", CHAT), stopped("10:30", CHAT),
            stopped("10:40", VIDEO),
        )
        assertEquals(40 * MIN, u.usage.total(VIDEO))
        assertEquals(20 * MIN, u.usage.total(CHAT))
        assertEquals(40 * MIN, u.usage.screenTotal())
    }

    @Test
    fun `split screen counts each app, and the screen once`() {
        val u = count(
            "10:00", "10:35",
            resumed("10:00", BLOCKS), resumed("10:05", VIDEO), stopped("10:30", BLOCKS), stopped("10:35", VIDEO),
        )
        assertEquals(30 * MIN, u.usage.total(BLOCKS))
        assertEquals(30 * MIN, u.usage.total(VIDEO))
        assertEquals(35 * MIN, u.usage.unionMillis(Long.MIN_VALUE, Long.MAX_VALUE) { it == BLOCKS || it == VIDEO })
        assertEquals(35 * MIN, u.usage.screenTotal())
    }

    @Test
    fun `the keyguard pauses an app's time, and turning the screen off ends it`() {
        val u = count(
            "10:00", "10:40",
            resumed("10:00", BLOCKS), locked("10:10"), unlocked("10:15"), screenOff("10:20"),
            screenOn("10:30"), unlocked("10:30"),
        )
        assertEquals(15 * MIN, u.usage.total(BLOCKS), "no stop event, but the screen went off at 10:20")
        assertEquals(25 * MIN, u.usage.screenTotal())
        assertEquals(emptyList(), u.foreground)
    }

    @Test
    fun `an app paused without being resumed is on the screen, as Android counts it`() {
        // In split screen, or behind a see-through window: visible, but not the one in focus.
        val u = count("10:00", "10:20", resumed("10:00", CHAT), paused("10:05", VIDEO, "Player"), stopped("10:15", VIDEO, "Player"))
        assertEquals(10 * MIN, u.usage.total(VIDEO))
    }

    @Test
    fun `a pause after the screen went off doesn't open the app again`() {
        val u = count(
            "10:00", "10:30",
            resumed("10:00", BLOCKS), screenOff("10:10"), paused("10:10", BLOCKS), screenOn("10:20"), unlocked("10:20"),
        )
        assertEquals(10 * MIN, u.usage.total(BLOCKS))
    }

    @Test
    fun `an app whose stop never came counts until the screen goes off`() {
        val u = count("10:00", "10:40", resumed("10:00", BLOCKS), resumed("10:10", VIDEO), screenOff("10:30"))
        assertEquals(30 * MIN, u.usage.total(BLOCKS))
        assertEquals(20 * MIN, u.usage.total(VIDEO))
        assertEquals(30 * MIN, u.usage.screenTotal())
    }

    @Test
    fun `resuming twice counts once, and two activities of one app count as the app`() {
        val again = count("10:00", "10:30", resumed("10:00", BLOCKS), resumed("10:05", BLOCKS), stopped("10:10", BLOCKS))
        assertEquals(10 * MIN, again.usage.total(BLOCKS))
        val two = count(
            "10:00", "10:30",
            resumed("10:00", BLOCKS, "Main"), resumed("10:05", BLOCKS, "Shop"),
            stopped("10:10", BLOCKS, "Main"), stopped("10:20", BLOCKS, "Shop"),
        )
        assertEquals(20 * MIN, two.usage.total(BLOCKS))
        assertEquals(1, two.usage.opens(BLOCKS, Long.MIN_VALUE, Long.MAX_VALUE))
    }

    @Test
    fun `nothing is known about a ledger started in the past until the events say so`() {
        val unknown = count("10:00", "10:30", screenOn("10:05"), unlocked("10:05"), resumed("10:06", BLOCKS), screenOn = null, keyguard = null)
        assertEquals(25 * MIN, unknown.usage.screenTotal())
        assertEquals(24 * MIN, unknown.usage.total(BLOCKS))
        // An app coming to the front means the screen is on.
        val inferred = count("10:00", "10:30", resumed("10:00", BLOCKS), screenOn = null, keyguard = null)
        assertEquals(30 * MIN, inferred.usage.total(BLOCKS))
    }

    // Days.

    @Test
    fun `days are cut at midnight in the family's zone`() {
        val u = count("2026-11-16T23:30", "2026-11-17T01:00", resumed("2026-11-16T23:50", BLOCKS), stopped("2026-11-17T00:20", BLOCKS))
        val days = DayClock(NY)
        fun day(date: String) = LocalDate.parse(date).let { u.usage.millis(BLOCKS, days.startOf(it), days.endOf(it)) }
        assertEquals(10 * MIN, day("2026-11-16"))
        assertEquals(20 * MIN, day("2026-11-17"))
    }

    @Test
    fun `a screen left on all day is 23 hours the day clocks go forward and 25 the day they go back`() {
        val days = DayClock(NY)
        val spring = LocalDate.parse("2026-03-08")
        val forward = count("2026-03-08T00:00", "2026-03-09T00:00")
        assertEquals(23 * HOUR, forward.usage.screenMillis(days.startOf(spring), days.endOf(spring)))
        val fall = LocalDate.parse("2026-11-01")
        val back = count("2026-11-01T00:00", "2026-11-02T00:00")
        assertEquals(25 * HOUR, back.usage.screenMillis(days.startOf(fall), days.endOf(fall)))
    }

    @Test
    fun `a change of zone counts each minute in one day only`() {
        val u = count("00:30", "04:00", resumed("01:00", BLOCKS), stopped("03:00", BLOCKS))
        fun day(clock: DayClock, date: String) = LocalDate.parse(date).let { u.usage.millis(BLOCKS, clock.startOf(it), clock.endOf(it)) }
        assertEquals(2 * HOUR, day(DayClock(NY), "2026-11-17"))
        // 1:00 to 3:00 in New York is 10:00 p.m. to midnight in Los Angeles, the day before.
        assertEquals(2 * HOUR, day(DayClock(LA), "2026-11-16"))
        assertEquals(0L, day(DayClock(LA), "2026-11-17"))
    }

    // Restarts.

    @Test
    fun `a shutdown stops the count, and the time off is a gap`() {
        val u = count(
            "10:00", "11:00",
            resumed("10:00", BLOCKS), device("10:30", DEVICE_SHUTDOWN),
            resumed("10:35", CHAT), // between shutdown and startup: ignored
            device("10:45", DEVICE_STARTUP), screenOn("10:45"), unlocked("10:45"), resumed("10:46", VIDEO),
        )
        assertEquals(30 * MIN, u.usage.total(BLOCKS))
        assertEquals(0L, u.usage.total(CHAT))
        assertEquals(14 * MIN, u.usage.total(VIDEO))
        assertEquals(listOf(Gap(t("10:30"), t("10:45"), WireGapReason.PHONE_OFF)), u.usage.gaps)
        assertEquals(listOf(VIDEO), u.foreground)
    }

    @Test
    fun `after a crash the count stops where it got to, and the rest is a gap`() {
        val first = ScreenTime.advance(ScreenTime.start(t("10:00"), true, false), listOf(resumed("10:00", BLOCKS)), reading(t("10:20")))
        // Android's shutdown event is stamped with its last save, before the cursor: only the startup is new.
        val second = ScreenTime.advance(
            first.ledger,
            listOf(device("10:40", DEVICE_STARTUP), screenOn("10:40"), unlocked("10:40")),
            reading(t("10:50"), boot = 8, elapsed = 12 * MIN),
        )
        assertEquals(20 * MIN - 10 * SEC, second.usage.total(BLOCKS))
        assertEquals(listOf(Gap(t("10:20") - 10 * SEC, t("10:40"), WireGapReason.PHONE_OFF)), second.usage.gaps)
        assertEquals(20 * MIN - 10 * SEC + 10 * MIN, second.usage.screenTotal())
        assertEquals(emptyList(), second.foreground)
    }

    // Reading again.

    private val session = listOf(
        resumed("10:00", BLOCKS), resumed("10:05", VIDEO), stopped("10:20", BLOCKS), locked("10:25"), unlocked("10:28"),
        stopped("10:40", VIDEO), screenOff("10:45"), screenOn("10:50"), unlocked("10:50"), resumed("10:51", BLOCKS),
    )

    @Test
    fun `the same events twice count once`() {
        val once = count("10:00", "11:00", *session.toTypedArray())
        val twice = count("10:00", "11:00", *(session + session).toTypedArray())
        assertEquals(once.usage, twice.usage)
        assertEquals(once.ledger, twice.ledger)
    }

    @Test
    fun `events in any order count the same`() {
        val sorted = count("10:00", "11:00", *session.toTypedArray())
        val shuffled = count("10:00", "11:00", *session.reversed().toTypedArray())
        assertEquals(sorted.usage, shuffled.usage)
    }

    @Test
    fun `reading again from the stored ledger changes nothing`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val first = ScreenTime.advance(start, session, reading(t("10:30")))
        assertEquals(first, ScreenTime.advance(start, session, reading(t("10:30"))), "pure")
        val again = ScreenTime.advance(first.ledger, session, reading(t("10:30")))
        assertEquals(first.ledger, again.ledger)
        assertEquals(first.usage, again.usage)
    }

    @Test
    fun `windows that overlap count every minute once`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val whole = ScreenTime.advance(start, session, reading(t("11:00")))
        val first = ScreenTime.advance(start, session.filter { it.time < t("10:30") }, reading(t("10:30")))
        val second = ScreenTime.advance(first.ledger, session.filter { it.time >= t("10:15") }, reading(t("11:00")))
        assertEquals(whole.usage, second.usage)
        assertEquals(whole.ledger, second.ledger)
        assertEquals(t("11:00") - ScreenTime.SETTLE_MS, second.ledger.cursor)
    }

    @Test
    fun `an event Android records a moment late still counts`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        // At 10:30 the stop at 10:29:58 isn't in Android's list yet.
        val first = ScreenTime.advance(start, listOf(resumed("10:00", BLOCKS)), reading(t("10:30")))
        assertEquals(30 * MIN, first.usage.total(BLOCKS))
        val second = ScreenTime.advance(
            first.ledger,
            listOf(UsageEvent(t("10:29:58"), ACTIVITY_STOPPED, BLOCKS, "$BLOCKS.Main")),
            reading(t("10:31")),
        )
        assertEquals(30 * MIN - 2 * SEC, second.usage.total(BLOCKS))
    }

    @Test
    fun `events at or after the read wait for the next one`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("10:00", BLOCKS), stopped("10:30", BLOCKS)), reading(t("10:30")))
        assertEquals(listOf(BLOCKS), first.foreground)
        val second = ScreenTime.advance(first.ledger, listOf(stopped("10:30", BLOCKS)), reading(t("10:40")))
        assertEquals(30 * MIN, second.usage.total(BLOCKS))
        assertEquals(emptyList(), second.foreground)
    }

    // The clock.

    @Test
    fun `the clock jumping forward doesn't count anything twice`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("10:00", BLOCKS)), reading(t("10:30")))
        // At 10:40 the clock jumps an hour ahead, and Android moves its stored events by the hour too.
        val r = UsageReading(wall = t("10:50") + HOUR, elapsed = t("10:50") - booted, bootCount = 7, usageAccess = true)
        assertEquals(first.ledger.cursor + HOUR, ScreenTime.queryFrom(first.ledger, r))
        val moved = listOf(
            UsageEvent(t("10:00") + HOUR, ACTIVITY_RESUMED, BLOCKS, "$BLOCKS.Main"),
            UsageEvent(t("10:45") + HOUR, ACTIVITY_STOPPED, BLOCKS, "$BLOCKS.Main"),
        )
        val second = ScreenTime.advance(first.ledger, moved, r)
        assertEquals(HOUR, second.clockShift)
        assertEquals(45 * MIN, second.usage.total(BLOCKS))
        assertEquals(listOf(Span(t("11:00"), t("11:45"))), second.usage.apps[BLOCKS], "kept on Android's new clock")
    }

    @Test
    fun `the clock going back doesn't lose anything`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("10:00", BLOCKS)), reading(t("10:30")))
        val r = UsageReading(wall = t("10:50") - HOUR, elapsed = t("10:50") - booted, bootCount = 7, usageAccess = true)
        assertEquals(first.ledger.cursor - HOUR, ScreenTime.queryFrom(first.ledger, r))
        val second = ScreenTime.advance(first.ledger, listOf(UsageEvent(t("10:45") - HOUR, ACTIVITY_STOPPED, BLOCKS, "$BLOCKS.Main")), r)
        assertEquals(-HOUR, second.clockShift)
        assertEquals(45 * MIN, second.usage.total(BLOCKS))
    }

    @Test
    fun `a correction under Android's 2 seconds moves nothing, and neither does a restart`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("10:00", BLOCKS)), reading(t("10:30")))
        val small = UsageReading(wall = t("10:40") + SEC, elapsed = t("10:40") - booted, bootCount = 7, usageAccess = true)
        assertEquals(first.ledger.cursor, ScreenTime.queryFrom(first.ledger, small))
        assertEquals(0L, ScreenTime.advance(first.ledger, emptyList(), small).clockShift)
        // After a restart the time since boot starts again: that's not a clock change.
        val restarted = UsageReading(wall = t("10:40"), elapsed = 5 * MIN, bootCount = 8, usageAccess = true)
        assertEquals(0L, ScreenTime.advance(first.ledger, emptyList(), restarted).clockShift)
        val unknownBoot = UsageReading(wall = t("10:40") + HOUR, elapsed = t("10:40") - booted, bootCount = null, usageAccess = true)
        assertEquals(0L, ScreenTime.advance(first.ledger, emptyList(), unknownBoot).clockShift)
    }

    // Usage access.

    @Test
    fun `without usage access nothing is counted, and the time is a gap until access is back`() {
        val start = ScreenTime.start(t("10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("10:00", BLOCKS)), reading(t("10:10")))
        val off = ScreenTime.advance(first.ledger, emptyList(), reading(t("10:30"), access = false))
        assertFalse(off.measured)
        assertEquals(emptyList(), off.foreground)
        assertEquals(first.ledger.cursor, off.ledger.cursor, "the cursor waits")
        assertTrue(off.ledger.accessOff)
        assertEquals(listOf(Gap(t("10:10") - 10 * SEC, t("10:30"), WireGapReason.NO_USAGE_ACCESS)), off.usage.gaps)
        assertEquals(t("10:30"), off.usage.asOf)
        // Android kept recording: when access is back, the time is counted and the gap is gone.
        val back = ScreenTime.advance(off.ledger, listOf(stopped("10:40", BLOCKS)), reading(t("10:50")))
        assertTrue(back.measured)
        assertEquals(40 * MIN, back.usage.total(BLOCKS))
        assertEquals(emptyList(), back.usage.gaps)
        assertFalse(back.ledger.accessOff)
    }

    @Test
    fun `usage access off for more than a week leaves a gap where Android no longer has the events`() {
        val start = ScreenTime.start(t("2026-11-01T10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("2026-11-01T10:00", BLOCKS)), reading(t("2026-11-01T10:10")))
        val off = ScreenTime.advance(first.ledger, emptyList(), reading(t("2026-11-03T10:00"), access = false))
        val back = ScreenTime.advance(off.ledger, emptyList(), reading(t("2026-11-12T10:00")))
        val skippedTo = t("2026-11-12T10:00") - ScreenTime.MAX_CATCH_UP_MS
        assertEquals(Gap(first.ledger.cursor, skippedTo, WireGapReason.NO_USAGE_ACCESS), back.usage.gaps.single())
        assertEquals(0L, back.usage.millis(BLOCKS, skippedTo, Long.MAX_VALUE), "nothing is assumed about the phone after the gap")
    }

    // The app in front.

    @Test
    fun `the app in front is the one resumed last`() {
        val u = count("10:00", "10:10", resumed("10:00", BLOCKS), resumed("10:05", VIDEO))
        assertEquals(listOf(VIDEO, BLOCKS), u.foreground)
        assertEquals(VIDEO, u.current)
        val back = count("10:00", "10:10", resumed("10:00", BLOCKS), resumed("10:05", VIDEO), resumed("10:07", BLOCKS))
        assertEquals(listOf(BLOCKS, VIDEO), back.foreground)
        val off = count("10:00", "10:10", resumed("10:00", BLOCKS), screenOff("10:08"))
        assertNull(off.current)
        val locked = count("10:00", "10:10", resumed("10:00", BLOCKS), locked("10:08"))
        assertNull(locked.current, "behind the keyguard")
    }

    // Keeping it.

    @Test
    fun `a ledger survives being stored and read back`() {
        val u = count("10:00", "11:00", *session.toTypedArray())
        val json = Wire.json.encodeToString(UsageLedger.serializer(), u.ledger)
        assertEquals(u.ledger, Wire.json.decodeFromString(UsageLedger.serializer(), json))
    }

    @Test
    fun `pruning keeps what runs across the cut whole, so opens stay right`() {
        val u = count("10:00", "11:00", resumed("10:00", BLOCKS), stopped("10:20", BLOCKS), resumed("10:30", VIDEO), stopped("10:50", VIDEO))
        val pruned = ScreenTime.prune(u.ledger, t("10:40"))
        assertEquals(t("10:40"), pruned.log.from)
        assertNull(pruned.log.apps[BLOCKS])
        assertEquals(listOf(Span(t("10:30"), t("10:50"))), pruned.log.apps[VIDEO])
        assertEquals(1, pruned.log.opens(VIDEO, t("10:00"), t("11:00")))
    }

    @Test
    fun `each read keeps a little over a week`() {
        val start = ScreenTime.start(t("2026-11-01T10:00"), true, false)
        val first = ScreenTime.advance(start, listOf(resumed("2026-11-01T10:00", BLOCKS), stopped("2026-11-01T10:30", BLOCKS)), reading(t("2026-11-01T11:00")))
        val later = ScreenTime.advance(first.ledger, emptyList(), reading(t("2026-11-10T11:00")))
        assertNull(later.ledger.log.apps[BLOCKS])
        assertEquals(t("2026-11-10T11:00") - ScreenTime.KEEP_MS, later.ledger.log.from)
    }

    @Test
    fun `event codes are Android's`() {
        assertEquals(ACTIVITY_RESUMED, UsageEventType.of(1))
        assertEquals(ACTIVITY_STOPPED, UsageEventType.of(23))
        assertEquals(DEVICE_STARTUP, UsageEventType.of(27))
        assertNull(UsageEventType.of(7), "USER_INTERACTION isn't read")
        assertEquals(9, UsageEventType.CODES.size)
    }
}
