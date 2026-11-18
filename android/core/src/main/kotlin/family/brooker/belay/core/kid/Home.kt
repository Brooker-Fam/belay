package family.brooker.belay.core.kid

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

/** What Home's one line depends on, as the last step decided it. */
data class HomeInput(
    /** The pause in effect (the plan's): null while not paused. */
    val pause: WirePause?,
    /** Screen time's schedules on now. */
    val schedules: List<ScheduleStatus> = emptyList(),
    /** Screen time's limits today. */
    val limits: List<LimitStatus> = emptyList(),
    /** Belay can't count screen time (usage access is off). */
    val unmeasured: Boolean = false,
    /** ...and the family's rule pauses apps with a limit then. */
    val unmeasuredPauses: Boolean = false,
    /** Lost mode is on. */
    val lost: Boolean = false,
    /** Apps that wait for a parent, or a parent blocked. */
    val held: Int = 0,
    /** Apps the family never pauses (screen time's `exempt`). */
    val exempt: List<String> = emptyList(),
    val now: Long,
    val zone: ZoneId,
)

/** Home: the phone's state in one line, and what works right now (each line in the kid's words). */
data class HomeState(val line: KidText, val worksNow: List<KidText>) {
    /** Every other app is paused now (a pause, a schedule, or the day's screen time used up). */
    val allPaused: Boolean get() = worksNow.any { it.message == KidMessage.WORKS_CALLS_TEXTS }
}

/**
 * Phase 7: Home's one line ("Everything's normal", "Bedtime until 7:00 AM", "Paused by your parent
 * until 5:30 PM", or Phase 12's "Paused by Grandma until 5:30 PM") and what works now, for every combination of lost mode, a pause, schedules and
 * used-up limits. Lost mode comes first (the phone may be in someone else's hands), then a pause, a
 * schedule (the one that lasts longest), the day's screen time, single limits, and Belay not being
 * able to count. 911 and 988 always work, and the last line says so. Pure.
 */
object Home {
    fun of(input: HomeInput): HomeState {
        val schedule = input.schedules.maxByOrNull { it.until }
        val totalUp = input.limits.any { it.kind == LimitKind.TOTAL && it.state == WireLimitState.USED_UP }
        val up = input.limits.filter { it.state == WireLimitState.USED_UP && it.kind != LimitKind.TOTAL }
        val line = when {
            input.lost -> KidText(KidMessage.HOME_LOST)
            input.pause != null -> pauseLine(input.pause, input)
            schedule != null -> scheduleLine(schedule, input)
            totalUp -> KidText(KidMessage.HOME_TOTAL_UP)
            up.size == 1 -> KidText(KidMessage.HOME_LIMIT_UP, listOf(KidArg.Words(up.single().name)))
            up.size > 1 -> KidText(KidMessage.HOME_LIMITS_UP, listOf(KidArg.Count(up.size)))
            input.unmeasured -> KidText(KidMessage.HOME_UNMEASURED)
            else -> KidText(KidMessage.HOME_NORMAL)
        }

        val works = mutableListOf<KidText>()
        if (input.lost) works += KidText(KidMessage.WORKS_LOST_MESSAGE)
        val allPaused = input.pause != null || schedule != null || totalUp
        if (allPaused) {
            works += KidText(KidMessage.WORKS_CALLS_TEXTS)
            // A pause leaves only the exempt apps; a schedule its own allowed ones too.
            val also = (input.exempt + if (input.pause == null) schedule?.allow.orEmpty() else emptySet()).distinct().sorted()
            if (also.isNotEmpty()) works += KidText(KidMessage.WORKS_ALSO, listOf(KidArg.Apps(also)))
        } else if (up.isNotEmpty() || (input.unmeasured && input.unmeasuredPauses) || input.held > 0) {
            works += KidText(KidMessage.WORKS_OTHER_APPS)
        } else {
            works += KidText(KidMessage.WORKS_APPS)
        }
        works += KidText(KidMessage.WORKS_EMERGENCY)
        return HomeState(line, works)
    }

    /** "Paused by your parent until 5:30 PM", or (Phase 12) "Paused by Grandma until 5:30 PM" for a caregiver's pause. */
    private fun pauseLine(pause: WirePause, input: HomeInput): KidText {
        val until = pause.until?.let { moment(it, input) }
        val by = Caregivers.who(pause.caregiver)?.let { KidArg.Words(it) }
        return when {
            by != null && until != null -> KidText(KidMessage.HOME_PAUSED_BY_UNTIL, listOf(by, until))
            by != null -> KidText(KidMessage.HOME_PAUSED_BY, listOf(by))
            until != null -> KidText(KidMessage.HOME_PAUSED_UNTIL, listOf(until))
            else -> KidText(KidMessage.HOME_PAUSED)
        }
    }

    private fun scheduleLine(schedule: ScheduleStatus, input: HomeInput): KidText {
        val until = moment(schedule.until, input)
        val name = KidArg.Words(schedule.name)
        return when (schedule.kind) {
            WireScheduleKind.BEDTIME -> KidText(KidMessage.HOME_BEDTIME_UNTIL, listOf(until, name))
            WireScheduleKind.SCHOOL -> KidText(KidMessage.SCHOOL_UNTIL, listOf(until, name))
            WireScheduleKind.CUSTOM -> KidText(KidMessage.SCHEDULE_UNTIL, listOf(name, until))
        }
    }

    private fun moment(at: Long, input: HomeInput) = KidArg.Moment.of(at, input.now, input.zone)
}
