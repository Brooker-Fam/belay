package family.brooker.belay.core.screentime

import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.DIALER
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.at
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** What the agent does at each step: read the events, count, decide, set an alarm for the next boundary. */
class ScreenTimeFlowTest {
    private fun t(time: String): Long = at("2026-11-17T$time")
    private val booted = at("2026-11-17T06:00")
    private fun reading(time: String) = UsageReading(t(time), t(time) - booted, bootCount = 4, usageAccess = true)
    private fun event(time: String, type: UsageEventType, pkg: String = BLOCKS) = UsageEvent(t(time), type, pkg, "$pkg.Main")

    private val policy = WireScreenTime(
        measure = true,
        zone = "America/New_York",
        limits = listOf(WireLimit("l-games", "Games", listOf(BLOCKS), 60)),
    )

    private fun decide(update: UsageUpdate, now: Long, policy: WireScreenTime = this.policy) = Rules.evaluate(
        Rules.Input(
            policy = policy, now = now, phoneZone = NY, usage = update.usage, foreground = update.foreground,
            measured = update.measured, apps = setOf(BLOCKS, DIALER), neverBlocked = setOf(DIALER),
        ),
    )

    @Test
    fun `a game runs out of time while the kid plays, and more time from a parent opens it again`() {
        var ledger = ScreenTime.start(t("10:00"), screenOn = true, keyguardShown = false)

        // 10:50: ten minutes left. The next alarm is the 5-minute warning.
        var update = ScreenTime.advance(ledger, listOf(event("10:00", UsageEventType.ACTIVITY_RESUMED)), reading("10:50"))
        ledger = update.ledger
        var decision = decide(update, t("10:50"))
        assertEquals(10 * MIN, decision.left[BLOCKS])
        assertEquals(t("10:55"), decision.nextAt)

        // The alarm at 10:55: the warning is due, and the next alarm is the minute it runs out.
        update = ScreenTime.advance(ledger, emptyList(), reading("10:55"))
        ledger = update.ledger
        decision = decide(update, t("10:55"))
        assertEquals(KidMessage.LIMIT_LEFT, decision.warnings.single().kidText.message)
        assertEquals(t("10:59"), decision.nextAt)

        // 11:00: used up. Belay suspends the game, and its notification says when it comes back.
        update = ScreenTime.advance(ledger, emptyList(), reading("11:00"))
        ledger = update.ledger
        decision = decide(update, t("11:00"))
        assertEquals(setOf(BLOCKS), decision.suspend.keys)
        assertEquals("l-games", MoreTime.limitFor(decision, BLOCKS))
        assertEquals(WireLimitState.USED_UP, decision.status().limits.single().state)

        // Suspension closes the game: Android reports it stopped.
        update = ScreenTime.advance(ledger, listOf(event("11:00", UsageEventType.ACTIVITY_STOPPED)), reading("11:20"))
        ledger = update.ledger
        assertEquals(60 * MIN, update.usage.millis(BLOCKS, t("00:00"), t("23:59")))

        // A parent approves 15 more minutes: the policy now carries the extra, and the game opens.
        val approved = policy.copy(extra = listOf(WireExtra("x-1", "l-games", 15, "2026-11-17", requestId = "r-1")))
        decision = decide(update, t("11:20"), approved)
        assertFalse(BLOCKS in decision.suspend)
        assertEquals(WireLimitState.EXTRA, decision.status().limits.single().state)
        assertEquals(15, decision.leftMinutes(BLOCKS))

        // The kid plays again; the extra runs out 15 minutes later.
        update = ScreenTime.advance(ledger, listOf(event("11:21", UsageEventType.ACTIVITY_RESUMED)), reading("11:22"))
        decision = decide(update, t("11:22"), approved)
        assertEquals(t("11:36"), decision.boundaries.single { it.kind == BoundaryKind.LIMIT_RUNS_OUT }.at)
        assertTrue(decision.warnings.isEmpty())
    }
}
