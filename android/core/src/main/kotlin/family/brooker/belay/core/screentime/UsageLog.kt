package family.brooker.belay.core.screentime

import kotlinx.serialization.Serializable

/** A time from [from] up to [to] (epoch millis, [to] not included). */
@Serializable
data class Span(val from: Long, val to: Long) {
    val millis: Long get() = to - from
}

/** A time Belay couldn't count, and why. */
@Serializable
data class Gap(val from: Long, val to: Long, val reason: WireGapReason)

/**
 * What Belay counted from [from] up to [asOf]: each app's time on the screen ([apps]), the time the
 * screen was on and unlocked ([screen]), and the times it couldn't count ([gaps]). Everything is in
 * epoch millis. Days are cut only when someone asks for one, in the zone that is current then, so
 * a change of zone or of day_starts never counts a minute twice or loses one.
 *
 * Each list is sorted, without overlaps, and spans that touch are joined. A span starts when its
 * app comes to the screen, so an app's spans that start in a day are the times it was opened that
 * day, and the screen's spans that start in a day are the times the phone was unlocked.
 */
@Serializable
data class UsageLog(
    val from: Long,
    val asOf: Long,
    val apps: Map<String, List<Span>> = emptyMap(),
    val screen: List<Span> = emptyList(),
    val gaps: List<Gap> = emptyList(),
) {
    /** [packageName]'s time on the screen in [from, to). */
    fun millis(packageName: String, from: Long, to: Long): Long = Spans.overlap(apps[packageName].orEmpty(), from, to)

    /**
     * The time any app [include] accepts was on the screen in [from, to): two of them side by side
     * in split screen count once.
     */
    fun unionMillis(from: Long, to: Long, include: (String) -> Boolean): Long {
        val chosen = apps.filterKeys(include).values
        return when (chosen.size) {
            0 -> 0
            1 -> Spans.overlap(chosen.first(), from, to)
            else -> Spans.overlap(Spans.union(chosen.flatMap { list -> list.filter { it.to > from && it.from < to } }), from, to)
        }
    }

    /** The time the screen was on and unlocked in [from, to). */
    fun screenMillis(from: Long, to: Long): Long = Spans.overlap(screen, from, to)

    /** How many times [packageName] came to the screen in [from, to). */
    fun opens(packageName: String, from: Long, to: Long): Int = apps[packageName].orEmpty().count { it.from in from until to }

    /** How many times the phone was unlocked (or its screen came on unlocked) in [from, to). */
    fun unlocks(from: Long, to: Long): Int = screen.count { it.from in from until to }

    /** The gaps in [from, to), cut to it. */
    fun gapsIn(from: Long, to: Long): List<Gap> =
        gaps.filter { it.to > from && it.from < to }.map { it.copy(from = maxOf(it.from, from), to = minOf(it.to, to)) }

    /** The apps that were on the screen at some time in [from, to). */
    fun packagesIn(from: Long, to: Long): Set<String> =
        apps.filterValues { list -> list.any { it.to > from && it.from < to } }.keys

    /** Everything moved by [by] millis: Android moves its usage history this way when the clock changes. */
    fun shifted(by: Long): UsageLog = copy(
        from = from + by,
        asOf = asOf + by,
        apps = apps.mapValues { (_, spans) -> spans.map { Span(it.from + by, it.to + by) } },
        screen = screen.map { Span(it.from + by, it.to + by) },
        gaps = gaps.map { it.copy(from = it.from + by, to = it.to + by) },
    )

    /**
     * Without what ended before [before] (never after [asOf]). A span that runs across it is kept
     * whole, so the opens and unlocks of the days still kept stay right.
     */
    fun pruned(before: Long): UsageLog {
        val cut = minOf(before, asOf)
        if (cut <= from) return this
        return copy(
            from = cut,
            apps = apps.mapValues { (_, spans) -> spans.filter { it.to > cut } }.filterValues { it.isNotEmpty() },
            screen = screen.filter { it.to > cut },
            gaps = gaps.filter { it.to > cut },
        )
    }

    /**
     * The same record from [at] on: what came before is left out, and a span or gap running
     * across [at] starts there (so an app on the screen then counts as opened then). Belay sends
     * usage only from when the parent turned measuring on, though it counts the whole day to
     * keep the limits; the day's report shows the time before as a gap.
     */
    fun since(at: Long): UsageLog {
        if (at <= from) return this
        val cut = minOf(at, asOf)
        fun clip(spans: List<Span>) = spans.filter { it.to > cut }.map { if (it.from < cut) Span(cut, it.to) else it }
        return copy(
            from = cut,
            apps = apps.mapValues { (_, spans) -> clip(spans) }.filterValues { it.isNotEmpty() },
            screen = clip(screen),
            gaps = gaps.filter { it.to > cut }.map { if (it.from < cut) it.copy(from = cut) else it },
        )
    }

    /** With a gap from [from] to [to], counted up to [to]. */
    fun withGap(from: Long, to: Long, reason: WireGapReason): UsageLog {
        if (to <= from) return this
        val list = gaps.toMutableList()
        Spans.addGap(list, from, to, reason)
        return copy(asOf = maxOf(asOf, to), gaps = list)
    }
}

internal object Spans {
    fun overlap(spans: List<Span>, from: Long, to: Long): Long {
        var total = 0L
        for (span in spans) {
            val start = maxOf(span.from, from)
            val end = minOf(span.to, to)
            if (end > start) total += end - start
        }
        return total
    }

    /** One list without overlaps, in order. */
    fun union(spans: List<Span>): List<Span> {
        val out = mutableListOf<Span>()
        for (span in spans.sortedBy { it.from }) {
            val last = out.lastOrNull()
            if (last != null && span.from <= last.to) {
                if (span.to > last.to) out[out.size - 1] = Span(last.from, span.to)
            } else {
                out += span
            }
        }
        return out
    }

    /** Adds [from, to) at the end of [list], joined to the last span when they touch. */
    fun extend(list: MutableList<Span>, from: Long, to: Long) {
        if (to <= from) return
        val last = list.lastOrNull()
        when {
            last == null || from > last.to -> list += Span(from, to)
            to > last.to -> list[list.size - 1] = Span(last.from, to)
        }
    }

    /** Adds a gap at the end of [list], joined to the last one when they touch and have the same reason. */
    fun addGap(list: MutableList<Gap>, from: Long, to: Long, reason: WireGapReason) {
        if (to <= from) return
        val last = list.lastOrNull()
        when {
            last == null || from > last.to -> list += Gap(from, to, reason)
            to <= last.to -> Unit
            last.reason == reason -> list[list.size - 1] = last.copy(to = to)
            else -> list += Gap(last.to, to, reason)
        }
    }
}
