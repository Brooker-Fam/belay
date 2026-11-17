package family.brooker.belay.ui

import android.content.Context
import android.text.format.DateFormat
import family.brooker.belay.R
import family.brooker.belay.core.screentime.KidArg
import family.brooker.belay.core.screentime.KidMessage
import family.brooker.belay.core.screentime.KidText
import family.brooker.belay.core.screentime.RelativeDay
import java.time.DayOfWeek
import java.time.LocalTime
import java.time.format.TextStyle
import java.util.Date
import java.util.Locale

/**
 * Phase 3: core's KidText in the kid's own words, from strings.xml (each KidMessage's English
 * draft is in core's KDoc). Durations use plurals ("1 hour 30 minutes"), times follow the
 * phone's 12- or 24-hour setting, and days read "Monday to Friday". [label] names an app by its
 * package (the inventory's label, from its developer, shown as text). The family's own words, a
 * limit's or a schedule's name, are shown as they are. Used by the screens and the notifications.
 */
class KidWords(private val context: Context, private val label: (String) -> String) {
    private val res = context.resources
    private val locale: Locale get() = res.configuration.locales[0]

    fun text(kid: KidText): String {
        val a = Args(kid.args)
        return when (kid.message) {
            KidMessage.LIMIT_LEFT -> res.getString(R.string.kid_limit_left, a.minutes(0), a.words(0))
            KidMessage.LIMIT_UP -> res.getString(R.string.kid_limit_up, a.words(0), a.back(0))
            KidMessage.LIMIT_UP_FOR_NOW -> res.getString(R.string.kid_limit_up_for_now, a.words(0))
            KidMessage.TOTAL_LEFT -> res.getString(R.string.kid_total_left, a.minutes(0))
            KidMessage.TOTAL_UP -> res.getString(R.string.kid_total_up, a.back(0))
            KidMessage.TOTAL_UP_FOR_NOW -> res.getString(R.string.kid_total_up_for_now)
            KidMessage.LIMIT_NOT_COUNTED -> res.getString(R.string.kid_limit_not_counted, a.words(0))
            KidMessage.SCHOOL_UNTIL -> res.getString(R.string.kid_school_until, a.until(0))
            KidMessage.BEDTIME_UNTIL -> res.getString(R.string.kid_bedtime_until, a.until(0))
            KidMessage.SCHEDULE_UNTIL -> res.getString(R.string.kid_schedule_until, a.words(0), a.until(0))
            KidMessage.SCHOOL_SOON -> res.getString(R.string.kid_school_soon, a.minutes(0))
            KidMessage.BEDTIME_SOON -> res.getString(R.string.kid_bedtime_soon, a.minutes(0))
            KidMessage.SCHEDULE_SOON -> res.getString(R.string.kid_schedule_soon, a.words(0), a.minutes(0))
            KidMessage.PAUSED_UNTIL -> res.getString(R.string.kid_paused_until, a.until(0))
            KidMessage.PAUSED -> res.getString(R.string.kid_paused)
            KidMessage.UNMEASURED_PAUSED -> res.getString(R.string.kid_unmeasured_paused)
            KidMessage.UNMEASURED -> res.getString(R.string.kid_unmeasured)
            KidMessage.SELF_SERVE -> selfServeOffer(a.count(0), a.count(1))
            // What the next stage changes.
            KidMessage.LIMIT_CHANGES -> res.getString(R.string.kid_limit_changes, a.words(0), a.minutes(0), a.minutes(1), a.days(0))
            KidMessage.TOTAL_CHANGES -> res.getString(R.string.kid_total_changes, a.minutes(0), a.minutes(1), a.days(0))
            KidMessage.LIMIT_ADDED -> res.getString(R.string.kid_limit_added, a.words(0), a.minutes(0), a.days(0))
            KidMessage.TOTAL_ADDED -> res.getString(R.string.kid_total_added, a.minutes(0), a.days(0))
            KidMessage.LIMIT_REMOVED -> res.getString(R.string.kid_limit_removed, a.words(0))
            KidMessage.TOTAL_REMOVED -> res.getString(R.string.kid_total_removed)
            KidMessage.LIMIT_APPS_ADDED -> a.withApps(R.plurals.kid_limit_apps_added)
            KidMessage.LIMIT_APPS_REMOVED -> a.withApps(R.plurals.kid_limit_apps_removed)
            KidMessage.SCHEDULE_ADDED -> res.getString(R.string.kid_schedule_added, a.words(0), a.clock(0), a.clock(1), a.days(0))
            KidMessage.SCHEDULE_REMOVED -> res.getString(R.string.kid_schedule_removed, a.words(0))
            KidMessage.SCHEDULE_TIMES ->
                res.getString(R.string.kid_schedule_times, a.words(0), a.clock(0), a.clock(1), a.clock(2), a.clock(3))
            KidMessage.SCHEDULE_DAYS_ADDED -> res.getString(R.string.kid_schedule_days_added, a.words(0), a.days(0))
            KidMessage.SCHEDULE_DAYS_REMOVED -> res.getString(R.string.kid_schedule_days_removed, a.words(0), a.days(0))
            KidMessage.SCHEDULE_ALLOWS -> a.withApps(R.plurals.kid_schedule_allows)
            KidMessage.SCHEDULE_NO_LONGER_ALLOWS -> a.withApps(R.plurals.kid_schedule_no_longer_allows)
            KidMessage.SCHEDULE_LOCKS -> res.getString(R.string.kid_schedule_locks, a.words(0))
            KidMessage.SCHEDULE_NO_LONGER_LOCKS -> res.getString(R.string.kid_schedule_no_longer_locks, a.words(0))
            KidMessage.EXEMPT_ADDED -> a.appsOnly(R.plurals.kid_exempt_added)
            KidMessage.EXEMPT_REMOVED -> a.appsOnly(R.plurals.kid_exempt_removed)
            KidMessage.SELF_SERVE_ALLOWED -> res.getString(
                R.string.kid_self_serve_allowed,
                duration(a.count(0)),
                res.getQuantityString(R.plurals.times, a.count(1), a.count(1)),
            )
            KidMessage.SELF_SERVE_REMOVED -> res.getString(R.string.kid_self_serve_removed)
            KidMessage.UNMEASURED_KEEPS_OPEN -> res.getString(R.string.kid_unmeasured_keeps_open)
            KidMessage.UNMEASURED_PAUSES -> res.getString(R.string.kid_unmeasured_pauses)
            KidMessage.WARNING_CHANGES -> {
                val minutes = a.rawMinutes(0)
                if (minutes <= 0) res.getString(R.string.kid_warning_none) else res.getString(R.string.kid_warning_changes, duration(minutes))
            }
        }
    }

