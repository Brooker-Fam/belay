package family.brooker.belay.core.screentime

import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WirePause
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** One app's limit, several apps' together (a category, like "Games"), or every app's (a daily total). */
enum class LimitKind { APP, CATEGORY, TOTAL }

/** Why an app is paused, as a short machine code; [kind] is the design's coarser one. */
enum class ReasonCode(val kind: String) {
    APP_LIMIT("limit"),
    CATEGORY_LIMIT("limit"),
    DAILY_TOTAL("limit"),
    SCHOOL("schedule"),
    BEDTIME("schedule"),
    SCHEDULE("schedule"),
    PAUSED("pause"),
    UNMEASURED("unmeasured"),
    ;

    /** "app_limit", "bedtime"...: for Belay's records. */
    val code: String get() = name.lowercase()
}

sealed interface Reason {
    val code: ReasonCode

    /** A daily limit is used up. */
    data class Limit(val limitId: String, val name: String, val kind: LimitKind) : Reason {
        override val code: ReasonCode
            get() = when (kind) {
                LimitKind.APP -> ReasonCode.APP_LIMIT
                LimitKind.CATEGORY -> ReasonCode.CATEGORY_LIMIT
                LimitKind.TOTAL -> ReasonCode.DAILY_TOTAL
            }
    }

    /** A schedule is on, until [until]. */
    data class Schedule(val scheduleId: String, val kind: WireScheduleKind, val name: String, val until: Long) : Reason {
        override val code: ReasonCode
            get() = when (kind) {
                WireScheduleKind.SCHOOL -> ReasonCode.SCHOOL
                WireScheduleKind.BEDTIME -> ReasonCode.BEDTIME
                WireScheduleKind.CUSTOM -> ReasonCode.SCHEDULE
            }
    }

    /** A parent paused the phone (Phase 2's pause; "lock now" too), until [until] or until resumed. */
    data class Paused(val until: Long?) : Reason {
        override val code: ReasonCode get() = ReasonCode.PAUSED
    }

    /** Belay can't count, because usage access is off, and the policy pauses apps with a limit then. */
    data object Unmeasured : Reason {
        override val code: ReasonCode get() = ReasonCode.UNMEASURED
    }
}

/** An app Belay pauses for screen time now. */
data class Suspension(
    val packageName: String,
    /** Every reason; the first is the one to tell the kid (a pause, then a schedule, a limit, "can't count"). */
    val reasons: List<Reason>,
    /**
     * When it opens again if nothing changes (no new rules, no extra time): null when nothing opens
     * it within a week, or only usage access coming back will.
     */
    val opensAt: Long?,
    val kidText: KidText,
) {
    val reason: Reason get() = reasons.first()
}

/** A limit today, for the kid's Today screen and the enforcement report. */
data class LimitStatus(
    val id: String,
    /** The family's words: untrusted for AI. */
    val name: String,
    val kind: LimitKind,
    /** The installed apps it can pause; for a daily total, every one that isn't exempt. */
    val packages: Set<String>,
    /** Today's own minutes (by_day or minutes). */
    val baseMillis: Long,
    /** Extra time any of its apps may use today (a parent's, or self-serve). */
    val extraMillis: Long,
    val usedMillis: Long,
    /** Before it pauses its apps; an app with extra time of its own may have more (Decision.left). */
    val leftMillis: Long,
    val state: WireLimitState,
    /** When the count starts again: the next day. */
    val resetsAt: Long,
    /** When used up: the first time one of its apps opens again, if nothing changes. */
    val opensAt: Long?,
    val kidText: KidText,
)

/** A schedule on now. */
data class ScheduleStatus(
    val id: String,
    val kind: WireScheduleKind,
    /** The family's words: untrusted for AI. */
    val name: String,
    val from: Long,
    val until: Long,
    /** Apps it leaves open, beyond never-blocked and exempt ones. */
    val allow: Set<String>,
    val kidText: KidText,
)

enum class WarningKind { LIMIT_ENDING, SCHEDULE_STARTING }

/**
 * Something to tell the kid ahead of time ("5 minutes left for Games"): show each [key] once.
 * [at] is when the limit runs out or the schedule starts.
 */
data class Warning(val key: String, val kind: WarningKind, val id: String, val at: Long, val kidText: KidText)

