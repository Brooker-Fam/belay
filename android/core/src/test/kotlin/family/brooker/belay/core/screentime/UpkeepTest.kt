package family.brooker.belay.core.screentime

import family.brooker.belay.core.Applied
import family.brooker.belay.core.ApplyOutcome
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.Fixtures
import family.brooker.belay.core.HoldReason
import family.brooker.belay.core.PhoneRoles
import family.brooker.belay.core.WireAppDecision
import family.brooker.belay.core.WireAppPolicy
import family.brooker.belay.core.WireAppState
import family.brooker.belay.core.WireNewApps
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.screentime.Fx.BELAY
import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.CHAT
import family.brooker.belay.core.screentime.Fx.CLOCK
import family.brooker.belay.core.screentime.Fx.DIALER
import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.LAUNCHER
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.RACER
import family.brooker.belay.core.screentime.Fx.SEC
import family.brooker.belay.core.screentime.Fx.VIDEO
import family.brooker.belay.core.screentime.Fx.at
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up apps; a family in New York. */
class UpkeepTest {
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")

    private val games = WireLimit("l-games", "Games", listOf(BLOCKS, RACER), 60)
    private val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", WireDay.entries.toList(), "21:00", "07:00", lock = true)
    private val screenTime = WireScreenTime(measure = true, zone = "America/New_York", limits = listOf(games))

    private val inventory = Fixtures.inventory(
        Fixtures.app(BELAY),
        Fixtures.app(DIALER, system = true),
        Fixtures.app(LAUNCHER, system = true),
        Fixtures.app(CLOCK, system = true),
        Fixtures.app("com.example.service", system = true).copy(launchable = false),
        Fixtures.app(BLOCKS),
        Fixtures.app(RACER),
        Fixtures.app(VIDEO),
        Fixtures.app(CHAT),
    )
    private val roles = PhoneRoles(self = BELAY, dialers = setOf(DIALER), home = setOf(LAUNCHER), pauseExempt = setOf(CLOCK))

    /** BLOCKS on the screen from 15:00 for [minutes]. */
    private fun usage(asOf: Long, minutes: Long): UsageLog {
        val span = Span(t("15:00"), t("15:00") + minutes * MIN)
        return UsageLog(from = t("00:00"), asOf = asOf, apps = mapOf(BLOCKS to listOf(span)), screen = listOf(span))
    }

    private fun update(asOf: Long, minutes: Long) =
        UsageUpdate(ScreenTime.start(t("00:00")), usage(asOf, minutes), emptyList(), measured = true, clockShift = 0)

    private fun phase2(policy: WirePolicy, now: Long, applied: Applied = Applied()) =
        Enforcement.plan(Enforcement.Input(policy, inventory, roles, applied, debugBuild = false, sdkFull = Enforcement.sdkFull(37), now = now))

    /** Phase 2's plan and screen time's decision for [policy] at [now], merged, as the agent's step does it. */
    private fun merged(policy: WirePolicy, now: Long, minutes: Long, takes: List<SelfServeTake> = emptyList()): Pair<EnforcementPlanAndDecision, Rules.Input> {
        val plan = phase2(policy, now)
        val input = ScreenTimeEnforcement.input(policy.screenTime!!, now, NY, update(now, minutes), inventory, roles, Applied(), plan, takes)
        val decision = Rules.evaluate(input)
        return EnforcementPlanAndDecision(ScreenTimeEnforcement.merge(plan, decision), decision) to input
    }

    private data class EnforcementPlanAndDecision(val plan: family.brooker.belay.core.EnforcementPlan, val decision: Decision)

    private val allowed = listOf(BLOCKS, RACER, VIDEO).map { WireAppDecision(it, WireAppState.ALLOWED) }

    // Screen time on top of Phase 2.

    @Test
    fun `screen time's suspensions join Phase 2's plan, each with its reasons`() {
        val policy = WirePolicy(version = 5, apps = WireAppPolicy(WireNewApps.ASK, allowed), screenTime = screenTime)
        val (both, _) = merged(policy, t("16:00"), minutes = 60)
        assertEquals(setOf(CHAT, BLOCKS, RACER), both.plan.suspend)
        assertEquals(
            mapOf(BLOCKS to listOf("category_limit"), CHAT to listOf(HoldReason.WAITING), RACER to listOf("category_limit")),
            both.plan.reasons,
        )
        assertEquals(both.decision.nextAt, both.plan.nextChangeAt, "the alarm is for screen time's next boundary")
        assertEquals(both.decision.status(), both.plan.screenTime)
        assertEquals(WireLimitState.USED_UP, both.plan.screenTime?.limits?.single()?.state)
    }