    /** "20 minutes", "1 hour", "1 hour 30 minutes". */
    fun duration(minutes: Int): String {
        val m = minutes.coerceAtLeast(0)
        val hours = m / 60
        val rest = m % 60
        return when {
            hours == 0 -> res.getQuantityString(R.plurals.minutes, rest, rest)
            rest == 0 -> res.getQuantityString(R.plurals.hours, hours, hours)
            else -> res.getString(
                R.string.duration_hours_minutes,
                res.getQuantityString(R.plurals.hours, hours, hours),
                res.getQuantityString(R.plurals.minutes, rest, rest),
            )
        }
    }

    /**
     * A time of day in the phone's 12- or 24-hour format and its language: "9:00 PM", "21:00".
     * ICU's own formatter, from a skeleton: a localized pattern can hold symbols java.time on
     * older Androids doesn't read. The time is a wall time, so it's formatted in UTC.
     */
    fun time(time: LocalTime): String {
        val format = android.icu.text.DateFormat.getInstanceForSkeleton(if (DateFormat.is24HourFormat(context)) "Hm" else "hm", locale)
        format.timeZone = android.icu.util.TimeZone.GMT_ZONE
        return format.format(Date(time.toSecondOfDay() * 1000L))
    }

    /** "every day", "Monday to Friday", "Saturday and Sunday", "Monday, Wednesday and Friday". */
    fun days(days: Set<DayOfWeek>): String {
        if (days.size == 7) return res.getString(R.string.days_every_day)
        if (days.isEmpty()) return res.getString(R.string.days_none)
        // Start at a day whose day before isn't in the set, so "Sunday to Thursday" stays whole.
        val start = DayOfWeek.entries.first { it in days && it.minus(1) !in days }
        val runs = mutableListOf<MutableList<DayOfWeek>>()
        for (day in (0L until 7L).map { start.plus(it) }.filter { it in days }) {
            val run = runs.lastOrNull()
            if (run != null && run.last().plus(1) == day) run += day else runs += mutableListOf(day)
        }
        return list(
            runs.flatMap { run ->
                if (run.size >= 3) listOf(res.getString(R.string.days_range, dayName(run.first()), dayName(run.last()))) else run.map(::dayName)
            },
        )
    }