/** Lock the screen once for [key] (DevicePolicyManager.lockNow): a schedule with `lock` has started. */
data class LockNow(val key: String, val scheduleId: String)

enum class BoundaryKind { DAY_STARTS, SCHEDULE_STARTS, SCHEDULE_ENDS, LIMIT_RUNS_OUT, WARNING, PAUSE_ENDS }

/** A time the decision may change by the clock alone. */
data class Boundary(val at: Long, val kind: BoundaryKind, val id: String? = null)

/** What screen time means on the phone right now. Pure: the same inputs give the same decision. */
data class Decision(
    /** The day the limits count, as the policy's zone and day_starts cut days. */
    val day: LocalDate,
    val days: DayClock,
    val now: Long,
    /** Every app Belay pauses for screen time now; the agent adds them to Phase 2's plan. */
    val suspend: Map<String, Suspension>,
    val limits: List<LimitStatus>,
    /** Schedules on now. */
    val schedules: List<ScheduleStatus>,
    /** For each installed app a limit covers, the time before a limit pauses it: 0 while one does. */
    val left: Map<String, Long>,
    /** Usage access is on, so Belay is counting. */
    val measured: Boolean,
    /** What to tell the kid while Belay can't count; null while it can. */
    val unmeasured: KidText?,
    val selfServe: SelfServeStatus?,
    /** Due now; show each key once. */
    val warnings: List<Warning>,
    /** Due now; lock once per key. */
    val lockNow: List<LockNow>,
    /** The next boundary: set an exact alarm for it (setExactAndAllowWhileIdle) and evaluate again then. */
    val nextAt: Long,
    /** Every boundary ahead, soonest first. */
    val boundaries: List<Boundary>,
    /** Screen time so far today. */
    val screenMillis: Long,
    /** Belay's own words for what the policy asks and Belay won't or can't do, for the enforcement report. */
    val problems: List<String>,
    /** The policy's `measure`: minutes go to the server only when it's on. */
    val sendMinutes: Boolean,
    /** The self-serve minutes the kid took today, for the enforcement report. */
    val selfServeToday: List<SelfServeTake>,
) {
    /** Whole minutes left before a limit pauses [packageName], rounded up; null when no limit covers it. */
    fun leftMinutes(packageName: String): Int? = left[packageName]?.let(::minutesUp)

    /**
     * `enforcement.screen_time`, within the protocol's bounds (the server refuses a check-in
     * that isn't): minutes at most [ScreenTimeWireLimits.MAX_STATUS_MINUTES] (a limit with
     * plenty of extra time can have more left), at most 50 limits and the newest 20 takes.
     */
    fun status(): WireScreenTimeStatus = WireScreenTimeStatus(
        day = day.toString(),
        measured = measured,
        usedMinutes = if (sendMinutes) reported(screenMillis / MINUTE) else null,
        limits = limits.take(ScreenTimeWireLimits.MAX_LIMITS).map {
            WireLimitStatus(
                id = it.id,
                used = if (sendMinutes) reported(it.usedMillis / MINUTE) else null,
                left = if (sendMinutes) reported(minutesUp(it.leftMillis).toLong()) else null,
                state = it.state,
            )
        },
        schedule = schedules.maxByOrNull { it.until }?.let { WireScheduleNow(it.id, it.until) },
        selfServe = selfServeToday.sortedBy { it.at }.takeLast(ScreenTimeWireLimits.MAX_STATUS_TAKES).map { it.toWire() },
    )

    private fun reported(minutes: Long): Int = minutes.coerceIn(0, ScreenTimeWireLimits.MAX_STATUS_MINUTES.toLong()).toInt()

    /** The kid's Today screen, top first: a pause, "can't count", schedules on now, each limit, self-serve. */
    fun today(): List<KidText> = buildList {
        suspend.values.firstNotNullOfOrNull { s -> s.reasons.firstOrNull { it is Reason.Paused }?.let { s.kidText } }?.let(::add)
        unmeasured?.let(::add)
        schedules.forEach { add(it.kidText) }
        limits.forEach { add(it.kidText) }
        selfServe?.kidText?.let(::add)
    }
}

private const val MINUTE = 60_000L

private fun minutesUp(millis: Long): Int = ((millis + MINUTE - 1) / MINUTE).toInt()

