package family.brooker.belay.core.screentime

import family.brooker.belay.core.WirePause
import family.brooker.belay.core.screentime.Fx.BELAY
import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.CHAT
import family.brooker.belay.core.screentime.Fx.CLOCK
import family.brooker.belay.core.screentime.Fx.DIALER
import family.brooker.belay.core.screentime.Fx.EMERGENCY
import family.brooker.belay.core.screentime.Fx.HOMEWORK
import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.LA
import family.brooker.belay.core.screentime.Fx.LAUNCHER
import family.brooker.belay.core.screentime.Fx.MATH
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.RACER
import family.brooker.belay.core.screentime.Fx.SMS
import family.brooker.belay.core.screentime.Fx.VIDEO
import family.brooker.belay.core.screentime.Fx.at
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RulesTest {
    /** A time on Tuesday 2026-11-17 in New York, or a full local date-time. */
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")

    private val apps = setOf(BLOCKS, RACER, VIDEO, CHAT, MATH, HOMEWORK, CLOCK, LAUNCHER, DIALER, SMS, BELAY)
    private val neverBlocked = setOf(LAUNCHER, DIALER, SMS, EMERGENCY, BELAY)
    private val keepOpen = setOf(CLOCK)

    private val weekdays = listOf(WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU, WireDay.FRI)
    private val schoolNights = listOf(WireDay.SUN, WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU)
    private val games = WireLimit("l-games", "Games", listOf(BLOCKS, RACER), 60)
    private val video = WireLimit("l-video", "Video", listOf(VIDEO), 30)
    private val total = WireLimit("l-total", "Phone", listOf(WireLimit.EVERY_APP), 120)
    private val school = WireSchedule("s-school", WireScheduleKind.SCHOOL, "School", weekdays, "08:00", "15:00", allow = listOf(MATH))
    private val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", schoolNights, "21:00", "07:00", lock = true)

    private fun policy(
        limits: List<WireLimit> = listOf(games, video),
        schedules: List<WireSchedule> = emptyList(),
        extra: List<WireExtra> = emptyList(),
        selfServe: WireSelfServe? = null,
        ifUnmeasured: WireIfUnmeasured = WireIfUnmeasured.PAUSE_LIMITED,
        warnBefore: Int = 5,
        dayStarts: String = "00:00",
        zone: String = "America/New_York",
        measure: Boolean = true,
    ) = WireScreenTime(
        measure = measure, zone = zone, dayStarts = dayStarts, limits = limits, schedules = schedules,
        exempt = listOf(HOMEWORK), ifUnmeasured = ifUnmeasured, extra = extra, selfServe = selfServe, warnBefore = warnBefore,
    )

    /** Each app on the screen for so many minutes this morning, one after another from 00:10. */
    private fun usage(asOf: Long, vararg minutes: Pair<String, Number>): UsageLog {
        var at = t("00:10")
        val spans = linkedMapOf<String, MutableList<Span>>()
        for ((name, m) in minutes) {
            val millis = (m.toDouble() * MIN).toLong()
            spans.getOrPut(name) { mutableListOf() } += Span(at, at + millis)
            at += millis
        }
        return UsageLog(from = t("00:00"), asOf = asOf, apps = spans, screen = listOf(Span(t("00:10"), at)))
    }

    private fun decide(
        policy: WireScreenTime,
        now: Long = t("16:00"),
        usage: UsageLog? = usage(now),
        foreground: List<String> = emptyList(),
        measured: Boolean = true,
        selfServe: List<SelfServeTake> = emptyList(),
        pause: WirePause? = null,
        phoneZone: ZoneId = NY,
    ): Decision = Rules.evaluate(
        Rules.Input(
            policy = policy, now = now, phoneZone = phoneZone, usage = usage, foreground = foreground, measured = measured,
            apps = apps, neverBlocked = neverBlocked, keepOpen = keepOpen, selfServe = selfServe, pause = pause,
        ),
    )

    private fun moment(local: String, day: RelativeDay) = KidArg.Moment(at(local), LocalDateTime.parse(local), day)

    // Limits.

    @Test
    fun `an app's limit pauses it once its minutes are used up`() {
        val open = decide(policy(), usage = usage(t("16:00"), VIDEO to 29))
        assertFalse(VIDEO in open.suspend)
        assertEquals(MIN, open.left[VIDEO])
        val status = open.limits.single { it.id == "l-video" }
        assertEquals(WireLimitState.OPEN, status.state)
        assertEquals(kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(1), KidArg.Words("Video")), status.kidText)

        val up = decide(policy(), usage = usage(t("16:00"), VIDEO to 30))
        val paused = up.suspend.getValue(VIDEO)
        assertEquals(Reason.Limit("l-video", "Video", LimitKind.APP), paused.reason)
        assertEquals(ReasonCode.APP_LIMIT, paused.reason.code)
        assertEquals("limit", paused.reason.code.kind)
        assertEquals(t("2026-11-18T00:00"), paused.opensAt)
        assertEquals(
            kid(KidMessage.LIMIT_UP, KidArg.Words("Video"), moment("2026-11-18T00:00", RelativeDay.TOMORROW)),
            paused.kidText,
            "\"Time's up for Video today. It comes back tomorrow at 12:00 am.\"",
        )
        assertEquals(0L, up.left[VIDEO])
        assertEquals(WireLimitState.USED_UP, up.limits.single { it.id == "l-video" }.state)
        assertEquals(setOf(VIDEO), up.suspend.keys)
    }

    @Test
    fun `a category limit counts its apps together`() {
        val open = decide(policy(), usage = usage(t("16:00"), BLOCKS to 40, RACER to 19))
        assertTrue(open.suspend.isEmpty())
        assertEquals(MIN, open.left[BLOCKS])
        assertEquals(MIN, open.left[RACER])
        val up = decide(policy(), usage = usage(t("16:00"), BLOCKS to 40, RACER to 20))
        assertEquals(setOf(BLOCKS, RACER), up.suspend.keys)
        assertEquals(ReasonCode.CATEGORY_LIMIT, up.suspend.getValue(RACER).reason.code)
    }

    @Test
    fun `two apps side by side count once toward the limit they share`() {
        val log = UsageLog(
            from = t("00:00"), asOf = t("16:00"),
            apps = mapOf(BLOCKS to listOf(Span(t("10:00"), t("10:59"))), RACER to listOf(Span(t("10:30"), t("10:59")))),
        )
        val d = decide(policy(), usage = log)
        assertTrue(d.suspend.isEmpty(), "59 minutes on the screen, not 88")
        assertEquals(59 * MIN, d.limits.single { it.id == "l-games" }.usedMillis)
    }

    @Test
    fun `a daily total counts every app but never-blocked and exempt ones, and pauses all but those and the clock`() {
        val d = decide(
            policy(limits = listOf(total)),
            usage = usage(t("16:00"), BLOCKS to 50, VIDEO to 40, CHAT to 30, DIALER to 60, HOMEWORK to 30),
        )
        assertEquals(120 * MIN, d.limits.single().usedMillis)
        assertEquals(setOf(BLOCKS, RACER, VIDEO, CHAT, MATH), d.suspend.keys)
        assertEquals(ReasonCode.DAILY_TOTAL, d.suspend.getValue(MATH).reason.code)
        assertEquals(kid(KidMessage.TOTAL_UP, moment("2026-11-18T00:00", RelativeDay.TOMORROW)), d.suspend.getValue(CHAT).kidText)
        assertEquals(setOf(BLOCKS, RACER, VIDEO, CHAT, MATH), d.limits.single().packages)
    }

    @Test
    fun `when several limits cover an app, any one used up pauses it`() {
        val byTotal = decide(policy(limits = listOf(games, total)), usage = usage(t("16:00"), BLOCKS to 50, VIDEO to 70))
        assertEquals(listOf<Reason>(Reason.Limit("l-total", "Phone", LimitKind.TOTAL)), byTotal.suspend.getValue(BLOCKS).reasons)
        assertEquals(0L, byTotal.left[BLOCKS], "Games still has 10 minutes, but the total is used up")
        val both = decide(policy(limits = listOf(games, total)), usage = usage(t("16:00"), BLOCKS to 60, VIDEO to 60))
        assertEquals(listOf("l-games", "l-total"), both.suspend.getValue(BLOCKS).reasons.map { (it as Reason.Limit).limitId })
    }

    @Test
    fun `by_day sets the minutes on those days`() {
        val weekend = games.copy(byDay = WireByDay(sat = 120, sun = 120))
        val tuesday = decide(policy(limits = listOf(weekend)), usage = usage(t("16:00"), BLOCKS to 90))
        assertTrue(BLOCKS in tuesday.suspend)
        val saturday = decide(
            policy(limits = listOf(weekend)), now = t("2026-11-21T16:00"),
            usage = UsageLog(t("2026-11-21T00:00"), t("2026-11-21T16:00"), mapOf(BLOCKS to listOf(Span(t("2026-11-21T10:00"), t("2026-11-21T11:30"))))),
        )
        assertFalse(BLOCKS in saturday.suspend)
        assertEquals(30 * MIN, saturday.left[BLOCKS])
    }

    @Test
    fun `a limit of 0 minutes pauses its apps all day`() {
        val noVideoOnTuesdays = video.copy(byDay = WireByDay(tue = 0))
        val d = decide(policy(limits = listOf(noVideoOnTuesdays)), now = t("00:01"), usage = usage(t("00:01")))
        assertEquals(t("2026-11-18T00:00"), d.suspend.getValue(VIDEO).opensAt)
        val never = decide(policy(limits = listOf(video.copy(minutes = 0))), usage = usage(t("16:00")))
        assertNull(never.suspend.getValue(VIDEO).opensAt)
        assertEquals(kid(KidMessage.LIMIT_UP_FOR_NOW, KidArg.Words("Video")), never.suspend.getValue(VIDEO).kidText)
    }

    @Test
    fun `limits reset when the day starts, at day_starts`() {
        val log = UsageLog(t("00:00"), t("2026-11-18T02:00"), mapOf(VIDEO to listOf(Span(t("10:00"), t("10:30")))))
        val four = decide(policy(dayStarts = "04:00"), now = t("2026-11-18T02:00"), usage = log)
        assertEquals("2026-11-17", four.day.toString(), "2 a.m. is still Tuesday's day")
        assertEquals(t("2026-11-18T04:00"), four.suspend.getValue(VIDEO).opensAt)
        assertEquals(t("2026-11-18T04:00"), four.nextAt)
        val midnight = decide(policy(), now = t("2026-11-18T00:05"), usage = log.copy(asOf = t("2026-11-18T00:05")))
        assertTrue(midnight.suspend.isEmpty(), "a new day")
        assertEquals(30 * MIN, midnight.left[VIDEO])
    }

    // Extra time.

    @Test
    fun `a parent's extra time opens a limit again for the day, and is used up as the app is used`() {
        val extra = listOf(WireExtra("x-1", "l-video", 15, "2026-11-17", requestId = "r-1"))
        val reopened = decide(policy(extra = extra), usage = usage(t("16:00"), VIDEO to 30))
        assertFalse(VIDEO in reopened.suspend)
        val status = reopened.limits.single { it.id == "l-video" }
        assertEquals(WireLimitState.EXTRA, status.state)
        assertEquals(15 * MIN, status.leftMillis)
        assertEquals(15 * MIN, status.extraMillis)
        val usedUp = decide(policy(extra = extra), usage = usage(t("16:00"), VIDEO to 45))
        assertTrue(VIDEO in usedUp.suspend)
    }

    @Test
    fun `extra time is for its own day only`() {
        val yesterday = listOf(WireExtra("x-1", "l-video", 15, "2026-11-16"))
        assertTrue(VIDEO in decide(policy(extra = yesterday), usage = usage(t("16:00"), VIDEO to 30)).suspend)
    }

    @Test
    fun `extra time for one app keeps the others under the limit at its usual minutes`() {
        val forBlocks = listOf(WireExtra("x-1", "l-games", 15, "2026-11-17", packageName = BLOCKS))
        val d = decide(policy(extra = forBlocks), usage = usage(t("16:00"), BLOCKS to 60))
        assertFalse(BLOCKS in d.suspend)
        assertEquals(15 * MIN, d.left[BLOCKS])
        assertTrue(RACER in d.suspend)
        assertEquals(WireLimitState.EXTRA, d.limits.single { it.id == "l-games" }.state)
    }

    @Test
    fun `extra time for every limit opens an app under all of them`() {
        val everywhere = listOf(WireExtra("x-1", WireExtra.EVERY_LIMIT, 20, "2026-11-17", packageName = BLOCKS))
        val d = decide(policy(limits = listOf(games, total), extra = everywhere), usage = usage(t("16:00"), BLOCKS to 60, VIDEO to 60))
        assertFalse(BLOCKS in d.suspend)
        assertEquals(20 * MIN, d.left[BLOCKS])
        assertTrue(RACER in d.suspend)
        assertTrue(VIDEO in d.suspend)
    }

    @Test
    fun `self-serve minutes count like extra time`() {
        val take = SelfServeTake("t-1", limitId = "l-video", minutes = 10, day = "2026-11-17", at = t("15:30"))
        val d = decide(policy(selfServe = WireSelfServe(10, 2)), usage = usage(t("16:00"), VIDEO to 30), selfServe = listOf(take))
        assertFalse(VIDEO in d.suspend)
        assertEquals(10 * MIN, d.left[VIDEO])
        assertEquals(SelfServeStatus(minutes = 10, times = 2, taken = 1), d.selfServe)
        assertEquals(kid(KidMessage.SELF_SERVE, KidArg.Count(10), KidArg.Count(1)), d.selfServe?.kidText)
    }

    // Schedules.

    @Test
    fun `school time pauses every app but the allowed ones, never-blocked and exempt apps, and the clock`() {
        val d = decide(policy(schedules = listOf(school)), now = t("10:00"))
        assertEquals(setOf(BLOCKS, RACER, VIDEO, CHAT), d.suspend.keys)
        val paused = d.suspend.getValue(CHAT)
        assertEquals(Reason.Schedule("s-school", WireScheduleKind.SCHOOL, "School", t("15:00")), paused.reason)
        assertEquals(kid(KidMessage.SCHOOL_UNTIL, moment("2026-11-17T15:00", RelativeDay.TODAY), KidArg.Words("School")), paused.kidText)
        assertEquals(t("15:00"), paused.opensAt)
        assertEquals(listOf("s-school"), d.schedules.map { it.id })
        assertTrue(decide(policy(schedules = listOf(school)), now = t("2026-11-21T10:00")).suspend.isEmpty(), "Saturday")
    }

    @Test
    fun `bedtime past midnight holds until the morning, and locks the screen once when it starts`() {
        val night = decide(policy(schedules = listOf(bedtime)), now = t("2026-11-19T22:00"))
        val start = t("2026-11-19T21:00")
        assertEquals(listOf(LockNow("schedule:s-bed:$start", "s-bed")), night.lockNow)
        assertEquals(t("2026-11-20T07:00"), night.schedules.single().until)
        val paused = night.suspend.getValue(BLOCKS)
        assertEquals(kid(KidMessage.BEDTIME_UNTIL, moment("2026-11-20T07:00", RelativeDay.TOMORROW), KidArg.Words("Bedtime")), paused.kidText)
        assertTrue(BLOCKS in decide(policy(schedules = listOf(bedtime)), now = t("2026-11-20T06:59")).suspend, "Friday morning")
        assertTrue(decide(policy(schedules = listOf(bedtime)), now = t("2026-11-20T07:00")).suspend.isEmpty())
        assertTrue(decide(policy(schedules = listOf(bedtime)), now = t("2026-11-20T22:00")).suspend.isEmpty(), "no bedtime on Friday")
    }

    @Test
    fun `a skipped date has no bedtime`() {
        val thanksgiving = bedtime.copy(skip = listOf("2026-11-26"))
        assertTrue(decide(policy(schedules = listOf(thanksgiving)), now = t("2026-11-26T22:00")).suspend.isEmpty())
        assertTrue(decide(policy(schedules = listOf(thanksgiving)), now = t("2026-11-25T22:00")).suspend.isNotEmpty())
    }

    @Test
    fun `when schedules overlap the stricter wins, and the kid hears the one that lasts longest`() {
        val homework = WireSchedule("s-hw", WireScheduleKind.CUSTOM, "Homework hour", weekdays, "14:00", "16:00")
        val d = decide(policy(schedules = listOf(school, homework)), now = t("14:30"))
        assertTrue(MATH in d.suspend, "school allows it, homework hour doesn't")
        val reasons = d.suspend.getValue(BLOCKS).reasons
        assertEquals(listOf("s-hw", "s-school"), reasons.map { (it as Reason.Schedule).scheduleId })
        assertEquals(kid(KidMessage.SCHEDULE_UNTIL, KidArg.Words("Homework hour"), moment("2026-11-17T16:00", RelativeDay.TODAY)), d.suspend.getValue(BLOCKS).kidText)
        assertEquals(t("16:00"), d.suspend.getValue(BLOCKS).opensAt)
    }

    @Test
    fun `bedtime ends at 7 on the clock the mornings clocks change`() {
        val everyNight = bedtime.copy(days = WireDay.entries)
        val fall = decide(policy(schedules = listOf(everyNight)), now = t("2026-11-01T06:30"))
        assertEquals(t("2026-11-01T07:00"), fall.schedules.single().until)
        assertEquals(t("2026-11-01T07:00"), fall.nextAt)
        assertEquals(11 * HOUR, fall.schedules.single().until - fall.schedules.single().from)
        val spring = decide(policy(schedules = listOf(everyNight)), now = t("2026-03-08T06:30"))
        assertEquals(t("2026-03-08T07:00"), spring.nextAt)
        assertEquals(9 * HOUR, spring.schedules.single().until - spring.schedules.single().from)
    }

    // Can't count.

    @Test
    fun `while Belay can't count, pause_limited pauses every app with a limit, and schedules still work`() {
        val d = decide(policy(), usage = usage(t("16:00"), BLOCKS to 10), measured = false)
        assertEquals(setOf(BLOCKS, RACER, VIDEO), d.suspend.keys)
        val paused = d.suspend.getValue(BLOCKS)
        assertEquals(listOf<Reason>(Reason.Unmeasured), paused.reasons)
        assertNull(paused.opensAt, "it opens when usage access is back")
        assertEquals(kid(KidMessage.UNMEASURED_PAUSED), paused.kidText)
        assertEquals(kid(KidMessage.UNMEASURED_PAUSED), d.unmeasured)
        assertEquals(kid(KidMessage.LIMIT_NOT_COUNTED, KidArg.Words("Games")), d.limits.single { it.id == "l-games" }.kidText)
        assertFalse(d.measured)
        val atSchool = decide(policy(schedules = listOf(school)), now = t("10:00"), usage = usage(t("10:00")), measured = false)
        assertEquals(listOf(ReasonCode.SCHOOL, ReasonCode.UNMEASURED), atSchool.suspend.getValue(BLOCKS).reasons.map { it.code })
        assertEquals(listOf(ReasonCode.SCHOOL), atSchool.suspend.getValue(CHAT).reasons.map { it.code })
    }

    @Test
    fun `with a daily total, can't count pauses every app but the protected ones`() {
        val d = decide(policy(limits = listOf(total)), measured = false)
        assertEquals(setOf(BLOCKS, RACER, VIDEO, CHAT, MATH), d.suspend.keys)
    }

    @Test
    fun `keep_open keeps apps open while Belay can't count, but a limit already used up stays used up`() {
        val d = decide(
            policy(ifUnmeasured = WireIfUnmeasured.KEEP_OPEN), usage = usage(t("16:00"), VIDEO to 30, BLOCKS to 50),
            foreground = listOf(BLOCKS), measured = false,
        )
        assertEquals(setOf(VIDEO), d.suspend.keys, "turning usage access off can't reopen Video")
        assertEquals(listOf<Reason>(Reason.Limit("l-video", "Video", LimitKind.APP)), d.suspend.getValue(VIDEO).reasons)
        assertEquals(kid(KidMessage.UNMEASURED), d.unmeasured)
        assertFalse(d.boundaries.any { it.kind == BoundaryKind.LIMIT_RUNS_OUT }, "nothing runs out while nothing is counted")
        assertTrue(d.warnings.isEmpty())
    }

    // Never paused.

    @Test
    fun `never-blocked apps are never paused, whatever the rules say, so 911 and 988 always work`() {
        val calls = WireLimit("l-calls", "Calls", listOf(DIALER, SMS), 0)
        val d = decide(
            policy(limits = listOf(calls, total.copy(minutes = 0)), schedules = listOf(bedtime)),
            now = t("22:00"), measured = false, pause = WirePause(until = null),
        )
        assertTrue(d.suspend.keys.none { it in neverBlocked || it in keepOpen || it == HOMEWORK })
        assertEquals(setOf(BLOCKS, RACER, VIDEO, CHAT, MATH), d.suspend.keys)
        assertTrue("$DIALER can't have a time limit: Belay never pauses it." in d.problems)
        assertTrue("$SMS can't have a time limit: Belay never pauses it." in d.problems)
        assertTrue(d.limits.none { it.id == "l-calls" }, "a limit on nothing but never-blocked apps decides nothing")
        assertTrue(d.left.keys.none { it in neverBlocked })
    }

    @Test
    fun `a limit that names the clock still pauses it, but a daily total doesn't`() {
        val clockLimit = WireLimit("l-clock", "Clock", listOf(CLOCK), 0)
        assertTrue(CLOCK in decide(policy(limits = listOf(clockLimit))).suspend)
        assertFalse(CLOCK in decide(policy(limits = listOf(total.copy(minutes = 0)))).suspend)
    }

    // A parent's pause.

    @Test
    fun `a parent's pause comes first, and ends when it says`() {
        val d = decide(policy(), usage = usage(t("16:00"), VIDEO to 30), pause = WirePause(until = t("17:00")))
        assertEquals(setOf(BLOCKS, RACER, VIDEO, CHAT, MATH), d.suspend.keys)
        assertEquals(Reason.Paused(t("17:00")), d.suspend.getValue(VIDEO).reason)
        assertEquals(kid(KidMessage.PAUSED_UNTIL, moment("2026-11-17T17:00", RelativeDay.TODAY)), d.suspend.getValue(CHAT).kidText)
        assertEquals(t("17:00"), d.suspend.getValue(CHAT).opensAt)
        assertEquals(t("2026-11-18T00:00"), d.suspend.getValue(VIDEO).opensAt, "Video's limit still holds after the pause")
        assertEquals(t("17:00"), d.nextAt)
        assertEquals(BoundaryKind.PAUSE_ENDS, d.boundaries.first().kind)
        val untilResumed = decide(policy(), pause = WirePause(until = null))
        assertEquals(kid(KidMessage.PAUSED), untilResumed.suspend.getValue(CHAT).kidText)
        assertNull(untilResumed.suspend.getValue(CHAT).opensAt)
        assertTrue(decide(policy(), pause = WirePause(until = t("15:00"))).suspend.isEmpty(), "over")
    }

    // When to look again.

    @Test
    fun `with nothing else coming, the next boundary is when the day starts`() {
        val d = decide(policy())
        assertEquals(t("2026-11-18T00:00"), d.nextAt)
        assertEquals(listOf(Boundary(t("2026-11-18T00:00"), BoundaryKind.DAY_STARTS)), d.boundaries)
    }

    @Test
    fun `the day clocks go back is 25 hours, so the next day starts an hour later`() {
        val d = decide(policy(), now = t("2026-11-01T12:00"), usage = null)
        assertEquals(t("2026-11-02T00:00"), d.nextAt)
        assertEquals(25 * HOUR, d.days.endOf(d.day) - d.days.startOf(d.day))
        assertEquals(23 * HOUR, decide(policy(), now = t("2026-03-08T12:00"), usage = null).let { it.days.endOf(it.day) - it.days.startOf(it.day) })
    }

    @Test
    fun `the next boundary is when a limit runs out while its app is on the screen, with warnings before`() {
        val watching = decide(policy(), usage = usage(t("16:00"), VIDEO to 20), foreground = listOf(VIDEO))
        assertEquals(t("16:05"), watching.nextAt, "the 5-minute warning")
        assertEquals(
            listOf(
                Boundary(t("16:05"), BoundaryKind.WARNING, "l-video"),
                Boundary(t("16:09"), BoundaryKind.WARNING, "l-video"),
                Boundary(t("16:10"), BoundaryKind.LIMIT_RUNS_OUT, "l-video"),
            ),
            watching.boundaries.filter { it.id == "l-video" },
        )
        assertEquals(t("16:10"), decide(policy(warnBefore = 0), usage = usage(t("16:00"), VIDEO to 20), foreground = listOf(VIDEO)).nextAt)
        assertEquals(t("2026-11-18T00:00"), decide(policy(), usage = usage(t("16:00"), VIDEO to 20)).nextAt, "nothing on the screen")
    }

    @Test
    fun `two apps of a shared limit side by side use it up at the speed of one`() {
        val d = decide(policy(warnBefore = 0), usage = usage(t("16:00"), BLOCKS to 30, RACER to 20), foreground = listOf(BLOCKS, RACER))
        assertEquals(t("16:10"), d.nextAt)
    }

    @Test
    fun `extra time running out is a boundary`() {
        val extra = listOf(WireExtra("x-1", "l-video", 15, "2026-11-17"))
        val d = decide(policy(extra = extra, warnBefore = 0), usage = usage(t("16:00"), VIDEO to 40), foreground = listOf(VIDEO))
        assertEquals(t("16:05"), d.nextAt)
    }

    @Test
    fun `a schedule's start and end are boundaries, with warnings before it starts`() {
        val morning = decide(policy(schedules = listOf(school, bedtime)), now = t("07:00"))
        assertEquals(t("07:55"), morning.nextAt)
        assertEquals(
            listOf(BoundaryKind.WARNING, BoundaryKind.WARNING, BoundaryKind.SCHEDULE_STARTS, BoundaryKind.SCHEDULE_ENDS),
            morning.boundaries.filter { it.id == "s-school" && it.at <= t("15:00") }.map { it.kind },
        )
        val atSchool = decide(policy(schedules = listOf(school, bedtime)), now = t("10:00"))
        assertEquals(Boundary(t("15:00"), BoundaryKind.SCHEDULE_ENDS, "s-school"), atSchool.boundaries.first())
        val evening = decide(policy(schedules = listOf(school, bedtime)), now = t("19:00"))
        assertEquals(Boundary(t("20:55"), BoundaryKind.WARNING, "s-bed"), evening.boundaries.first())
    }

    // Warnings.

    @Test
    fun `the kid is warned 5 minutes and 1 minute before a limit runs out`() {
        val five = decide(policy(), usage = usage(t("16:00"), VIDEO to 26), foreground = listOf(VIDEO)).warnings.single()
        assertEquals("limit:l-video:2026-11-17:30:5", five.key)
        assertEquals(WarningKind.LIMIT_ENDING, five.kind)
        assertEquals(t("16:04"), five.at)
        assertEquals(kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(4), KidArg.Words("Video")), five.kidText)
        val one = decide(policy(), usage = usage(t("16:00"), VIDEO to 29.5), foreground = listOf(VIDEO)).warnings.single()
        assertEquals("limit:l-video:2026-11-17:30:1", one.key)
        assertEquals(kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(1), KidArg.Words("Video")), one.kidText)
        assertTrue(decide(policy(), usage = usage(t("16:00"), VIDEO to 20), foreground = listOf(VIDEO)).warnings.isEmpty())
        assertTrue(decide(policy(warnBefore = 0), usage = usage(t("16:00"), VIDEO to 29.5), foreground = listOf(VIDEO)).warnings.isEmpty())
    }

    @Test
    fun `the kid is warned before bedtime starts`() {
        val start = t("21:00")
        val soon = decide(policy(schedules = listOf(bedtime)), now = t("20:56")).warnings.single()
        assertEquals("schedule:s-bed:$start:5", soon.key)
        assertEquals(kid(KidMessage.BEDTIME_SOON, KidArg.Minutes(4), KidArg.Words("Bedtime")), soon.kidText)
        assertEquals("schedule:s-bed:$start:1", decide(policy(schedules = listOf(bedtime)), now = t("20:59:30")).warnings.single().key)
    }

    // When a paused app opens again.

    @Test
    fun `a used-up app comes back when the day starts, unless bedtime still holds it then`() {
        val noBedtime = decide(policy(), usage = usage(t("16:00"), BLOCKS to 60))
        assertEquals(t("2026-11-18T00:00"), noBedtime.suspend.getValue(BLOCKS).opensAt)
        val withBedtime = decide(policy(schedules = listOf(bedtime)), usage = usage(t("16:00"), BLOCKS to 60))
        val paused = withBedtime.suspend.getValue(BLOCKS)
        assertEquals(t("2026-11-18T07:00"), paused.opensAt)
        assertEquals(
            kid(KidMessage.LIMIT_UP, KidArg.Words("Games"), moment("2026-11-18T07:00", RelativeDay.TOMORROW)),
            paused.kidText,
            "\"It comes back tomorrow at 7:00 am\", not at midnight",
        )
        val status = withBedtime.limits.single { it.id == "l-games" }
        assertEquals(t("2026-11-18T07:00"), status.opensAt)
        assertEquals(t("2026-11-18T00:00"), status.resetsAt)
    }

    // Reading the policy.

    @Test
    fun `rules Belay can't read are left out and reported, never guessed`() {
        val d = decide(
            WireScreenTime(
                zone = "Mars/Olympus_Mons",
                dayStarts = "4am",
                limits = listOf(WireLimit("l-bad", "Bad", listOf(VIDEO), 2000), games, WireLimit("l-games", "Again", listOf(CHAT), 10)),
                schedules = listOf(school.copy(id = "s-bad", start = "8am")),
                extra = listOf(WireExtra("x-bad", "l-games", 10, "tomorrow")),
            ),
            usage = usage(t("16:00"), CHAT to 30, VIDEO to 40),
        )
        assertTrue(d.suspend.isEmpty())
        assertEquals(listOf("l-games"), d.limits.map { it.id })
        assertEquals(NY, d.days.zone, "the phone's zone")
        assertEquals(t("2026-11-18T00:00"), d.nextAt, "days start at midnight")
        assertEquals(6, d.problems.size, d.problems.joinToString("\n"))
        listOf("Limit l-bad", "Limit l-games", "Schedule s-bad", "Extra time x-bad", "The zone", "day_starts").forEach { start ->
            assertTrue(d.problems.any { it.startsWith(start) }, start)
        }
    }

    @Test
    fun `a policy zone of phone follows the phone`() {
        val d = decide(policy(zone = WireScreenTime.ZONE_PHONE), now = at("2026-11-17T23:30", LA), usage = null, phoneZone = LA)
        assertEquals("2026-11-17", d.day.toString())
        assertEquals(at("2026-11-18T00:00", LA), d.nextAt)
    }

    @Test
    fun `a phone that changes zone mid-day counts the day in its new zone, each minute in one day only`() {
        // 1:00 to 2:00 a.m. in New York is 10:00 to 11:00 p.m. the day before in Los Angeles.
        val log = UsageLog(t("00:00"), t("10:00"), mapOf(BLOCKS to listOf(Span(t("01:00"), t("02:00")))))
        val phone = policy(zone = WireScreenTime.ZONE_PHONE)
        val inNewYork = decide(phone, now = t("10:00"), usage = log, phoneZone = NY)
        assertEquals("2026-11-17", inNewYork.day.toString())
        assertTrue(BLOCKS in inNewYork.suspend)
        val inLosAngeles = decide(phone, now = t("10:00"), usage = log, phoneZone = LA)
        assertEquals("2026-11-17", inLosAngeles.day.toString())
        assertFalse(BLOCKS in inLosAngeles.suspend, "that hour belongs to the 16th in Los Angeles")
        assertEquals(60 * MIN, inLosAngeles.left[BLOCKS])
        assertEquals(at("2026-11-18T00:00", LA), inLosAngeles.nextAt)
    }

    // What the phone reports and shows.

    @Test
    fun `the enforcement report has minutes only when measure is on`() {
        val log = usage(t("16:00"), VIDEO to 29.5, BLOCKS to 10)
        val take = SelfServeTake("t-1", minutes = 10, day = "2026-11-17", at = t("15:00"))
        val old = SelfServeTake("t-0", minutes = 10, day = "2026-11-16", at = t("2026-11-16T15:00"))
        val measured = decide(policy(selfServe = WireSelfServe(10, 2)), now = t("16:00"), usage = log, selfServe = listOf(take, old)).status()
        assertEquals("2026-11-17", measured.day)
        assertTrue(measured.measured)
        assertEquals(39, measured.usedMinutes)
        val video = measured.limits.single { it.id == "l-video" }
        assertEquals(WireLimitStatus("l-video", used = 29, left = 11, state = WireLimitState.OPEN), video, "10 self-serve minutes for every limit")
        assertEquals(listOf(WireSelfServeTake(WireExtra.EVERY_LIMIT, null, 10, t("15:00"))), measured.selfServe)
        val private = decide(policy(measure = false), usage = log).status()
        assertNull(private.usedMinutes)
        assertTrue(private.limits.all { it.used == null && it.left == null })
        val atSchool = decide(policy(schedules = listOf(school)), now = t("10:00")).status()
        assertEquals(WireScheduleNow("s-school", t("15:00")), atSchool.schedule)
    }

    @Test
    fun `the Today screen lists the schedule, each limit and self-serve`() {
        val d = decide(policy(schedules = listOf(school), selfServe = WireSelfServe(10, 2)), now = t("10:00"), usage = usage(t("10:00"), BLOCKS to 20))
        assertEquals(
            listOf(
                kid(KidMessage.SCHOOL_UNTIL, moment("2026-11-17T15:00", RelativeDay.TODAY), KidArg.Words("School")),
                kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(40), KidArg.Words("Games")),
                kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(30), KidArg.Words("Video")),
                kid(KidMessage.SELF_SERVE, KidArg.Count(10), KidArg.Count(2)),
            ),
            d.today(),
        )
        val paused = decide(policy(), pause = WirePause(until = t("17:00")), measured = false)
        assertEquals(listOf(KidMessage.PAUSED_UNTIL, KidMessage.UNMEASURED_PAUSED), paused.today().take(2).map { it.message })
    }

    @Test
    fun `more time is asked for the limit that paused the app`() {
        val d = decide(policy(limits = listOf(games, total)), usage = usage(t("16:00"), BLOCKS to 60, VIDEO to 10))
        assertEquals("l-games", MoreTime.limitFor(d, BLOCKS))
        assertEquals("l-total", MoreTime.limitFor(d, VIDEO), "not paused: the limit with the least time left")
        assertNull(MoreTime.limitFor(d, DIALER))
        assertEquals(50, d.leftMinutes(VIDEO))
        assertNull(d.leftMinutes(DIALER))
    }

    @Test
    fun `a moment says whether it's today, tomorrow or later`() {
        val now = t("16:00")
        assertEquals(RelativeDay.TODAY, KidArg.Moment.of(t("23:59"), now, NY).day)
        assertEquals(RelativeDay.TOMORROW, KidArg.Moment.of(t("2026-11-18T00:00"), now, NY).day)
        assertEquals(RelativeDay.LATER, KidArg.Moment.of(t("2026-11-19T07:00"), now, NY).day)
        assertEquals(LocalDateTime.parse("2026-11-17T13:00"), KidArg.Moment.of(now, now, LA).local)
    }
}