    /** Apps by name: "Racer", "Racer and Blocks", "Racer, Blocks, Chat and 2 more apps". */
    fun apps(packages: List<String>): String {
        val names = packages.map(label)
        if (names.size <= MAX_APPS) return list(names)
        val more = names.size - (MAX_APPS - 1)
        return list(names.take(MAX_APPS - 1) + res.getQuantityString(R.plurals.apps_more, more, more))
    }

    /** "a, b and c". */
    fun list(parts: List<String>): String = when (parts.size) {
        0 -> ""
        1 -> parts.single()
        else -> res.getString(R.string.list_two, parts.dropLast(1).joinToString(res.getString(R.string.list_separator)), parts.last())
    }

    private fun dayName(day: DayOfWeek): String = day.getDisplayName(TextStyle.FULL, locale)

    private fun selfServeOffer(minutes: Int, times: Int): String =
        res.getQuantityString(R.plurals.kid_self_serve_take, minutes, minutes) + " " +
            res.getQuantityString(R.plurals.kid_self_serve_times, times, times)

    /**
     * A moment as the message needs it: "until" reads "9:00 PM", "tomorrow at 7:00 AM" or
     * "Monday at 7:00 AM"; "comes back" reads "at 4:00 AM", "tomorrow at 12:00 AM" or
     * "on Monday at 12:00 AM". [KidArg.Moment.local] is already on the family's clock.
     */
    private fun moment(moment: KidArg.Moment, comesBack: Boolean): String {
        val time = time(moment.local.toLocalTime())
        return when (moment.day) {
            RelativeDay.TODAY -> if (comesBack) res.getString(R.string.moment_back_today, time) else time
            RelativeDay.TOMORROW -> res.getString(R.string.moment_tomorrow, time)
            RelativeDay.LATER -> res.getString(
                if (comesBack) R.string.moment_back_later else R.string.moment_until_later,
                dayName(moment.local.dayOfWeek),
                time,
            )
        }
    }

    /** The arguments of one message, by kind and position among their kind. */
    private inner class Args(private val args: List<KidArg>) {
        fun words(n: Int): String = args.filterIsInstance<KidArg.Words>()[n].text
        fun rawMinutes(n: Int): Int = args.filterIsInstance<KidArg.Minutes>()[n].minutes
        fun minutes(n: Int): String = duration(rawMinutes(n))
        fun count(n: Int): Int = args.filterIsInstance<KidArg.Count>()[n].count
        fun until(n: Int): String = moment(args.filterIsInstance<KidArg.Moment>()[n], comesBack = false)
        fun back(n: Int): String = moment(args.filterIsInstance<KidArg.Moment>()[n], comesBack = true)
        fun clock(n: Int): String = time(args.filterIsInstance<KidArg.Clock>()[n].time)
        fun days(n: Int): String = days(args.filterIsInstance<KidArg.Days>()[n].days)
        private fun appList(): List<String> = args.filterIsInstance<KidArg.Apps>().first().packages

        /** "%2$s now count toward %1$s": the family's words, then the apps, by how many. */
        fun withApps(plurals: Int): String {
            val packages = appList()
            return res.getQuantityString(plurals, packages.size, words(0), apps(packages))
        }

        fun appsOnly(plurals: Int): String {
            val packages = appList()
            return res.getQuantityString(plurals, packages.size, apps(packages))
        }
    }

    private companion object {
        /** Apps named before "and N more apps". */
        const val MAX_APPS = 5
    }
}