/** A limit the phone can enforce: the policy's, with what it covers read. */
internal class LimitRule(val wire: WireLimit, val kind: LimitKind, val packages: Set<String>) {
    val id: String get() = wire.id

    /** Counts toward it: never a never-blocked or exempt app. */
    fun covers(name: String, protected: Set<String>): Boolean = name !in protected && (kind == LimitKind.TOTAL || name in packages)

    fun minutes(day: DayOfWeek): Int = wire.byDay?.get(day)?.takeIf { it in 0..ScreenTimeWireLimits.MAX_DAY_MINUTES } ?: wire.minutes

    companion object {
        fun of(wire: WireLimit, neverBlocked: Set<String>, exempt: Set<String>, problems: MutableList<String>): LimitRule? {
            val max = ScreenTimeWireLimits.MAX_DAY_MINUTES
            if (wire.minutes !in 0..max) {
                problems += "Limit ${wire.id}: ${wire.minutes} minutes a day isn't 0 to $max, so it's ignored."
                return null
            }
            wire.byDay?.let { byDay ->
                DayOfWeek.entries.filter { day -> byDay[day]?.let { it !in 0..max } == true }.forEach {
                    problems += "Limit ${wire.id}: the minutes for ${it.name.lowercase()} aren't 0 to $max, so its usual minutes count."
                }
            }
            val total = WireLimit.EVERY_APP in wire.packages
            val named = wire.packages.filter { it != WireLimit.EVERY_APP }
            if (!total) named.filter { it in neverBlocked }.forEach { problems += "${it.take(120)} can't have a time limit: Belay never pauses it." }
            val packages = named.filterTo(LinkedHashSet()) { it !in neverBlocked && it !in exempt }
            if (!total && packages.isEmpty()) return null
            val kind = when {
                total -> LimitKind.TOTAL
                packages.size == 1 -> LimitKind.APP
                else -> LimitKind.CATEGORY
            }
            return LimitRule(wire, kind, if (total) emptySet() else packages)
        }
    }
}

/**
 * Screen time's rules, as a pure function (docs/design/phase3-screen-time.md, "Deciding"):
 * - Never-blocked packages (Phase 2) and the policy's `exempt` are never paused or counted, so
 *   calls, texts, 911 and 988 always work.
 * - A limit covers its packages; `["*"]` covers every app that isn't exempt (a daily total), and
 *   several apps sharing one limit count once when they're side by side. Several limits can cover
 *   one app; any one used up pauses it. A limit of 0 minutes pauses its apps all that day.
 * - Extra time (a parent's, or self-serve) adds minutes for the day: to one limit or "*" (every
 *   limit), for any of its apps or only the one named. Used past the limit's own minutes, it ends
 *   with the day.
 * - A schedule pauses every launchable app except never-blocked, exempt, the phone's keep-open
 *   apps and its `allow` list, from its start to its end on its days, except `skip` dates.
 * - A daily total, a schedule and a pause leave [Input.keepOpen] alone (the clock, so alarms still
 *   ring); a limit that names one of them still pauses it.
 * - While Belay can't count (usage access off), `if_unmeasured` decides: `pause_limited` pauses
 *   every app with a limit, `keep_open` keeps them open. Either way a limit already used up stays
 *   used up, counted from the last usage known, so turning usage access off can't reopen an app.
 *   Schedules don't need counting and work either way.
 * - Inputs that decide nothing are ignored, never guessed, and reported in [Decision.problems].
 */
object Rules {
    /** How far ahead Belay looks for when a paused app opens again. */
    const val HORIZON_DAYS = 8L

    data class Input(
        val policy: WireScreenTime,
        val now: Long,
        /** The phone's own zone (ZoneId.systemDefault()), for `zone: "phone"`. */
        val phoneZone: ZoneId,
        /** Usage up to now: ScreenTime.advance's usage, from the same read; null before the first. */
        val usage: UsageLog?,
        /** The apps on the screen now (UsageUpdate.foreground), to tell when a limit will run out. */
        val foreground: List<String> = emptyList(),
        /** Usage access is on, so the usage is counted up to now (UsageUpdate.measured). */
        val measured: Boolean,
        /** Launchable apps installed now: what a daily total, a schedule or a pause can pause. */
        val apps: Set<String>,
        /** Phase 2's never-blocked packages (NeverBlocked.of(...).keys): never paused or counted. */
        val neverBlocked: Set<String>,
        /** Phase 2's PhoneRoles.pauseExempt (the clock, the keyboard): left alone by blanket rules. */
        val keepOpen: Set<String> = emptySet(),
        /** Self-serve minutes the kid took, as the phone recorded them. */
        val selfServe: List<SelfServeTake> = emptyList(),
        /** Phase 2's pause, so the kid hears one reason and its end is a boundary. */
        val pause: WirePause? = null,
    )

