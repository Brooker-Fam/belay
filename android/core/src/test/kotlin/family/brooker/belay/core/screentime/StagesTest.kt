package family.brooker.belay.core.screentime

import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.HOMEWORK
import family.brooker.belay.core.screentime.Fx.MATH
import family.brooker.belay.core.screentime.Fx.RACER
import family.brooker.belay.core.screentime.Fx.VIDEO
import java.time.DayOfWeek
import java.time.LocalTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StagesTest {
    private val everyDay = DayOfWeek.entries.toSet()
    private val weekend = setOf(DayOfWeek.SATURDAY, DayOfWeek.SUNDAY)
    private val schoolNights = listOf(WireDay.SUN, WireDay.MON, WireDay.TUE, WireDay.WED, WireDay.THU)

    private val total = WireLimit("l-total", "Phone", listOf(WireLimit.EVERY_APP), 90)
    private val games = WireLimit("l-games", "Games", listOf(BLOCKS, RACER), 60)
    private val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", schoolNights, "21:00", "07:00")

    private fun rules(
        limits: List<WireLimit> = listOf(total, games),
        schedules: List<WireSchedule> = listOf(bedtime),
        exempt: List<String> = emptyList(),
        selfServe: WireSelfServe? = null,
        ifUnmeasured: WireIfUnmeasured = WireIfUnmeasured.PAUSE_LIMITED,
        warnBefore: Int = 5,
    ) = WireScreenTime(
        measure = true, zone = "America/New_York", limits = limits, schedules = schedules, exempt = exempt,
        selfServe = selfServe, ifUnmeasured = ifUnmeasured, warnBefore = warnBefore,
    )

    private fun clock(text: String) = KidArg.Clock(LocalTime.parse(text))

    @Test
    fun `the design's example - daily screen time goes from 1 h 30 min to 2 h`() {
        val change = Stages.changes(rules(), rules(limits = listOf(total.copy(minutes = 120), games))).single()
        assertEquals(ChangeKind.LIMIT_MINUTES, change.kind)
        assertEquals(Effect.LOOSENS, change.effect)
        assertEquals("l-total", change.about)
        assertEquals(kid(KidMessage.TOTAL_CHANGES, KidArg.Minutes(90), KidArg.Minutes(120), KidArg.Days(everyDay)), change.kidText)
    }

    @Test
    fun `more minutes on weekends only, and fewer minutes tighten`() {
        val weekends = Stages.changes(rules(), rules(limits = listOf(total, games.copy(byDay = WireByDay(sat = 120, sun = 120))))).single()
        assertEquals(kid(KidMessage.LIMIT_CHANGES, KidArg.Words("Games"), KidArg.Minutes(120), KidArg.Minutes(60), KidArg.Days(weekend)), weekends.kidText)
        assertEquals(Effect.LOOSENS, weekends.effect)
        val fewer = Stages.changes(rules(), rules(limits = listOf(total, games.copy(minutes = 45)))).single()
        assertEquals(Effect.TIGHTENS, fewer.effect)
    }

    @Test
    fun `limits are matched by id, then by their apps, then by name`() {
        val sameApps = Stages.changes(rules(), rules(limits = listOf(total, games.copy(id = "l-new", minutes = 90))))
        assertEquals(listOf(ChangeKind.LIMIT_MINUTES), sameApps.map { it.kind })
        assertEquals("l-new", sameApps.single().about)
        val sameName = Stages.changes(rules(), rules(limits = listOf(total, WireLimit("l-new", "games", listOf(BLOCKS, RACER, VIDEO), 60))))
        assertEquals(
            listOf(RuleChange(ChangeKind.LIMIT_APPS_ADDED, Effect.TIGHTENS, "l-new", kid(KidMessage.LIMIT_APPS_ADDED, KidArg.Words("games"), KidArg.Apps(listOf(VIDEO))))),
            sameName,
        )
        val fewerApps = Stages.changes(rules(), rules(limits = listOf(total, games.copy(packages = listOf(BLOCKS))))).single()
        assertEquals(ChangeKind.LIMIT_APPS_REMOVED, fewerApps.kind)
        assertEquals(Effect.LOOSENS, fewerApps.effect)
    }

    @Test
    fun `a limit added tightens, by its minutes on each day, and one removed loosens`() {
        val video = WireLimit("l-video", "Video", listOf(VIDEO), 30, WireByDay(sat = 60, sun = 60))
        val added = Stages.changes(rules(), rules(limits = listOf(total, games, video)))
        assertEquals(
            listOf(
                kid(KidMessage.LIMIT_ADDED, KidArg.Words("Video"), KidArg.Minutes(30), KidArg.Days(everyDay - weekend)),
                kid(KidMessage.LIMIT_ADDED, KidArg.Words("Video"), KidArg.Minutes(60), KidArg.Days(weekend)),
            ),
            added.map { it.kidText },
        )
        assertTrue(added.all { it.effect == Effect.TIGHTENS })
        val removed = Stages.changes(rules(), rules(limits = listOf(games)))
        assertEquals(listOf(RuleChange(ChangeKind.LIMIT_REMOVED, Effect.LOOSENS, "l-total", kid(KidMessage.TOTAL_REMOVED))), removed)
    }

    @Test
    fun `a daily total and a limit on some apps are never the same limit`() {
        val changes = Stages.changes(rules(limits = listOf(total)), rules(limits = listOf(WireLimit("l-total", "Phone", listOf(VIDEO), 90))))
        assertEquals(listOf(ChangeKind.LIMIT_ADDED, ChangeKind.LIMIT_REMOVED), changes.map { it.kind })
        assertEquals(kid(KidMessage.TOTAL_REMOVED), changes.last().kidText)
    }

    @Test
    fun `bedtime starting later loosens and earlier tightens, and a shift both ways needs a parent`() {
        fun times(start: String, end: String) = Stages.changes(rules(), rules(schedules = listOf(bedtime.copy(start = start, end = end)))).single()
        val later = times("21:30", "07:00")
        assertEquals(Effect.LOOSENS, later.effect)
        assertEquals(
            kid(KidMessage.SCHEDULE_TIMES, KidArg.Words("Bedtime"), clock("21:00"), clock("07:00"), clock("21:30"), clock("07:00")),
            later.kidText,
        )
        assertEquals(Effect.TIGHTENS, times("20:30", "07:00").effect)
        assertEquals(Effect.TIGHTENS, times("21:00", "07:30").effect, "ending later")
        assertEquals(Effect.LOOSENS, times("22:00", "08:00").effect, "an hour later at both ends")
        assertEquals(Effect.LOOSENS, times("00:30", "07:00").effect, "past midnight: it starts the next day")
    }

    @Test
    fun `schedule days, allowed apps and locking`() {
        val changed = bedtime.copy(days = schoolNights + WireDay.FRI - WireDay.SUN, allow = listOf(MATH), lock = true)
        val changes = Stages.changes(rules(), rules(schedules = listOf(changed)))
        assertEquals(
            listOf(
                RuleChange(ChangeKind.SCHEDULE_DAYS_ADDED, Effect.TIGHTENS, "s-bed", kid(KidMessage.SCHEDULE_DAYS_ADDED, KidArg.Words("Bedtime"), KidArg.Days(setOf(DayOfWeek.FRIDAY)))),
                RuleChange(ChangeKind.SCHEDULE_DAYS_REMOVED, Effect.LOOSENS, "s-bed", kid(KidMessage.SCHEDULE_DAYS_REMOVED, KidArg.Words("Bedtime"), KidArg.Days(setOf(DayOfWeek.SUNDAY)))),
                RuleChange(ChangeKind.SCHEDULE_ALLOWS, Effect.LOOSENS, "s-bed", kid(KidMessage.SCHEDULE_ALLOWS, KidArg.Words("Bedtime"), KidArg.Apps(listOf(MATH)))),
                RuleChange(ChangeKind.SCHEDULE_LOCKS, Effect.TIGHTENS, "s-bed", kid(KidMessage.SCHEDULE_LOCKS, KidArg.Words("Bedtime"))),
            ),
            changes,
        )
        val back = Stages.changes(rules(schedules = listOf(changed)), rules())
        assertEquals(
            listOf(ChangeKind.SCHEDULE_DAYS_ADDED, ChangeKind.SCHEDULE_DAYS_REMOVED, ChangeKind.SCHEDULE_NO_LONGER_ALLOWS, ChangeKind.SCHEDULE_NO_LONGER_LOCKS),
            back.map { it.kind },
        )
    }

    @Test
    fun `schedules are matched by id, then kind and name, then kind`() {
        val renamed = bedtime.copy(id = "s-night", name = "Lights out", start = "21:30")
        assertEquals(listOf(ChangeKind.SCHEDULE_TIMES), Stages.changes(rules(), rules(schedules = listOf(renamed))).map { it.kind })
        val school = WireSchedule("s-school", WireScheduleKind.SCHOOL, "School", listOf(WireDay.MON), "08:00", "15:00")
        val added = Stages.changes(rules(), rules(schedules = listOf(bedtime, school))).single()
        assertEquals(
            RuleChange(
                ChangeKind.SCHEDULE_ADDED, Effect.TIGHTENS, "s-school",
                kid(KidMessage.SCHEDULE_ADDED, KidArg.Words("School"), clock("08:00"), clock("15:00"), KidArg.Days(setOf(DayOfWeek.MONDAY))),
            ),
            added,
        )
        assertEquals(
            listOf(RuleChange(ChangeKind.SCHEDULE_REMOVED, Effect.LOOSENS, "s-bed", kid(KidMessage.SCHEDULE_REMOVED, KidArg.Words("Bedtime")))),
            Stages.changes(rules(), rules(schedules = emptyList())),
        )
    }

    @Test
    fun `exempt apps, self-serve, can't count and warnings`() {
        val changes = Stages.changes(
            rules(exempt = listOf(HOMEWORK)),
            rules(exempt = listOf(MATH), selfServe = WireSelfServe(10, 2), ifUnmeasured = WireIfUnmeasured.KEEP_OPEN, warnBefore = 10),
        )
        assertEquals(
            listOf(
                RuleChange(ChangeKind.EXEMPT_ADDED, Effect.LOOSENS, null, kid(KidMessage.EXEMPT_ADDED, KidArg.Apps(listOf(MATH)))),
                RuleChange(ChangeKind.EXEMPT_REMOVED, Effect.TIGHTENS, null, kid(KidMessage.EXEMPT_REMOVED, KidArg.Apps(listOf(HOMEWORK)))),
                RuleChange(ChangeKind.SELF_SERVE, Effect.LOOSENS, null, kid(KidMessage.SELF_SERVE_ALLOWED, KidArg.Count(10), KidArg.Count(2))),
                RuleChange(ChangeKind.IF_UNMEASURED, Effect.LOOSENS, null, kid(KidMessage.UNMEASURED_KEEPS_OPEN)),
                RuleChange(ChangeKind.WARN_BEFORE, Effect.NEITHER, null, kid(KidMessage.WARNING_CHANGES, KidArg.Minutes(10))),
            ),
            changes,
        )
        fun selfServe(from: WireSelfServe?, to: WireSelfServe?) = Stages.changes(rules(selfServe = from), rules(selfServe = to)).single().effect
        assertEquals(Effect.TIGHTENS, selfServe(WireSelfServe(10, 2), WireSelfServe(5, 2)))
        assertEquals(Effect.TIGHTENS, selfServe(WireSelfServe(10, 2), null))
        assertEquals(Effect.LOOSENS, selfServe(WireSelfServe(10, 2), WireSelfServe(5, 4)), "fewer minutes but more times")
        assertEquals(Effect.TIGHTENS, Stages.changes(rules(ifUnmeasured = WireIfUnmeasured.KEEP_OPEN), rules()).single().effect)
    }

    @Test
    fun `the same rules change nothing, and extra time, the zone and measure aren't a stage's`() {
        assertEquals(emptyList(), Stages.changes(rules(), rules()))
        val today = rules().copy(
            zone = "America/Los_Angeles", measure = false, dayStarts = "04:00",
            extra = listOf(WireExtra("x-1", "l-games", 15, "2026-11-17")),
        )
        assertEquals(emptyList(), Stages.changes(rules(), today))
        assertEquals(listOf(ChangeKind.LIMIT_REMOVED, ChangeKind.LIMIT_REMOVED, ChangeKind.SCHEDULE_REMOVED), Stages.changes(rules(), null).map { it.kind })
    }

    @Test
    fun `what the policy's next stage changes`() {
        val next = rules(limits = listOf(total.copy(minutes = 120), games))
        val policy = WirePolicyPhase3(
            screenTime = rules(),
            stage = WireStage("Explorer", 2, since = 1, next = WireStageNext("Navigator", listOf("Daily screen time goes from 1 h 30 min to 2 h"), screenTime = next)),
        )
        assertEquals(KidMessage.TOTAL_CHANGES, Stages.next(policy).single().kidText.message)
        assertEquals(emptyList(), Stages.next(policy.copy(stage = policy.stage?.copy(next = null))))
        assertEquals(emptyList(), Stages.next(policy.copy(stage = policy.stage?.copy(next = WireStageNext("Navigator")))), "only the server's sentences")
        assertEquals(Stages.next(policy), Stages.changes(Stage("Explorer", 2, rules()), Stage("Navigator", 3, next)))
    }

    @Test
    fun `only a change that only tightens may skip a parent`() {
        val tighter = Stages.changes(rules(), rules(limits = listOf(total.copy(minutes = 60), games)))
        assertTrue(Stages.onlyTightens(tighter))
        val mixed = Stages.changes(rules(), rules(limits = listOf(total.copy(minutes = 60), games.copy(minutes = 90))))
        assertFalse(Stages.onlyTightens(mixed))
        assertFalse(Stages.onlyTightens(emptyList()))
        assertFalse(Stages.onlyTightens(Stages.changes(rules(), rules(warnBefore = 1))), "a warning change isn't a tightening")
    }
}
