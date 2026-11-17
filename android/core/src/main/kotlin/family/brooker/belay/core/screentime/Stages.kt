package family.brooker.belay.core.screentime

import family.brooker.belay.core.WirePolicy
import java.time.DayOfWeek
import java.time.LocalTime
import java.util.BitSet

/** A named level that bundles rules: the server's stage template, as the phone may compare two. */
data class Stage(val name: String, val number: Int, val rules: WireScreenTime)

/**
 * Whether a change makes the rules stricter. The server's classifyScreenTimeChange decides what an
 * AI client may apply (only tightening), and these follow the same list; a change that does both
 * counts as loosening, so it needs a parent.
 */
enum class Effect { LOOSENS, TIGHTENS, NEITHER }

enum class ChangeKind {
    LIMIT_MINUTES,
    LIMIT_ADDED,
    LIMIT_REMOVED,
    LIMIT_APPS_ADDED,
    LIMIT_APPS_REMOVED,
    SCHEDULE_ADDED,
    SCHEDULE_REMOVED,
    SCHEDULE_TIMES,
    SCHEDULE_DAYS_ADDED,
    SCHEDULE_DAYS_REMOVED,
    SCHEDULE_ALLOWS,
    SCHEDULE_NO_LONGER_ALLOWS,
    SCHEDULE_LOCKS,
    SCHEDULE_NO_LONGER_LOCKS,
    EXEMPT_ADDED,
    EXEMPT_REMOVED,
    SELF_SERVE,
    IF_UNMEASURED,
    WARN_BEFORE,
}

/**
 * One difference between two sets of rules. [about] is the limit's or schedule's id in the newer
 * rules (in the older ones for a removal); [kidText] is how the kid's screen says it.
 */
data class RuleChange(val kind: ChangeKind, val effect: Effect, val about: String?, val kidText: KidText)

/**
 * What the next stage changes. Only the rules a stage bundles count: limits, schedules, exempt
 * apps, self-serve, "can't count" and warnings. Extra time is for a day, and the zone, day_starts
 * and measure are the family's settings, not a stage's.
 *
 * Limits are matched by id, then by the same apps, then by the same name, and a daily total only
 * matches a daily total. Schedules are matched by id, then by kind and name, then by kind when
 * each side has one of it left.
 */
object Stages {
    private const val DAY_MINUTES = 24 * 60
    private const val WEEK_MINUTES = 7 * DAY_MINUTES

    /** What changes from [from] to [to], in order: limits, schedules, exempt apps, self-serve, can't count, warnings. */
    fun changes(from: WireScreenTime?, to: WireScreenTime?): List<RuleChange> {
        val before = from ?: WireScreenTime()
        val after = to ?: WireScreenTime()
        return limits(before.limits, after.limits) +
            schedules(before.schedules, after.schedules) +
            exempt(before.exempt, after.exempt) +
            selfServe(before.selfServe, after.selfServe) +
            unmeasured(before.ifUnmeasured, after.ifUnmeasured) +
            warnings(before.warnBefore, after.warnBefore)
    }

    fun changes(from: Stage, to: Stage): List<RuleChange> = changes(from.rules, to.rules)

    /** What the policy's next stage changes, for "Your stage"; empty when the policy doesn't say. */
    fun next(policy: WirePolicy): List<RuleChange> {
        val next = policy.stage?.next?.screenTime ?: return emptyList()
        return changes(policy.screenTime, next)
    }

    /** An AI client may apply only this kind of change; anything else is a proposal for a parent. */
    fun onlyTightens(changes: List<RuleChange>): Boolean = changes.isNotEmpty() && changes.all { it.effect == Effect.TIGHTENS }

    // Limits.

    private fun isTotal(limit: WireLimit) = WireLimit.EVERY_APP in limit.packages

    private fun apps(limit: WireLimit): Set<String> = limit.packages.filterTo(sortedSetOf()) { it != WireLimit.EVERY_APP }