    /** The days the policy counts: its zone ("phone": [phoneZone]) and day_starts, falling back with a problem. */
    fun dayClock(policy: WireScreenTime, phoneZone: ZoneId, problems: MutableList<String> = mutableListOf()): DayClock {
        val zone = LocalTimes.zone(policy.zone, phoneZone) ?: phoneZone.also {
            problems += "The zone \"${policy.zone.take(40)}\" isn't a time zone, so the phone's own is used."
        }
        val starts = LocalTimes.clock(policy.dayStarts) ?: LocalTime.MIDNIGHT.also {
            problems += "day_starts \"${policy.dayStarts.take(20)}\" isn't a time like 04:00, so days start at midnight."
        }
        return DayClock(zone, starts)
    }

    fun evaluate(input: Input): Decision = Evaluation(input).decision()
}

private class Evaluation(private val input: Rules.Input) {
    private val policy = input.policy
    private val now = input.now
    private val problems = mutableListOf<String>()
    private val days = Rules.dayClock(policy, input.phoneZone, problems)
    private val zone = days.zone
    private val today = days.dayAt(now)
    private val dayStart = days.startOf(today)
    private val dayEnd = days.endOf(today)
    private val exempt = policy.exempt.toSet()
    private val protected = input.neverBlocked + exempt
    private val installed = input.apps - input.neverBlocked
    private val blanket = installed - exempt - input.keepOpen
    private val usage = input.usage
    private val countedTo = usage?.asOf?.coerceIn(dayStart, dayEnd) ?: dayStart
    private val grants = Grants.of(policy, input.selfServe, problems)
    private val limits = readLimits().map { LimitEval(it) }
    private val schedules = readSchedules()
    private val calendarToday = LocalTimes.local(now, zone).toLocalDate()
    private val occurrences = schedules.flatMap {
        it.occurrences(calendarToday.minusDays(1), calendarToday.plusDays(Rules.HORIZON_DAYS), zone)
    }
    private val active = occurrences.filter { it.activeAt(now) }
    private val pause = input.pause?.takeIf { p -> p.until.let { it == null || it > now } }
    private val warnMs = policy.warnBefore.coerceAtLeast(0) * MINUTE

    private inner class LimitEval(val rule: LimitRule) {
        val base = rule.minutes(today.dayOfWeek) * MINUTE
        private val applying = grants.filter { it.day == today && it.appliesTo(rule.id) }
        val extra = applying.filter { it.packageName == null }.sumOf { it.minutes * MINUTE }
        private val forApp: Map<String, Long> = applying
            .mapNotNull { grant -> grant.packageName?.let { it to grant.minutes * MINUTE } }
            .groupBy({ it.first }, { it.second })
            .mapValues { it.value.sum() }
        val used = usage?.unionMillis(dayStart, countedTo) { rule.covers(it, protected) } ?: 0L
        val suspendable: Set<String> = if (rule.kind == LimitKind.TOTAL) blanket else rule.packages.intersect(installed)
        val allowed get() = base + extra

        fun threshold(name: String) = allowed + (forApp[name] ?: 0L)

        fun usedUp(name: String) = used >= threshold(name)

        fun left(name: String) = (threshold(name) - used).coerceAtLeast(0)

        /** Every time ahead when one of its apps runs out, while one of them is on the screen. */
        fun thresholds(): Set<Long> = (suspendable.map { threshold(it) } + allowed).toSet()

        /** On a later [day], with no usage yet: paused all day only when it has no minutes then. */
        fun noMinutes(day: LocalDate, name: String): Boolean {
            val extra = grants.filter { it.day == day && it.appliesTo(rule.id) && (it.packageName == null || it.packageName == name) }
            return rule.minutes(day.dayOfWeek) + extra.sumOf { it.minutes } <= 0
        }
    }

