package family.brooker.belay.core.kid

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.screentime.KidArg
import family.brooker.belay.core.screentime.KidMessage
import family.brooker.belay.core.screentime.KidText
import family.brooker.belay.core.screentime.LimitKind
import family.brooker.belay.core.screentime.LimitStatus
import family.brooker.belay.core.screentime.ScheduleStatus
import family.brooker.belay.core.screentime.WireLimitState
import family.brooker.belay.core.screentime.WireScheduleKind
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Made-up limits, schedules and apps only. */
class HomeTest {
    private val zone: ZoneId = ZoneId.of("UTC")
    private val nothing = KidText(KidMessage.HOME_NORMAL)

    private fun limit(id: String, name: String, state: WireLimitState, kind: LimitKind = LimitKind.CATEGORY) =
        LimitStatus(id, name, kind, setOf("com.example.game"), 3_600_000, 0, 0, 0, state, T0 + 10 * HOUR, null, nothing)

    private fun schedule(kind: WireScheduleKind, until: Long, allow: Set<String> = emptySet()) =
        ScheduleStatus("s-${kind.name.lowercase()}", kind, "${kind.name.lowercase()} time", T0 - HOUR, until, allow, nothing)

    private val bedtime = schedule(WireScheduleKind.BEDTIME, T0 + 8 * HOUR, allow = setOf("com.example.music"))
    private val school = schedule(WireScheduleKind.SCHOOL, T0 + 2 * HOUR)
    private val games = limit("l-games", "Games", WireLimitState.USED_UP)
    private val video = limit("l-video", "Video", WireLimitState.USED_UP)
    private val total = limit("l-total", "Screen time", WireLimitState.USED_UP, LimitKind.TOTAL)
    private val open = limit("l-books", "Books", WireLimitState.OPEN)
    private val pause = WirePause(until = T0 + HOUR)

    private fun home(
        pause: WirePause? = null,
        schedules: List<ScheduleStatus> = emptyList(),
        limits: List<LimitStatus> = emptyList(),
        lost: Boolean = false,
        unmeasured: Boolean = false,
        held: Int = 0,
        exempt: List<String> = emptyList(),
    ) = Home.of(HomeInput(pause, schedules, limits, unmeasured, unmeasuredPauses = unmeasured, lost = lost, held = held, exempt = exempt, now = T0, zone = zone))

    @Test
    fun `nothing going on is everything's normal`() {
        val state = home(limits = listOf(open))
        assertEquals(KidMessage.HOME_NORMAL, state.line.message)
        assertEquals(listOf(KidMessage.WORKS_APPS, KidMessage.WORKS_EMERGENCY), state.worksNow.map { it.message })
        assertFalse(state.allPaused)
    }

    @Test
    fun `a pause says until when, and what still works`() {
        val state = home(pause = pause)
        assertEquals(KidMessage.HOME_PAUSED_UNTIL, state.line.message)
        assertEquals(T0 + HOUR, (state.line.args.single() as KidArg.Moment).at)
        assertEquals(listOf(KidMessage.WORKS_CALLS_TEXTS, KidMessage.WORKS_EMERGENCY), state.worksNow.map { it.message })
        assertTrue(state.allPaused)
        assertEquals(KidMessage.HOME_PAUSED, home(pause = WirePause(until = null)).line.message)
    }

    @Test
    fun `a schedule names itself and its end, and lists the apps it leaves open`() {
        val state = home(schedules = listOf(bedtime), exempt = listOf("com.example.books"))
        assertEquals(KidMessage.HOME_BEDTIME_UNTIL, state.line.message)
        assertEquals(T0 + 8 * HOUR, (state.line.args.first() as KidArg.Moment).at)
        val also = state.worksNow.single { it.message == KidMessage.WORKS_ALSO }
        assertEquals(listOf("com.example.books", "com.example.music"), (also.args.single() as KidArg.Apps).packages)
        assertEquals(KidMessage.SCHOOL_UNTIL, home(schedules = listOf(school)).line.message)
        assertEquals(KidMessage.SCHEDULE_UNTIL, home(schedules = listOf(schedule(WireScheduleKind.CUSTOM, T0 + HOUR))).line.message)
        // Two schedules at once: the one that lasts longest.
        assertEquals(KidMessage.HOME_BEDTIME_UNTIL, home(schedules = listOf(school, bedtime)).line.message)
    }

    @Test
    fun `time's up names the limit, or counts them`() {
        val one = home(limits = listOf(games, open))
        assertEquals(KidText(KidMessage.HOME_LIMIT_UP, listOf(KidArg.Words("Games"))), one.line)
        assertEquals(KidMessage.WORKS_OTHER_APPS, one.worksNow.first().message)
        assertEquals(KidText(KidMessage.HOME_LIMITS_UP, listOf(KidArg.Count(2))), home(limits = listOf(games, video)).line)
        val day = home(limits = listOf(games, total))
        assertEquals(KidMessage.HOME_TOTAL_UP, day.line.message)
        assertTrue(day.allPaused, "a used-up daily total pauses every app that isn't exempt")
    }

    @Test
    fun `every combination of lost mode, a pause, a schedule and time's up`() {
        val pauses = listOf(null, pause)
        val schedules = listOf(emptyList(), listOf(bedtime))
        val limits = listOf(emptyList(), listOf(games), listOf(total))
        for (lost in listOf(false, true)) for (p in pauses) for (s in schedules) for (l in limits) {
            val state = home(pause = p, schedules = s, limits = l, lost = lost)
            val expected = when {
                lost -> KidMessage.HOME_LOST
                p != null -> KidMessage.HOME_PAUSED_UNTIL
                s.isNotEmpty() -> KidMessage.HOME_BEDTIME_UNTIL
                l == listOf(total) -> KidMessage.HOME_TOTAL_UP
                l == listOf(games) -> KidMessage.HOME_LIMIT_UP
                else -> KidMessage.HOME_NORMAL
            }
            val case = "lost=$lost pause=${p != null} schedule=${s.isNotEmpty()} limits=${l.map { it.id }}"
            assertEquals(expected, state.line.message, case)
            assertEquals(KidMessage.WORKS_EMERGENCY, state.worksNow.last().message, "911 and 988 always work: $case")
            assertEquals(lost, state.worksNow.any { it.message == KidMessage.WORKS_LOST_MESSAGE }, case)
            assertEquals(p != null || s.isNotEmpty() || l == listOf(total), state.allPaused, case)
        }
    }

    @Test
    fun `can't count, and apps waiting, leave the other apps working`() {
        val state = home(unmeasured = true)
        assertEquals(KidMessage.HOME_UNMEASURED, state.line.message)
        assertEquals(KidMessage.WORKS_OTHER_APPS, state.worksNow.first().message)
        assertEquals(KidMessage.WORKS_OTHER_APPS, home(held = 2).worksNow.first().message)
        assertEquals(KidMessage.HOME_NORMAL, home(held = 2).line.message)
    }
}
