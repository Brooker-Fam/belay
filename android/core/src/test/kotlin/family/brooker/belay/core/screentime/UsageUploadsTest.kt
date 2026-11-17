package family.brooker.belay.core.screentime

import family.brooker.belay.core.screentime.Fx.BLOCKS
import family.brooker.belay.core.screentime.Fx.DIALER
import family.brooker.belay.core.screentime.Fx.HOUR
import family.brooker.belay.core.screentime.Fx.NY
import family.brooker.belay.core.screentime.Fx.at
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Made-up apps; a family in New York, measuring from 10:00 on Tuesday. */
class UsageUploadsTest {
    private fun t(time: String): Long = at(if ('T' in time) time else "2026-11-17T$time")

    private val days = DayClock(NY)
    private val since = t("10:00")

    /** A record from Tuesday's start, with [spans] of [BLOCKS] (local times on Tuesday or full date-times). */
    private fun usage(asOf: Long, vararg spans: Pair<String, String>, name: String = BLOCKS): UsageLog {
        val list = spans.map { (from, to) -> Span(t(from), t(to)) }
        return UsageLog(from = t("00:00"), asOf = asOf, apps = mapOf(name to list), screen = list)
    }

    private fun plan(
        usage: UsageLog,
        now: Long = usage.asOf,
        state: UploadState = UploadState(since = since),
        measure: Boolean = true,
        clockShift: Long = 0,
        force: Boolean = false,
    ) = UsageUploads.plan(measure, usage, days, now, state, clockShift, unlisted = setOf(DIALER), force = force)

    @Test
    fun `nothing is sent while the policy doesn't measure, and when it started is forgotten`() {
        val plan = plan(usage(t("12:00"), "10:00" to "11:00"), measure = false, state = UploadState(since, t("11:00")))
        assertEquals(emptyList(), plan.days)
        assertEquals(UploadState(), plan.state)
    }

    @Test
    fun `measuring starts now, and the first report goes once the phone is used`() {
        val first = plan(usage(t("10:00"), "09:00" to "10:00"), state = UploadState())
        assertEquals(emptyList(), first.days, "nothing was used since measuring started")
        assertEquals(t("10:00"), first.state.since)

        val used = plan(usage(t("10:05"), "09:00" to "10:05"), state = first.state)
        assertEquals(listOf("2026-11-17"), used.days.map { it.day })
        assertEquals(t("10:05"), used.state.lastAt)
    }

    @Test
    fun `what came before measuring started isn't sent`() {
        val day = plan(usage(t("10:05"), "09:00" to "10:05")).days.single()
        assertEquals(5, day.apps.single().minutes, "the hour before 10:00 isn't in it")
        assertEquals(5, day.screenMinutes)
        assertEquals(WireUsageGap(t("00:00"), t("10:00"), WireGapReason.UNKNOWN), day.gaps.first())
        assertEquals(false, day.complete)
    }

    @Test
    fun `today goes every 15 minutes while the phone is used, and not while it isn't`() {
        val state = UploadState(since = since, lastAt = t("10:05"))
        assertEquals(emptyList(), plan(usage(t("10:10"), "10:00" to "10:10"), state = state).days, "too soon")
        val due = plan(usage(t("10:20"), "10:00" to "10:20"), state = state)
        assertEquals(1, due.days.size)
        assertEquals(t("10:20"), due.state.lastAt)
        assertEquals(emptyList(), plan(usage(t("10:40"), "10:00" to "10:20"), state = due.state).days, "not used since")
    }

    @Test
    fun `each day goes once more when it's complete`() {
        val state = UploadState(since = since, lastAt = t("23:50"))
        val log = usage(t("2026-11-18T00:10"), "10:00" to "12:00")
        val after = plan(log, state = state)
        val day = after.days.single()
        assertEquals("2026-11-17", day.day)
        assertTrue(day.complete)
        assertEquals(t("2026-11-18T00:00"), day.asOf)
        assertEquals(120, day.screenMinutes)
        assertEquals(listOf("2026-11-17 America/New_York"), after.state.complete)
        assertEquals(emptyList(), plan(log.copy(asOf = t("2026-11-18T00:20")), state = after.state).days, "only once")
    }

    @Test
    fun `after the clock moved, yesterday and today go again`() {
        val state = UploadState(since = since, lastAt = t("2026-11-18T09:55"), complete = listOf("2026-11-17 America/New_York"))
        val log = usage(t("2026-11-18T10:00"), "10:00" to "12:00", "2026-11-18T09:00" to "2026-11-18T09:30")
        assertEquals(emptyList(), plan(log, state = state).days)
        assertEquals(listOf("2026-11-17", "2026-11-18"), plan(log, state = state, clockShift = HOUR).days.map { it.day })
    }

    @Test
    fun `a debug build can send today at once`() {
        val state = UploadState(since = since, lastAt = t("10:05"))
        assertEquals(1, plan(usage(t("10:06"), "10:00" to "10:06"), state = state, force = true).days.size)
    }

    @Test
    fun `never-blocked apps are left out of the apps, though their time counts`() {
        val log = UsageLog(
            from = t("00:00"),
            asOf = t("11:00"),
            apps = mapOf(DIALER to listOf(Span(t("10:00"), t("10:30"))), BLOCKS to listOf(Span(t("10:30"), t("10:50")))),
            screen = listOf(Span(t("10:00"), t("10:50"))),
        )
        val day = plan(log).days.single()
        assertEquals(listOf(BLOCKS), day.apps.map { it.packageName })
        assertEquals(50, day.screenMinutes)
    }
}
