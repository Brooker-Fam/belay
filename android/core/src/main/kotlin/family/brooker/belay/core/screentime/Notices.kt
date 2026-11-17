package family.brooker.belay.core.screentime

/**
 * Where one of Belay's screen-time notifications shows: [tag] is its Android notification tag,
 * and a newer notice in the same slot replaces the older one.
 */
sealed interface NoticeSlot {
    val tag: String

    /** "5 minutes left today for Games", "Bedtime starts in 5 minutes": the newest only. */
    data object Warning : NoticeSlot {
        override val tag: String get() = "warning"
    }

    /** A limit is used up: "Time's up for Games today…", with "Ask for more time". One per limit. */
    data class TimesUp(val limitId: String) : NoticeSlot {
        override val tag: String get() = "up:$limitId"
    }

    /** A schedule started: "Bedtime until 7:00 am. Apps are paused. You can still call…". One per schedule. */
    data class Schedule(val scheduleId: String) : NoticeSlot {
        override val tag: String get() = "schedule:$scheduleId"
    }

    /** Belay can't count, with "Turn usage access back on". */
    data object Unmeasured : NoticeSlot {
        override val tag: String get() = "unmeasured"
    }
}

/** A notification to show in [slot]. [until]: it stops being true then, so Android takes it away. */
data class Notice(val slot: NoticeSlot, val text: KidText, val until: Long?)

data class NoticePlan(
    val show: List<Notice>,
    /** The tags of notifications to take away. */
    val cancel: List<String>,
    val state: ScreenTimeState,
)

/**
 * Which screen-time notifications to show and take away at a step, from the decision and what
 * was shown before. Each shows once (by key), so steps can run as often as they like:
 * - a warning ahead of a limit running out or a schedule starting (Decision.warnings), the
 *   soonest one when several are due;
 * - time's up, once per limit and day (and again if extra time runs out too), only when the
 *   limit was used today: a limit of 0 minutes isn't news;
 * - a schedule starting, once each time it runs (bedtime says what still works);
 * - usage access off, once each time it goes off, with the family's "can't count" rule.
 * What no longer holds is taken away: time's up once the limit opens again, a schedule once it
 * ends, "can't count" once Belay counts again, a warning once something newer replaces it (or at
 * its own time, through [Notice.until]).
 */
object Notices {
    private const val MINUTE = 60_000L

    fun plan(decision: Decision, state: ScreenTimeState, now: Long): NoticePlan {
        val shown = state.shown.filterValues { Upkeep.recent(it, now) }.toMutableMap()
        val show = mutableListOf<Notice>()
        // Tags that still hold, so stay up if they are.
        val holding = mutableSetOf<String>()

        var unmeasuredSince = state.unmeasuredSince
        if (decision.measured) {
            unmeasuredSince = null
        } else {
            val since = unmeasuredSince ?: now
            unmeasuredSince = since
            holding += NoticeSlot.Unmeasured.tag
            val key = "unmeasured:$since"
            if (key !in shown) {
                show += Notice(NoticeSlot.Unmeasured, decision.unmeasured ?: kid(KidMessage.UNMEASURED), null)
                shown[key] = now
            }
        }

        for (schedule in decision.schedules) {
            val slot = NoticeSlot.Schedule(schedule.id)
            holding += slot.tag
            val key = "schedule:${schedule.id}:${schedule.from}"
            if (key !in shown) {
                show += Notice(slot, schedule.kidText, schedule.until)
                shown[key] = now
            }
        }

        for (limit in decision.limits) {
            if (limit.state != WireLimitState.USED_UP) continue
            val slot = NoticeSlot.TimesUp(limit.id)
            holding += slot.tag
            if (limit.usedMillis <= 0) continue
            val key = "up:${limit.id}:${decision.day}:${(limit.baseMillis + limit.extraMillis) / MINUTE}"
            if (key !in shown) {
                show += Notice(slot, limit.kidText, limit.opensAt)
                shown[key] = now
            }
        }

        val warnings = decision.warnings.filter { it.key !in shown }
        warnings.forEach { shown[it.key] = now }
        val warning = warnings.minByOrNull { it.at }?.let { Notice(NoticeSlot.Warning, it.kidText, it.at) }

        // Something newer than a warning (time's up, a schedule) makes it old news.
        val staleWarning = warning == null && show.any { it.slot is NoticeSlot.TimesUp || it.slot is NoticeSlot.Schedule }
        val cancel = state.showing.filter { it !in holding } + listOfNotNull(NoticeSlot.Warning.tag.takeIf { staleWarning })
        val showing = state.showing.filterTo(LinkedHashSet()) { it in holding } + show.map { it.slot.tag }
        return NoticePlan(
            show = show + listOfNotNull(warning),
            cancel = cancel.distinct(),
            state = state.copy(shown = shown, showing = showing, unmeasuredSince = unmeasuredSince),
        )
    }

    /** Screen time is gone from the policy: every notification it put up goes. */
    fun clear(state: ScreenTimeState): List<String> =
        (state.showing + NoticeSlot.Warning.tag + NoticeSlot.Unmeasured.tag).distinct()
}