    fun decision(): Decision {
        val reasons = HashMap<String, LinkedHashSet<Reason>>()
        fun add(name: String, reason: Reason) {
            reasons.getOrPut(name) { LinkedHashSet() } += reason
        }
        pause?.let { p -> blanket.forEach { add(it, Reason.Paused(p.until)) } }
        for (o in active) {
            val reason = Reason.Schedule(o.rule.id, o.rule.wire.kind, o.rule.wire.name, o.end)
            (blanket - o.rule.allow).forEach { add(it, reason) }
        }
        for (limit in limits) {
            val reason = Reason.Limit(limit.rule.id, limit.rule.wire.name, limit.rule.kind)
            limit.suspendable.filter { limit.usedUp(it) }.forEach { add(it, reason) }
        }
        if (!input.measured && policy.ifUnmeasured == WireIfUnmeasured.PAUSE_LIMITED) {
            limits.forEach { limit -> limit.suspendable.forEach { add(it, Reason.Unmeasured) } }
        }

        val suspend = reasons.mapValues { (name, set) ->
            val ordered = set.sortedWith(compareBy<Reason> { priority(it) }.thenByDescending { (it as? Reason.Schedule)?.until ?: 0 })
            val opensAt = if (Reason.Unmeasured in set) null else opensAt(name)
            Suspension(name, ordered, opensAt, suspensionText(ordered.first(), opensAt))
        }.toSortedMap()

        val selfServe = SelfServe.status(policy, input.selfServe, today)
        return Decision(
            day = today,
            days = days,
            now = now,
            suspend = suspend,
            limits = limits.map { limitStatus(it, suspend) },
            schedules = active.map { o ->
                ScheduleStatus(
                    o.rule.id, o.rule.wire.kind, o.rule.wire.name, o.start, o.end, o.rule.allow,
                    scheduleText(o.rule.wire, o.end),
                )
            },
            left = left(),
            measured = input.measured,
            unmeasured = when {
                input.measured -> null
                policy.ifUnmeasured == WireIfUnmeasured.PAUSE_LIMITED && limits.isNotEmpty() -> kid(KidMessage.UNMEASURED_PAUSED)
                else -> kid(KidMessage.UNMEASURED)
            },
            selfServe = selfServe,
            warnings = warnings(suspend.keys),
            lockNow = active.filter { it.rule.wire.lock }.map { LockNow(it.key, it.rule.id) },
            nextAt = boundaries.first().at,
            boundaries = boundaries,
            screenMillis = usage?.screenMillis(dayStart, countedTo) ?: 0L,
            problems = problems.distinct().map { it.take(WireLimits.MAX_PROBLEM) }.take(WireLimits.MAX_PROBLEMS),
            sendMinutes = policy.measure,
            selfServeToday = input.selfServe.filter { it.day == today.toString() }.distinctBy { it.id },
        )
    }

    private fun priority(reason: Reason): Int = when (reason) {
        is Reason.Paused -> 0
        is Reason.Schedule -> 1
        is Reason.Limit -> 2
        Reason.Unmeasured -> 3
    }

    // When a paused app opens again: the first time ahead when a pause, a schedule or a day ends and
    // nothing else holds it, with no new usage (a paused app isn't used).
    private val openings: List<Long> by lazy {
        val horizon = now + Rules.HORIZON_DAYS * 24 * 60 * MINUTE
        val dayStarts = generateSequence(dayEnd) { days.endOf(days.dayAt(it)) }.takeWhile { it <= horizon }
        (listOfNotNull(pause?.until) + occurrences.map { it.end } + dayStarts)
            .filter { it in (now + 1)..horizon }
            .distinct()
            .sorted()
    }

    private fun opensAt(name: String): Long? = openings.firstOrNull { !pausedAt(name, it) }

    private fun pausedAt(name: String, at: Long): Boolean {
        if (name in blanket) {
            if (pause != null && pause.until.let { it == null || at < it }) return true
            if (occurrences.any { it.activeAt(at) && name !in it.rule.allow }) return true
        }
        val day = days.dayAt(at)
        return limits.any { limit ->
            name in limit.suspendable && if (day == today) limit.usedUp(name) else limit.noMinutes(day, name)
        }
    }

