package family.brooker.belay.core.screentime

import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/**
 * Words for the kid, as a [message] and its [args]: the app maps each message to a strings.xml
 * resource and formats the arguments in the kid's language (durations with plurals, times in the
 * phone's 12- or 24-hour format, app labels from the inventory). :core never writes the sentence.
 * Each message's KDoc has the design's English draft and its arguments, in order; plain and
 * respectful, for a 12-year-old, and never more than the code does.
 */
data class KidText(val message: KidMessage, val args: List<KidArg> = emptyList())

internal fun kid(message: KidMessage, vararg args: KidArg) = KidText(message, args.toList())

sealed interface KidArg {
    /** The family's own words, shown as they are: a limit's or a schedule's name. */
    data class Words(val text: String) : KidArg

    /** A length of time: "20 minutes", "1 hour 30 minutes". */
    data class Minutes(val minutes: Int) : KidArg

    /** A plain number. */
    data class Count(val count: Int) : KidArg

    /** A moment: [local] is the time on the family's clock, and [day] whether it's today, tomorrow or later. */
    data class Moment(val at: Long, val local: LocalDateTime, val day: RelativeDay) : KidArg {
        companion object {
            fun of(at: Long, now: Long, zone: ZoneId): Moment {
                val local = LocalTimes.local(at, zone).toLocalDateTime()
                val today = LocalTimes.local(now, zone).toLocalDate()
                val day = when (local.toLocalDate()) {
                    today -> RelativeDay.TODAY
                    today.plusDays(1) -> RelativeDay.TOMORROW
                    else -> RelativeDay.LATER
                }
                return Moment(at, local, day)
            }
        }
    }

    /** A time of day, like a schedule's start: "9:00 pm". */
    data class Clock(val time: LocalTime) : KidArg

    /** Days of the week: "every day", "Monday to Friday", "Saturday and Sunday". */
    data class Days(val days: Set<DayOfWeek>) : KidArg

    /** Apps by package: the app shows their labels. */
    data class Apps(val packages: List<String>) : KidArg
}

/** "today at 3:00 pm", "tomorrow at 12:00 am", or a weekday for later. */
enum class RelativeDay { TODAY, TOMORROW, LATER }

enum class KidMessage {
    // ── Now: the Today screen, notifications and the time's-up screen ──

    /** "%1$s left today for %2$s": [KidArg.Minutes] left, [KidArg.Words] the limit. Also the warning before it runs out. */
    LIMIT_LEFT,

    /** "Time's up for %1$s today. It comes back %2$s.": [KidArg.Words], [KidArg.Moment] ("tomorrow at 12:00 am"). */
    LIMIT_UP,

    /** "Time's up for %1$s.": [KidArg.Words]. Nothing opens it again within a week (a limit of 0 minutes every day). */
    LIMIT_UP_FOR_NOW,

    /** "%1$s of screen time left today": [KidArg.Minutes]. A daily total. */
    TOTAL_LEFT,

    /** "Your screen time for today is used up. It comes back %1$s.": [KidArg.Moment]. */
    TOTAL_UP,

    /** "Your screen time is used up.": nothing opens it again within a week. */
    TOTAL_UP_FOR_NOW,

    /** "Belay can't count time for %1$s right now.": [KidArg.Words]. While usage access is off. */
    LIMIT_NOT_COUNTED,

    /** "School time until %1$s": [KidArg.Moment], then [KidArg.Words] the schedule's name. */
    SCHOOL_UNTIL,

    /**
     * "Bedtime until %1$s. Apps are paused. You can still call and text your parents, 911 and 988.":
     * [KidArg.Moment], then [KidArg.Words] the schedule's name.
     */
    BEDTIME_UNTIL,

    /** "%1$s until %2$s": [KidArg.Words] a custom schedule's name, [KidArg.Moment]. */
    SCHEDULE_UNTIL,

    /** "School time starts in %1$s": [KidArg.Minutes], then [KidArg.Words]. */
    SCHOOL_SOON,

    /** "Bedtime starts in %1$s": [KidArg.Minutes], then [KidArg.Words]. */
    BEDTIME_SOON,

    /** "%1$s starts in %2$s": [KidArg.Words], [KidArg.Minutes]. */
    SCHEDULE_SOON,

    /** "Your parent paused this phone until %1$s.": [KidArg.Moment]. */
    PAUSED_UNTIL,

    /** "Your parent paused this phone." */
    PAUSED,

    /**
     * "Belay can't count screen time right now, because usage access is turned off. Apps with a time
     * limit are paused until it's back on." With the button "Turn usage access back on".
     */
    UNMEASURED_PAUSED,

    /** "Belay can't count screen time right now, because usage access is turned off." (if_unmeasured: keep_open) */
    UNMEASURED,

    /** "Take %1$d more minutes. You can do this %2$d more times today.": [KidArg.Count] minutes, [KidArg.Count] times left. */
    SELF_SERVE,

    // ── What the next stage changes (Stages.changes) ──

    /** "%1$s: %2$s a day instead of %3$s, %4$s": [KidArg.Words] the limit, [KidArg.Minutes] new, [KidArg.Minutes] old, [KidArg.Days]. */
    LIMIT_CHANGES,

    /** "Daily screen time goes from %1$s to %2$s, %3$s": [KidArg.Minutes] old, [KidArg.Minutes] new, [KidArg.Days]. */
    TOTAL_CHANGES,

