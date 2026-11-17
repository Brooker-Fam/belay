package family.brooker.belay.core.screentime

import family.brooker.belay.core.screentime.Fx.BELAY
import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.CLOCK
import family.brooker.belay.core.screentime.Fx.DIALER
import family.brooker.belay.core.screentime.Fx.LAUNCHER
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.RACER
import family.brooker.belay.core.screentime.Fx.SMS
import family.brooker.belay.core.screentime.Fx.VIDEO
import family.brooker.belay.core.screentime.Fx.at
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up apps; a family in New York. */
class NoticesTest {
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")

    private val apps = setOf(BLOCKS, RACER, VIDEO, CLOCK, LAUNCHER, DIALER, SMS, BELAY)
    private val neverBlocked = setOf(LAUNCHER, DIALER, SMS, BELAY)
    private val games = WireLimit("l-games", "Games", listOf(BLOCKS, RACER), 60)
    private val video = WireLimit("l-video", "Video", listOf(VIDEO), 30)
    private val everyDay = WireDay.entries.toList()
    private val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", everyDay, "21:00", "07:00")

    private fun policy(
        limits: List<WireLimit> = listOf(games),
        schedules: List<WireSchedule> = emptyList(),
        extra: List<WireExtra> = emptyList(),
    ) = WireScreenTime(measure = true, zone = "America/New_York", limits = limits, schedules = schedules, extra = extra)

    /** [name] on the screen from [from] for [minutes], the screen on and unlocked then. */
    private fun usage(asOf: Long, name: String = BLOCKS, from: String = "15:00", minutes: Long = 0): UsageLog {
        if (minutes == 0L) return UsageLog(from = t("00:00"), asOf = asOf)
        val span = Span(t(from), t(from) + minutes * MIN)
        return UsageLog(from = t("00:00"), asOf = asOf, apps = mapOf(name to listOf(span)), screen = listOf(span))
    }

    private fun decide(
        policy: WireScreenTime,
        now: Long,
        usage: UsageLog = usage(now),
        foreground: List<String> = emptyList(),
        measured: Boolean = true,
    ) = Rules.evaluate(Rules.Input(policy, now, NY, usage, foreground, measured, apps, neverBlocked, keepOpen = setOf(CLOCK)))

    @Test
    fun `a warning shows once per key, and again a minute before`() {
        val first = Notices.plan(decide(policy(), t("15:56"), usage(t("15:56"), minutes = 56), listOf(BLOCKS)), ScreenTimeState(), t("15:56"))
        val warning = first.show.single()
        assertEquals(NoticeSlot.Warning, warning.slot)
        assertEquals(KidText(KidMessage.LIMIT_LEFT, listOf(KidArg.Minutes(4), KidArg.Words("Games"))), warning.text)
        assertEquals(t("16:00"), warning.until)

        val again = Notices.plan(decide(policy(), t("15:57"), usage(t("15:57"), minutes = 57), listOf(BLOCKS)), first.state, t("15:57"))
        assertEquals(emptyList(), again.show, "the same warning doesn't show twice")

        val lastMinute = Notices.plan(decide(policy(), t("15:59"), usage(t("15:59"), minutes = 59), listOf(BLOCKS)), again.state, t("15:59"))
        assertEquals(KidText(KidMessage.LIMIT_LEFT, listOf(KidArg.Minutes(1), KidArg.Words("Games"))), lastMinute.show.single().text)
    }

    @Test
    fun `only the soonest of several warnings shows`() {
        val both = policy(limits = listOf(games, video.copy(packages = listOf(VIDEO, BLOCKS), minutes = 58)))
        val plan = Notices.plan(decide(both, t("15:55"), usage(t("15:55"), minutes = 55), listOf(BLOCKS)), ScreenTimeState(), t("15:55"))
        val shown = plan.show.single()
        assertEquals(t("15:58"), shown.until, "Video runs out first")
        assertEquals(2, plan.state.shown.keys.count { it.startsWith("limit:") }, "both count as shown")
    }