    private fun limitStatus(limit: LimitEval, suspend: Map<String, Suspension>): LimitStatus {
        val left = (limit.allowed - limit.used).coerceAtLeast(0)
        val state = when {
            limit.used < limit.base -> WireLimitState.OPEN
            limit.suspendable.any { !limit.usedUp(it) } || limit.used < limit.allowed -> WireLimitState.EXTRA
            else -> WireLimitState.USED_UP
        }
        val opensAt = if (state != WireLimitState.USED_UP) {
            null
        } else {
            val mine = limit.suspendable.mapNotNull { suspend[it] }.filter { s -> s.reasons.any { it is Reason.Limit && it.limitId == limit.rule.id } }
            if (mine.isEmpty()) dayEnd else mine.mapNotNull { it.opensAt }.minOrNull()
        }
        val name = limit.rule.wire.name
        val text = when {
            !input.measured && state != WireLimitState.USED_UP -> kid(KidMessage.LIMIT_NOT_COUNTED, KidArg.Words(name))
            state == WireLimitState.USED_UP -> limitUpText(limit.rule.kind, name, opensAt)
            limit.rule.kind == LimitKind.TOTAL -> kid(KidMessage.TOTAL_LEFT, KidArg.Minutes(minutesUp(left)))
            else -> kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(minutesUp(left)), KidArg.Words(name))
        }
        return LimitStatus(
            id = limit.rule.id,
            name = name,
            kind = limit.rule.kind,
            packages = limit.suspendable,
            baseMillis = limit.base,
            extraMillis = limit.extra,
            usedMillis = limit.used,
            leftMillis = left,
            state = state,
            resetsAt = dayEnd,
            opensAt = opensAt,
            kidText = text,
        )
    }

    private fun left(): Map<String, Long> {
        val out = HashMap<String, Long>()
        for (limit in limits) {
            for (name in limit.suspendable) out[name] = minOf(out[name] ?: Long.MAX_VALUE, limit.left(name))
        }
        return out.toSortedMap()
    }

    /** Limits that run out while one of their apps is on the screen; none while Belay can't count. */
    private fun runningLimits(): List<LimitEval> =
        if (!input.measured) emptyList() else limits.filter { limit -> input.foreground.any { limit.rule.covers(it, protected) } }

    private fun warnings(suspended: Set<String>): List<Warning> {
        if (warnMs <= 0) return emptyList()
        val out = LinkedHashMap<String, Warning>()
        fun stage(ahead: Long) = if (ahead <= MINUTE) 1 else policy.warnBefore
        for (limit in runningLimits()) {
            for (name in input.foreground.filter { it in limit.suspendable && it !in suspended }) {
                val ahead = limit.left(name)
                if (ahead > warnMs) continue
                val key = "limit:${limit.rule.id}:$today:${limit.threshold(name) / MINUTE}:${stage(ahead)}"
                val text = if (limit.rule.kind == LimitKind.TOTAL) {
                    kid(KidMessage.TOTAL_LEFT, KidArg.Minutes(minutesUp(ahead)))
                } else {
                    kid(KidMessage.LIMIT_LEFT, KidArg.Minutes(minutesUp(ahead)), KidArg.Words(limit.rule.wire.name))
                }
                out.putIfAbsent(key, Warning(key, WarningKind.LIMIT_ENDING, limit.rule.id, now + ahead, text))
            }
        }
        for (o in occurrences) {
            val ahead = o.start - now
            if (ahead <= 0 || ahead > warnMs) continue
            val key = "${o.key}:${stage(ahead)}"
            out.putIfAbsent(key, Warning(key, WarningKind.SCHEDULE_STARTING, o.rule.id, o.start, soonText(o.rule.wire, minutesUp(ahead))))
        }
        return out.values.toList()
    }

    /** Every boundary ahead; the day's end is always one. */
    private val boundaries: List<Boundary> by lazy {
        val out = mutableListOf(Boundary(dayEnd, BoundaryKind.DAY_STARTS))
        val warnAhead = if (warnMs > 0) listOf(warnMs, MINUTE).distinct() else emptyList()
        fun warnBefore(at: Long, id: String) = warnAhead.forEach { out += Boundary(at - it, BoundaryKind.WARNING, id) }
        for (o in occurrences) {
            out += Boundary(o.start, BoundaryKind.SCHEDULE_STARTS, o.rule.id)
            out += Boundary(o.end, BoundaryKind.SCHEDULE_ENDS, o.rule.id)
            warnBefore(o.start, o.rule.id)
        }
        pause?.until?.let { out += Boundary(it, BoundaryKind.PAUSE_ENDS) }
        for (limit in runningLimits()) {
            for (threshold in limit.thresholds().filter { it > limit.used }) {
                val runsOut = now + (threshold - limit.used)
                out += Boundary(runsOut, BoundaryKind.LIMIT_RUNS_OUT, limit.rule.id)
                warnBefore(runsOut, limit.rule.id)
            }
        }
        out.filter { it.at > now }.distinct().sortedWith(compareBy<Boundary> { it.at }.thenBy { it.kind })
    }

    private fun moment(at: Long) = KidArg.Moment.of(at, now, zone)

    private fun suspensionText(reason: Reason, opensAt: Long?): KidText = when (reason) {
        is Reason.Paused -> reason.until?.let { kid(KidMessage.PAUSED_UNTIL, moment(it)) } ?: kid(KidMessage.PAUSED)
        is Reason.Schedule -> scheduleText(reason.kind, reason.name, reason.until)
        is Reason.Limit -> limitUpText(reason.kind, reason.name, opensAt)
        Reason.Unmeasured -> kid(KidMessage.UNMEASURED_PAUSED)
    }

    private fun scheduleText(schedule: WireSchedule, until: Long) = scheduleText(schedule.kind, schedule.name, until)

    private fun scheduleText(kind: WireScheduleKind, name: String, until: Long): KidText = when (kind) {
        WireScheduleKind.SCHOOL -> kid(KidMessage.SCHOOL_UNTIL, moment(until), KidArg.Words(name))
        WireScheduleKind.BEDTIME -> kid(KidMessage.BEDTIME_UNTIL, moment(until), KidArg.Words(name))
        WireScheduleKind.CUSTOM -> kid(KidMessage.SCHEDULE_UNTIL, KidArg.Words(name), moment(until))
    }

    private fun soonText(schedule: WireSchedule, minutes: Int): KidText = when (schedule.kind) {
        WireScheduleKind.SCHOOL -> kid(KidMessage.SCHOOL_SOON, KidArg.Minutes(minutes), KidArg.Words(schedule.name))
        WireScheduleKind.BEDTIME -> kid(KidMessage.BEDTIME_SOON, KidArg.Minutes(minutes), KidArg.Words(schedule.name))
        WireScheduleKind.CUSTOM -> kid(KidMessage.SCHEDULE_SOON, KidArg.Words(schedule.name), KidArg.Minutes(minutes))
    }

    private fun limitUpText(kind: LimitKind, name: String, opensAt: Long?): KidText = when {
        kind == LimitKind.TOTAL -> opensAt?.let { kid(KidMessage.TOTAL_UP, moment(it)) } ?: kid(KidMessage.TOTAL_UP_FOR_NOW)
        else -> opensAt?.let { kid(KidMessage.LIMIT_UP, KidArg.Words(name), moment(it)) } ?: kid(KidMessage.LIMIT_UP_FOR_NOW, KidArg.Words(name))
    }

    private fun readLimits(): List<LimitRule> {
        val out = mutableListOf<LimitRule>()
        val ids = HashSet<String>()
        for (wire in policy.limits) {
            if (out.size == ScreenTimeWireLimits.MAX_LIMITS) {
                problems += "The policy has more than ${ScreenTimeWireLimits.MAX_LIMITS} limits; only the first are used."
                break
            }
            val rule = LimitRule.of(wire, input.neverBlocked, exempt, problems) ?: continue
            if (ids.add(rule.id)) out += rule else problems += "Limit ${rule.id} is in the policy twice; the first one is used."
        }
        return out
    }

    private fun readSchedules(): List<ScheduleRule> {
        val out = mutableListOf<ScheduleRule>()
        val ids = HashSet<String>()
        for (wire in policy.schedules) {
            if (out.size == ScreenTimeWireLimits.MAX_SCHEDULES) {
                problems += "The policy has more than ${ScreenTimeWireLimits.MAX_SCHEDULES} schedules; only the first are used."
                break
            }
            if (!ids.add(wire.id)) {
                problems += "Schedule ${wire.id} is in the policy twice; the first one is used."
                continue
            }
            ScheduleRule.of(wire, problems)?.let { out += it }
        }
        return out
    }
}