    @Test
    fun `the rules' input comes from Phase 2's roles and apps`() {
        val policy = WirePolicy(version = 5, pause = WirePause(until = t("18:00")), screenTime = screenTime)
        val (_, input) = merged(policy, t("16:00"), minutes = 10)
        assertFalse("com.example.service" in input.apps, "only launchable apps")
        assertTrue(listOf(BELAY, DIALER, LAUNCHER).all { it in input.neverBlocked })
        assertEquals(setOf(CLOCK), input.keepOpen)
        assertEquals(WirePause(until = t("18:00")), input.pause)
    }

    @Test
    fun `a pause is one reason, and the apps screen time exempts stay open`() {
        val policy = WirePolicy(version = 5, pause = WirePause(until = t("18:00")), screenTime = screenTime.copy(exempt = listOf(VIDEO)))
        val (both, _) = merged(policy, t("16:00"), minutes = 10)
        assertEquals(listOf(HoldReason.PAUSED), both.plan.reasons[CHAT])
        assertFalse(VIDEO in both.plan.suspend)
        assertFalse(CLOCK in both.plan.suspend)
        assertFalse(DIALER in both.plan.suspend)
        assertEquals(KidMessage.PAUSED_UNTIL, both.decision.suspend.getValue(CHAT).kidText.message)
    }

    @Test
    fun `Belay keeps the reasons for what it holds, the report carries screen time, and letting go forgets both`() {
        val policy = WirePolicy(version = 5, screenTime = screenTime)
        val (both, _) = merged(policy, t("16:00"), minutes = 60)
        val changes = Enforcement.changes(both.plan, Applied())
        val applied = Enforcement.after(Applied(), both.plan, changes, ApplyOutcome(), t("16:00"))
        assertEquals(mapOf(BLOCKS to listOf("category_limit"), RACER to listOf("category_limit")), applied.reasons)
        assertEquals(both.decision.status(), Enforcement.report(applied)?.screenTime)

        val off = phase2(policy.copy(version = 6, screenTime = null), t("16:05"), applied)
        val after = Enforcement.after(applied, off, Enforcement.changes(off, applied), ApplyOutcome(), t("16:05"))
        assertEquals(emptySet(), after.suspended)
        assertEquals(emptyMap(), after.reasons)
        assertNull(Enforcement.report(after)?.screenTime)
    }

    @Test
    fun `an app still held because letting it go failed keeps its reasons`() {
        val policy = WirePolicy(version = 5, screenTime = screenTime)
        val (both, _) = merged(policy, t("16:00"), minutes = 60)
        val held = Enforcement.after(Applied(), both.plan, Enforcement.changes(both.plan, Applied()), ApplyOutcome(), t("16:00"))
        val off = phase2(policy.copy(version = 6, screenTime = null), t("16:05"), held)
        val changes = Enforcement.changes(off, held)
        val after = Enforcement.after(held, off, changes, ApplyOutcome(failedUnsuspend = setOf(BLOCKS)), t("16:05"))
        assertEquals(mapOf(BLOCKS to listOf("category_limit")), after.reasons)
    }

    // The report's bounds.

    @Test
    fun `the report never says more than 1500 minutes, and keeps the newest 20 takes`() {
        val whole = WireScreenTime(
            measure = true,
            limits = listOf(WireLimit("l-all", "Phone", listOf(WireLimit.EVERY_APP), 1440)),
            extra = listOf(WireExtra("x-1", "l-all", 600, "2026-11-17")),
            selfServe = WireSelfServe(5, 30),
        )
        val takes = (1..25).map { SelfServeTake("take-$it", "l-all", null, 5, "2026-11-17", t("10:00") + it * MIN) }
        val decision = Rules.evaluate(
            Rules.Input(whole, t("10:30"), NY, UsageLog(t("00:00"), t("10:30")), measured = true, apps = setOf(BLOCKS), neverBlocked = emptySet(), selfServe = takes),
        )
        val status = decision.status()
        assertEquals(1500, status.limits.single().left)
        assertEquals(20, status.selfServe.size)
        assertEquals(t("10:00") + 25 * MIN, status.selfServe.last().at, "the newest are kept")
    }

    // The ledger, locks and takes.

    @Test
    fun `a new ledger counts from the start of today, as the policy counts days`() {
        val early = screenTime.copy(dayStarts = "04:00")
        assertEquals(t("2026-11-16T04:00"), Upkeep.newLedger(early, t("02:00"), NY).cursor)
        assertEquals(t("04:00"), Upkeep.newLedger(early, t("05:00"), NY).cursor)
    }

    @Test
    fun `the ledger keeps yesterday and today`() {
        assertEquals(t("2026-11-16T00:00"), Upkeep.keepFrom(DayClock(NY), t("15:00")))
    }