    private fun minutesByDay(limit: WireLimit): Map<DayOfWeek, Int> = DayOfWeek.entries.associateWith { day ->
        limit.byDay?.get(day)?.takeIf { it in 0..ScreenTimeWireLimits.MAX_DAY_MINUTES } ?: limit.minutes
    }

    private fun limitName(limit: WireLimit) = KidArg.Words(limit.name)

    private fun limits(from: List<WireLimit>, to: List<WireLimit>): List<RuleChange> {
        val (pairs, removed, added) = match(
            from.filter { it.minutes in 0..ScreenTimeWireLimits.MAX_DAY_MINUTES },
            to.filter { it.minutes in 0..ScreenTimeWireLimits.MAX_DAY_MINUTES },
            listOf<(WireLimit, WireLimit) -> Boolean>(
                { a, b -> a.id == b.id && isTotal(a) == isTotal(b) },
                { a, b -> isTotal(a) == isTotal(b) && apps(a) == apps(b) },
                { a, b -> !isTotal(a) && !isTotal(b) && a.name.trim().equals(b.name.trim(), ignoreCase = true) },
            ),
        )
        val out = mutableListOf<RuleChange>()
        for ((old, new) in pairs) {
            val was = minutesByDay(old)
            val now = minutesByDay(new)
            DayOfWeek.entries.filter { was[it] != now[it] }.groupBy { was.getValue(it) to now.getValue(it) }.forEach { (change, days) ->
                val (a, b) = change
                val text = if (isTotal(new)) {
                    kid(KidMessage.TOTAL_CHANGES, KidArg.Minutes(a), KidArg.Minutes(b), KidArg.Days(days.toSet()))
                } else {
                    kid(KidMessage.LIMIT_CHANGES, limitName(new), KidArg.Minutes(b), KidArg.Minutes(a), KidArg.Days(days.toSet()))
                }
                out += RuleChange(ChangeKind.LIMIT_MINUTES, if (b > a) Effect.LOOSENS else Effect.TIGHTENS, new.id, text)
            }
            val more = (apps(new) - apps(old)).toList()
            val fewer = (apps(old) - apps(new)).toList()
            if (more.isNotEmpty()) {
                out += RuleChange(ChangeKind.LIMIT_APPS_ADDED, Effect.TIGHTENS, new.id, kid(KidMessage.LIMIT_APPS_ADDED, limitName(new), KidArg.Apps(more)))
            }
            if (fewer.isNotEmpty()) {
                out += RuleChange(ChangeKind.LIMIT_APPS_REMOVED, Effect.LOOSENS, new.id, kid(KidMessage.LIMIT_APPS_REMOVED, limitName(new), KidArg.Apps(fewer)))
            }
        }
        for (new in added) {
            minutesByDay(new).entries.groupBy({ it.value }, { it.key }).forEach { (minutes, days) ->
                val text = if (isTotal(new)) {
                    kid(KidMessage.TOTAL_ADDED, KidArg.Minutes(minutes), KidArg.Days(days.toSet()))
                } else {
                    kid(KidMessage.LIMIT_ADDED, limitName(new), KidArg.Minutes(minutes), KidArg.Days(days.toSet()))
                }
                out += RuleChange(ChangeKind.LIMIT_ADDED, Effect.TIGHTENS, new.id, text)
            }
        }
        for (old in removed) {
            val text = if (isTotal(old)) kid(KidMessage.TOTAL_REMOVED) else kid(KidMessage.LIMIT_REMOVED, limitName(old))
            out += RuleChange(ChangeKind.LIMIT_REMOVED, Effect.LOOSENS, old.id, text)
        }
        return out
    }

    // Schedules.