    @Test
    fun `time's up shows once a limit is used up, goes when extra time opens it, and shows when that runs out`() {
        val up = Notices.plan(decide(policy(), t("16:00"), usage(t("16:00"), minutes = 60)), ScreenTimeState(), t("16:00"))
        val notice = up.show.single()
        assertEquals(NoticeSlot.TimesUp("l-games"), notice.slot)
        assertEquals(KidMessage.LIMIT_UP, notice.text.message)
        assertEquals(t("2026-11-18T00:00"), notice.until, "it comes back when the day turns")
        assertEquals(setOf("up:l-games"), up.state.showing)

        val still = Notices.plan(decide(policy(), t("16:30"), usage(t("16:30"), minutes = 60)), up.state, t("16:30"))
        assertEquals(emptyList(), still.show)
        assertEquals(emptyList(), still.cancel)

        val extra = policy(extra = listOf(WireExtra("x-1", "l-games", 15, "2026-11-17")))
        val opened = Notices.plan(decide(extra, t("16:40"), usage(t("16:40"), minutes = 60)), still.state, t("16:40"))
        assertEquals(listOf("up:l-games"), opened.cancel)
        assertEquals(emptySet(), opened.state.showing)

        val againUp = Notices.plan(decide(extra, t("17:20"), usage(t("17:20"), minutes = 75)), opened.state, t("17:20"))
        assertEquals(NoticeSlot.TimesUp("l-games"), againUp.show.single().slot, "the extra time ran out too")
    }

    @Test
    fun `a limit of 0 minutes nobody used isn't news`() {
        val zero = policy(limits = listOf(games.copy(minutes = 0)))
        val plan = Notices.plan(decide(zero, t("08:00")), ScreenTimeState(), t("08:00"))
        assertEquals(emptyList(), plan.show)
    }

    @Test
    fun `a schedule shows when it starts, once each time it runs, and goes when it ends`() {
        val bed = policy(schedules = listOf(bedtime))
        val start = Notices.plan(decide(bed, t("21:00")), ScreenTimeState(), t("21:00"))
        val notice = start.show.single()
        assertEquals(NoticeSlot.Schedule("s-bed"), notice.slot)
        assertEquals(KidMessage.BEDTIME_UNTIL, notice.text.message)
        assertEquals(t("2026-11-18T07:00"), notice.until)

        val later = Notices.plan(decide(bed, t("23:00")), start.state, t("23:00"))
        assertEquals(emptyList(), later.show)

        val morning = Notices.plan(decide(bed, t("2026-11-18T07:00")), later.state, t("2026-11-18T07:00"))
        assertEquals(listOf("schedule:s-bed"), morning.cancel)

        val nextNight = Notices.plan(decide(bed, t("2026-11-18T21:00")), morning.state, t("2026-11-18T21:00"))
        assertEquals(NoticeSlot.Schedule("s-bed"), nextNight.show.single().slot)
    }

    @Test
    fun `usage access off shows once until it's back on, then goes`() {
        val off = Notices.plan(decide(policy(), t("10:00"), measured = false), ScreenTimeState(), t("10:00"))
        assertEquals(KidMessage.UNMEASURED_PAUSED, off.show.single().text.message)
        assertEquals(t("10:00"), off.state.unmeasuredSince)

        val stillOff = Notices.plan(decide(policy(), t("10:30"), measured = false), off.state, t("10:30"))
        assertEquals(emptyList(), stillOff.show)

        val back = Notices.plan(decide(policy(), t("11:00")), stillOff.state, t("11:00"))
        assertEquals(listOf("unmeasured"), back.cancel)
        assertNull(back.state.unmeasuredSince)

        val offAgain = Notices.plan(decide(policy(), t("12:00"), measured = false), back.state, t("12:00"))
        assertEquals(NoticeSlot.Unmeasured, offAgain.show.single().slot)
    }

    @Test
    fun `with keep_open, the notice only says Belay can't count`() {
        val open = policy().copy(ifUnmeasured = WireIfUnmeasured.KEEP_OPEN)
        val plan = Notices.plan(decide(open, t("10:00"), measured = false), ScreenTimeState(), t("10:00"))
        assertEquals(KidMessage.UNMEASURED, plan.show.single().text.message)
    }

    @Test
    fun `time's up makes the warning before it old news`() {
        val plan = Notices.plan(decide(policy(), t("16:00"), usage(t("16:00"), minutes = 60)), ScreenTimeState(), t("16:00"))
        assertTrue(NoticeSlot.Warning.tag in plan.cancel)
    }

    @Test
    fun `what shows for a limit that's gone from the policy goes too`() {
        val up = Notices.plan(decide(policy(), t("16:00"), usage(t("16:00"), minutes = 60)), ScreenTimeState(), t("16:00"))
        val gone = Notices.plan(decide(policy(limits = emptyList()), t("16:05")), up.state, t("16:05"))
        assertEquals(listOf("up:l-games"), gone.cancel)
    }

    @Test
    fun `without screen time, everything it put up goes`() {
        val state = ScreenTimeState(showing = setOf("up:l-games", "schedule:s-bed"))
        assertEquals(setOf("up:l-games", "schedule:s-bed", "warning", "unmeasured"), Notices.clear(state).toSet())
    }
}