    /** "New limit: %1$s, %2$s a day, %3$s": [KidArg.Words], [KidArg.Minutes], [KidArg.Days]. */
    LIMIT_ADDED,

    /** "New daily screen time limit: %1$s, %2$s": [KidArg.Minutes], [KidArg.Days]. */
    TOTAL_ADDED,

    /** "No more time limit for %1$s": [KidArg.Words]. */
    LIMIT_REMOVED,

    /** "No more daily screen time limit" */
    TOTAL_REMOVED,

    /** "%2$s now count toward %1$s": [KidArg.Words] the limit, [KidArg.Apps]. */
    LIMIT_APPS_ADDED,

    /** "%2$s no longer count toward %1$s": [KidArg.Words] the limit, [KidArg.Apps]. */
    LIMIT_APPS_REMOVED,

    /** "New: %1$s from %2$s to %3$s, %4$s": [KidArg.Words] the schedule, [KidArg.Clock] start, [KidArg.Clock] end, [KidArg.Days]. */
    SCHEDULE_ADDED,

    /** "No more %1$s": [KidArg.Words]. */
    SCHEDULE_REMOVED,

    /**
     * "%1$s: %4$s to %5$s instead of %2$s to %3$s": [KidArg.Words], [KidArg.Clock] old start and end,
     * [KidArg.Clock] new start and end.
     */
    SCHEDULE_TIMES,

    /** "%1$s also on %2$s": [KidArg.Words], [KidArg.Days]. */
    SCHEDULE_DAYS_ADDED,

    /** "No %1$s on %2$s": [KidArg.Words], [KidArg.Days]. */
    SCHEDULE_DAYS_REMOVED,

    /** "During %1$s, %2$s stay open": [KidArg.Words], [KidArg.Apps]. */
    SCHEDULE_ALLOWS,

    /** "During %1$s, %2$s are paused too": [KidArg.Words], [KidArg.Apps]. */
    SCHEDULE_NO_LONGER_ALLOWS,

    /** "%1$s locks the screen when it starts": [KidArg.Words]. */
    SCHEDULE_LOCKS,

    /** "%1$s no longer locks the screen": [KidArg.Words]. */
    SCHEDULE_NO_LONGER_LOCKS,

    /** "%1$s never count toward a limit": [KidArg.Apps]. */
    EXEMPT_ADDED,

    /** "%1$s count toward limits again": [KidArg.Apps]. */
    EXEMPT_REMOVED,

    /** "You can take %1$d more minutes, %2$d times a day, without asking": [KidArg.Count], [KidArg.Count]. */
    SELF_SERVE_ALLOWED,

    /** "No more taking extra minutes without asking" */
    SELF_SERVE_REMOVED,

    /** "When Belay can't count, apps with a limit stay open" */
    UNMEASURED_KEEPS_OPEN,

    /** "When Belay can't count, apps with a limit are paused" */
    UNMEASURED_PAUSES,

    /** "A warning %1$s before time's up or a schedule starts": [KidArg.Minutes]; 0 means no warning. */
    WARNING_CHANGES,

    // ── Phase 7: Home's one line (core's kid.Home), and what works right now ──

    /** "Everything's normal" */
    HOME_NORMAL,

    /** "This phone is in lost mode" */
    HOME_LOST,

    /** "Paused by your parent until %1$s": [KidArg.Moment]. */
    HOME_PAUSED_UNTIL,

    /** "Paused by your parent" */
    HOME_PAUSED,

    /** "Bedtime until %1$s": [KidArg.Moment], then [KidArg.Words] the schedule's name. (School and custom schedules use SCHOOL_UNTIL and SCHEDULE_UNTIL.) */
    HOME_BEDTIME_UNTIL,

    /** "Your screen time for today is used up" */
    HOME_TOTAL_UP,

    /** "Time's up for %1$s today": [KidArg.Words] the limit. */
    HOME_LIMIT_UP,

    /** "Time's up for %1$d of your time limits today": [KidArg.Count]. */
    HOME_LIMITS_UP,

    /** "Belay can't count screen time right now" */
    HOME_UNMEASURED,

    /** "Calls and texts work, and so do Belay, Settings and the clock." While every other app is paused. */
    WORKS_CALLS_TEXTS,

    /** "These work too: %1$s": [KidArg.Apps] a schedule allows or the family never pauses. */
    WORKS_ALSO,

    /** "Your other apps work." Some apps are paused or waiting. */
    WORKS_OTHER_APPS,

    /** "Your apps work." */
    WORKS_APPS,

    /** "Your parent's message is on the lock screen." Lost mode. */
    WORKS_LOST_MESSAGE,

    /** "You can always call or text 911 and 988." */
    WORKS_EMERGENCY,

    // ── Phase 12: a caregiver's pause (core's kid.Caregivers), by the name a parent gave them ──

    /** "%1$s paused this phone until %2$s.": [KidArg.Words] the caregiver's name, then [KidArg.Moment]. */
    PAUSED_BY_UNTIL,

    /** "%1$s paused this phone.": [KidArg.Words] the caregiver's name. */
    PAUSED_BY,

    /** Home's line: "Paused by %1$s until %2$s": [KidArg.Words] the caregiver's name, then [KidArg.Moment]. */
    HOME_PAUSED_BY_UNTIL,

    /** Home's line: "Paused by %1$s": [KidArg.Words] the caregiver's name. */
    HOME_PAUSED_BY,
}