    @Test
    fun `a schedule that locks the screen locks it once each time it starts`() {
        val policy = screenTime.copy(schedules = listOf(bedtime))
        val decision = Rules.evaluate(Rules.Input(policy, t("21:00"), NY, null, measured = true, apps = setOf(BLOCKS), neverBlocked = emptySet()))
        val (due, state) = Upkeep.locks(decision, ScreenTimeState(), t("21:00"))
        assertEquals(listOf("s-bed"), due.map { it.scheduleId })
        val later = Rules.evaluate(Rules.Input(policy, t("22:00"), NY, null, measured = true, apps = setOf(BLOCKS), neverBlocked = emptySet()))
        assertEquals(emptyList(), Upkeep.locks(later, state, t("22:00")).first)
    }

    @Test
    fun `self-serve minutes are taken once per tap, count at once, and stop at the rule's times`() {
        val policy = screenTime.copy(selfServe = WireSelfServe(15, 2))
        val (take, state) = Upkeep.take(policy, ScreenTimeState(), t("16:00"), NY, "take-1", "l-games", BLOCKS)!!
        assertEquals(SelfServeTake("take-1", "l-games", BLOCKS, 15, "2026-11-17", t("16:00")), take)
        assertEquals(1, Upkeep.take(policy, state, t("16:00"), NY, "take-1", "l-games", BLOCKS)!!.second.takes.size, "a double tap takes once")

        val decision = Rules.evaluate(
            Rules.Input(policy, t("16:01"), NY, usage(t("16:01"), 60), measured = true, apps = setOf(BLOCKS, RACER), neverBlocked = emptySet(), selfServe = state.takes),
        )
        assertFalse(BLOCKS in decision.suspend, "15 more minutes for the game")
        assertTrue(RACER in decision.suspend, "only for the app it was taken for")

        val (_, twice) = Upkeep.take(policy, state, t("16:20"), NY, "take-2", "l-games", null)!!
        assertNull(Upkeep.take(policy, twice, t("16:40"), NY, "take-3", "l-games", null), "two times a day")
    }

    @Test
    fun `old takes, notices and locks are forgotten`() {
        val old = t("10:00") - 4 * 24 * HOUR
        val state = ScreenTimeState(
            takes = listOf(SelfServeTake("old", minutes = 5, day = "2026-11-13", at = old), SelfServeTake("new", minutes = 5, day = "2026-11-17", at = t("09:00"))),
            shown = mapOf("old" to old, "new" to t("09:00")),
            locked = mapOf("old" to old),
        )
        val pruned = Upkeep.pruned(state, t("10:00"))
        assertEquals(listOf("new"), pruned.takes.map { it.id })
        assertEquals(setOf("new"), pruned.shown.keys)
        assertEquals(emptyMap(), pruned.locked)
    }

    // Reports.

    @Test
    fun `a day keeps its 200 longest gaps, in time order`() {
        val start = t("00:00")
        val gaps = (0 until 250).map { i -> Gap(start + i * 5 * MIN, start + i * 5 * MIN + (i + 1) * SEC, WireGapReason.NO_USAGE_ACCESS) }
        val log = UsageLog(from = start, asOf = t("23:00"), gaps = gaps)
        val wire = UsageReport.wire(UsageReport.day(log, DayClock(NY), LocalDate.of(2026, 11, 17)))
        assertEquals(200, wire.gaps.size)
        assertEquals(start + 50 * 5 * MIN, wire.gaps.first().from, "the 50 shortest are left out")
        assertEquals(wire.gaps.sortedBy { it.from }, wire.gaps)
    }

    @Test
    fun `usage since a moment leaves out what came before, and cuts what runs across it`() {
        val log = UsageLog(
            from = t("00:00"),
            asOf = t("12:00"),
            apps = mapOf(BLOCKS to listOf(Span(t("08:00"), t("09:00")), Span(t("09:30"), t("10:30")))),
            screen = listOf(Span(t("08:00"), t("09:00")), Span(t("09:30"), t("10:30"))),
            gaps = listOf(Gap(t("07:00"), t("08:00"), WireGapReason.PHONE_OFF), Gap(t("09:50"), t("10:10"), WireGapReason.UNKNOWN)),
        )
        val since = log.since(t("10:00"))
        assertEquals(t("10:00"), since.from)
        assertEquals(listOf(Span(t("10:00"), t("10:30"))), since.apps.getValue(BLOCKS))
        assertEquals(listOf(Span(t("10:00"), t("10:30"))), since.screen)
        assertEquals(listOf(Gap(t("10:00"), t("10:10"), WireGapReason.UNKNOWN)), since.gaps)
        assertEquals(log, log.since(t("00:00")))
    }
}