    private fun schedules(from: List<WireSchedule>, to: List<WireSchedule>): List<RuleChange> {
        val ignored = mutableListOf<String>()
        val before = from.mapNotNull { ScheduleRule.of(it, ignored) }
        val after = to.mapNotNull { ScheduleRule.of(it, ignored) }
        val (pairs, removed, added) = match(
            before,
            after,
            listOf<(ScheduleRule, ScheduleRule) -> Boolean>(
                { a, b -> a.id == b.id },
                { a, b -> a.wire.kind == b.wire.kind && a.wire.name.trim().equals(b.wire.name.trim(), ignoreCase = true) },
            ),
        ).let { (named, gone, new) ->
            // Then by kind, when each side has exactly one of that kind left.
            fun one(list: List<ScheduleRule>, kind: WireScheduleKind) = list.count { it.wire.kind == kind } == 1
            val byKind = gone.filter { one(gone, it.wire.kind) && one(new, it.wire.kind) }
                .map { old -> old to new.first { it.wire.kind == old.wire.kind } }
            Triple(named + byKind, gone - byKind.map { it.first }.toSet(), new - byKind.map { it.second }.toSet())
        }
        val out = mutableListOf<RuleChange>()
        for ((old, new) in pairs) {
            val name = KidArg.Words(new.wire.name)
            if (old.start != new.start || old.end != new.end) {
                val text = kid(
                    KidMessage.SCHEDULE_TIMES, name,
                    KidArg.Clock(old.start), KidArg.Clock(old.end), KidArg.Clock(new.start), KidArg.Clock(new.end),
                )
                val effect = effect(coverage(old.days, old.start, old.end), coverage(old.days, new.start, new.end))
                out += RuleChange(ChangeKind.SCHEDULE_TIMES, effect, new.id, text)
            }
            val moreDays = new.days - old.days
            val fewerDays = old.days - new.days
            if (moreDays.isNotEmpty()) {
                out += RuleChange(ChangeKind.SCHEDULE_DAYS_ADDED, Effect.TIGHTENS, new.id, kid(KidMessage.SCHEDULE_DAYS_ADDED, name, KidArg.Days(moreDays)))
            }
            if (fewerDays.isNotEmpty()) {
                out += RuleChange(ChangeKind.SCHEDULE_DAYS_REMOVED, Effect.LOOSENS, new.id, kid(KidMessage.SCHEDULE_DAYS_REMOVED, name, KidArg.Days(fewerDays)))
            }
            val allows = (new.allow - old.allow).sorted()
            val stops = (old.allow - new.allow).sorted()
            if (allows.isNotEmpty()) {
                out += RuleChange(ChangeKind.SCHEDULE_ALLOWS, Effect.LOOSENS, new.id, kid(KidMessage.SCHEDULE_ALLOWS, name, KidArg.Apps(allows)))
            }
            if (stops.isNotEmpty()) {
                out += RuleChange(ChangeKind.SCHEDULE_NO_LONGER_ALLOWS, Effect.TIGHTENS, new.id, kid(KidMessage.SCHEDULE_NO_LONGER_ALLOWS, name, KidArg.Apps(stops)))
            }
            if (old.wire.lock != new.wire.lock) {
                out += if (new.wire.lock) {
                    RuleChange(ChangeKind.SCHEDULE_LOCKS, Effect.TIGHTENS, new.id, kid(KidMessage.SCHEDULE_LOCKS, name))
                } else {
                    RuleChange(ChangeKind.SCHEDULE_NO_LONGER_LOCKS, Effect.LOOSENS, new.id, kid(KidMessage.SCHEDULE_NO_LONGER_LOCKS, name))
                }
            }
        }
        for (new in added) {
            val text = kid(
                KidMessage.SCHEDULE_ADDED, KidArg.Words(new.wire.name), KidArg.Clock(new.start), KidArg.Clock(new.end), KidArg.Days(new.days),
            )
            out += RuleChange(ChangeKind.SCHEDULE_ADDED, Effect.TIGHTENS, new.id, text)
        }
        for (old in removed) {
            out += RuleChange(ChangeKind.SCHEDULE_REMOVED, Effect.LOOSENS, old.id, kid(KidMessage.SCHEDULE_REMOVED, KidArg.Words(old.wire.name)))
        }
        return out
    }

