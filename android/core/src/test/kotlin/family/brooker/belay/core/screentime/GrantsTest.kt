package family.brooker.belay.core.screentime

import family.brooker.belay.core.WireRequestKind

import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.MIN
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.VIDEO
import family.brooker.belay.core.screentime.Fx.at
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GrantsTest {
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")

    private val video = WireLimit("l-video", "Video", listOf(VIDEO), 30)
    private val games = WireLimit("l-games", "Games", listOf(BLOCKS), 60)
    private val policy = WireScreenTime(zone = "America/New_York", limits = listOf(video, games), selfServe = WireSelfServe(10, 2))

    @Test
    fun `parents' extras and the kid's takes become grants for their day`() {
        val problems = mutableListOf<String>()
        val grants = Grants.of(
            policy.copy(
                extra = listOf(
                    WireExtra("x-1", "l-video", 15, "2026-11-17", packageName = VIDEO),
                    WireExtra("x-1", "l-video", 15, "2026-11-17"),
                    WireExtra("x-2", "l-video", 15, "next tuesday"),
                    WireExtra("x-3", "l-video", -5, "2026-11-17"),
                    WireExtra("x-4", "l-video", 0, "2026-11-17"),
                ),
            ),
            takes = listOf(
                SelfServeTake("t-1", "l-games", minutes = 10, day = "2026-11-17", at = t("15:00")),
                SelfServeTake("t-2", minutes = 10, day = "someday", at = t("15:00")),
            ),
            problems = problems,
        )
        assertEquals(
            listOf(
                Grant("x-1", "l-video", VIDEO, 15, LocalDate.parse("2026-11-17"), GrantSource.PARENT),
                Grant("t-1", "l-games", null, 10, LocalDate.parse("2026-11-17"), GrantSource.SELF_SERVE),
            ),
            grants,
        )
        assertEquals(2, problems.size, "x-2 and x-3; a repeat and 0 minutes are quietly skipped")
    }

    @Test
    fun `a grant for every limit applies to each one`() {
        val everywhere = Grant("x", WireExtra.EVERY_LIMIT, null, 10, LocalDate.parse("2026-11-17"), GrantSource.PARENT)
        assertTrue(everywhere.appliesTo("l-video") && everywhere.appliesTo("l-games"))
        assertFalse(everywhere.copy(limitId = "l-video").appliesTo("l-games"))
    }

    @Test
    fun `the kid takes self-serve minutes up to the rule's times a day`() {
        val first = SelfServe.take(policy, emptyList(), t("15:00"), NY, "t-1", limitId = "l-video", packageName = VIDEO)
        assertEquals(SelfServeTake("t-1", "l-video", VIDEO, 10, "2026-11-17", t("15:00")), first)
        val second = SelfServe.take(policy, listOf(first!!), t("16:00"), NY, "t-2")
        assertEquals(WireExtra.EVERY_LIMIT, second?.limitId)
        assertNull(SelfServe.take(policy, listOf(first, second!!), t("17:00"), NY, "t-3"), "both times are used today")
        val status = SelfServe.status(policy, listOf(first, second), LocalDate.parse("2026-11-17"))
        assertEquals(0, status?.timesLeft)
        assertNull(status?.kidText)
        assertEquals(2, SelfServe.status(policy, listOf(first, second), LocalDate.parse("2026-11-18"))?.timesLeft, "a new day")
    }

    @Test
    fun `taking again with the same id takes once`() {
        val first = SelfServe.take(policy, emptyList(), t("15:00"), NY, "t-1")!!
        assertEquals(first, SelfServe.take(policy, listOf(first), t("15:01"), NY, "t-1"))
        assertEquals(1, SelfServe.status(policy, listOf(first, first), LocalDate.parse("2026-11-17"))?.taken)
    }

    @Test
    fun `self-serve counts days as day_starts cuts them`() {
        val four = policy.copy(dayStarts = "04:00")
        val tuesdayNight = SelfServe.take(four, emptyList(), t("2026-11-18T02:00"), NY, "t-1")
        assertEquals("2026-11-17", tuesdayNight?.day)
        val again = SelfServe.take(four, listOf(tuesdayNight!!), t("2026-11-18T03:00"), NY, "t-2")!!
        assertNull(SelfServe.take(four, listOf(tuesdayNight, again), t("2026-11-18T03:30"), NY, "t-3"))
        assertEquals("2026-11-18", SelfServe.take(four, listOf(tuesdayNight, again), t("2026-11-18T04:00"), NY, "t-4")?.day)
    }

    @Test
    fun `no self-serve without the rule, a limit for it, or a limit that exists`() {
        assertNull(SelfServe.take(policy.copy(selfServe = null), emptyList(), t("15:00"), NY, "t-1"))
        assertNull(SelfServe.take(policy.copy(limits = emptyList()), emptyList(), t("15:00"), NY, "t-1"))
        assertNull(SelfServe.take(policy.copy(selfServe = WireSelfServe(0, 2)), emptyList(), t("15:00"), NY, "t-1"))
        assertNull(SelfServe.take(policy, emptyList(), t("15:00"), NY, "t-1", limitId = "l-gone"))
    }

    @Test
    fun `minutes taken last the day, even if the rule is removed later that day`() {
        val take = SelfServeTake("t-1", "l-video", minutes = 10, day = "2026-11-17", at = t("15:00"))
        val usage = UsageLog(t("00:00"), t("16:00"), mapOf(VIDEO to listOf(Span(t("10:00"), t("10:30")))))
        val decision = Rules.evaluate(
            Rules.Input(
                policy = policy.copy(selfServe = null), now = t("16:00"), phoneZone = NY, usage = usage, measured = true,
                apps = setOf(VIDEO, BLOCKS), neverBlocked = emptySet(), selfServe = listOf(take),
            ),
        )
        assertFalse(VIDEO in decision.suspend)
        assertEquals(10 * MIN, decision.left[VIDEO])
        assertNull(decision.selfServe, "no more to take")
    }

    @Test
    fun `a more-time request asks for 5 to 240 minutes, with the kid's words cut to 500 characters`() {
        assertEquals(5, MoreTime.request("r-1", "l-video", 2, t("15:00")).minutes)
        assertEquals(240, MoreTime.request("r-1", "l-video", 1000, t("15:00")).minutes)
        val request = MoreTime.request("r-1", "l-video", 15, t("15:00"), packageName = VIDEO, reason = "  ${"x".repeat(600)}  ")
        assertEquals(500, request.reason?.length)
        assertEquals(WireRequestKind.MORE_TIME, request.kind)
        assertEquals(VIDEO, request.packageName)
        assertNull(MoreTime.request("r-2", "l-video", 15, t("15:00"), reason = "   ").reason)
    }
}