    /** The minutes of the week a schedule holds, from each of its days' start. */
    private fun coverage(days: Set<DayOfWeek>, start: LocalTime, end: LocalTime): BitSet {
        val bits = BitSet(WEEK_MINUTES)
        val from = start.hour * 60 + start.minute
        val to = (end.hour * 60 + end.minute).let { if (it <= from) it + DAY_MINUTES else it }
        for (day in days) {
            val base = (day.value - 1) * DAY_MINUTES
            for (minute in from until to) bits.set((base + minute) % WEEK_MINUTES)
        }
        return bits
    }

    private fun effect(before: BitSet, after: BitSet): Effect {
        val gains = (after.clone() as BitSet).apply { andNot(before) }
        val losses = (before.clone() as BitSet).apply { andNot(after) }
        return when {
            gains.isEmpty && losses.isEmpty -> Effect.NEITHER
            losses.isEmpty -> Effect.TIGHTENS
            else -> Effect.LOOSENS
        }
    }

    // The rest.

    private fun exempt(from: List<String>, to: List<String>): List<RuleChange> {
        val more = (to.toSet() - from.toSet()).sorted()
        val fewer = (from.toSet() - to.toSet()).sorted()
        return listOfNotNull(
            more.takeIf { it.isNotEmpty() }?.let { RuleChange(ChangeKind.EXEMPT_ADDED, Effect.LOOSENS, null, kid(KidMessage.EXEMPT_ADDED, KidArg.Apps(it))) },
            fewer.takeIf { it.isNotEmpty() }?.let { RuleChange(ChangeKind.EXEMPT_REMOVED, Effect.TIGHTENS, null, kid(KidMessage.EXEMPT_REMOVED, KidArg.Apps(it))) },
        )
    }

    private fun selfServe(from: WireSelfServe?, to: WireSelfServe?): List<RuleChange> {
        fun usable(rule: WireSelfServe?) = rule?.takeIf { it.minutes > 0 && it.times > 0 }
        val before = usable(from)
        val after = usable(to)
        if (before == after) return emptyList()
        if (after == null) return listOf(RuleChange(ChangeKind.SELF_SERVE, Effect.TIGHTENS, null, kid(KidMessage.SELF_SERVE_REMOVED)))
        val effect = when {
            before == null -> Effect.LOOSENS
            after.minutes <= before.minutes && after.times <= before.times -> Effect.TIGHTENS
            else -> Effect.LOOSENS
        }
        return listOf(
            RuleChange(ChangeKind.SELF_SERVE, effect, null, kid(KidMessage.SELF_SERVE_ALLOWED, KidArg.Count(after.minutes), KidArg.Count(after.times))),
        )
    }

    private fun unmeasured(from: WireIfUnmeasured, to: WireIfUnmeasured): List<RuleChange> = when {
        from == to -> emptyList()
        to == WireIfUnmeasured.KEEP_OPEN -> listOf(RuleChange(ChangeKind.IF_UNMEASURED, Effect.LOOSENS, null, kid(KidMessage.UNMEASURED_KEEPS_OPEN)))
        else -> listOf(RuleChange(ChangeKind.IF_UNMEASURED, Effect.TIGHTENS, null, kid(KidMessage.UNMEASURED_PAUSES)))
    }

    private fun warnings(from: Int, to: Int): List<RuleChange> {
        val before = from.coerceAtLeast(0)
        val after = to.coerceAtLeast(0)
        if (before == after) return emptyList()
        return listOf(RuleChange(ChangeKind.WARN_BEFORE, Effect.NEITHER, null, kid(KidMessage.WARNING_CHANGES, KidArg.Minutes(after))))
    }

    /** Pairs from [before] and [after] by each test in turn, then what's left on each side. */
    private fun <T> match(before: List<T>, after: List<T>, tests: List<(T, T) -> Boolean>): Triple<List<Pair<T, T>>, List<T>, List<T>> {
        val pairs = mutableListOf<Pair<T, T>>()
        val left = before.toMutableList()
        val right = after.toMutableList()
        for (test in tests) {
            for (old in left.toList()) {
                val new = right.firstOrNull { test(old, it) } ?: continue
                pairs += old to new
                left.remove(old)
                right.remove(new)
            }
        }
        return Triple(pairs, left, right)
    }
}
