package family.brooker.belay.core.screentime

import family.brooker.belay.core.Wire
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** An app's time on the screen in one day, and how many times it was opened. */
data class AppDay(val millis: Long, val opens: Int)

/** One local day of usage in milliseconds: what the kid's screen shows, and what the report rounds. */
data class DayUsage(
    val day: LocalDate,
    val days: DayClock,
    /** The day runs from [from] up to [to]: 23 or 25 hours across a DST change. */
    val from: Long,
    val to: Long,
    /** Counted, or known to be a gap, up to here; [to] once the day is over. */
    val asOf: Long,
    /** Screen on and unlocked. */
    val screenMillis: Long,
    val unlocks: Int,
    /** Screen time in each local hour, 0 to 23 (see WireUsageDay.byHour for DST days). */
    val byHour: List<Long>,
    val apps: Map<String, AppDay>,
    val gaps: List<Gap>,
) {
    val complete: Boolean get() = asOf >= to
}

/** Days of usage for the kid's screen, and for `POST /api/v1/usage`. */
object UsageReport {
    /** [day]'s usage, as [days] cuts days. The part of the day before [usage] starts is a gap (unknown). */
    fun day(usage: UsageLog, days: DayClock, day: LocalDate): DayUsage {
        val from = days.startOf(day)
        val to = days.endOf(day)
        val apps = usage.packagesIn(from, to).associateWith { AppDay(usage.millis(it, from, to), usage.opens(it, from, to)) }
        val gaps = mutableListOf<Gap>()
        Spans.addGap(gaps, from, minOf(usage.from, to), WireGapReason.UNKNOWN)
        usage.gapsIn(from, to).forEach { Spans.addGap(gaps, it.from, it.to, it.reason) }
        return DayUsage(
            day = day,
            days = days,
            from = from,
            to = to,
            asOf = usage.asOf.coerceIn(from, to),
            screenMillis = usage.screenMillis(from, to),
            unlocks = usage.unlocks(from, to),
            byHour = byHour(usage, days, from, to),
            apps = apps.toSortedMap(),
            gaps = gaps,
        )
    }

    /** Every day [usage] covers, oldest first. */
    fun days(usage: UsageLog, days: DayClock): List<DayUsage> = days.daysIn(usage.from, usage.asOf).map { day(usage, days, it) }

    private fun byHour(usage: UsageLog, days: DayClock, from: Long, to: Long): List<Long> {
        val hours = LongArray(24)
        var start = from
        while (start < to) {
            val local = LocalTimes.local(start, days.zone)
            // On the instant time-line, so the repeated hour comes round twice and the skipped one never.
            val end = minOf(local.truncatedTo(ChronoUnit.HOURS).plusHours(1).toInstant().toEpochMilli(), to)
            hours[local.hour] += usage.screenMillis(start, end)
            start = end
        }
        return hours.toList()
    }

    /** Whole minutes, to the nearest. */
    fun minutes(millis: Long): Int = ((millis + 30_000) / 60_000).toInt()

    /**
     * [day] for the server. Apps under a minute are left out, and so are [unlisted] apps: pass
     * Phase 2's never-blocked packages, whose time the design never counts. Their time on the phone
     * app can show a call to 988 or an emergency number, which Belay keeps out of its records
     * (principle 8, Phase 5); it still counts in the screen minutes, as the design proposes.
     */
    fun wire(day: DayUsage, unlisted: Set<String> = emptySet()): WireUsageDay = WireUsageDay(
        day = day.day.toString(),
        zone = day.days.zone.id,
        asOf = day.asOf,
        complete = day.complete,
        screenMinutes = minutes(day.screenMillis),
        unlocks = day.unlocks,
        byHour = day.byHour.map(::minutes),
        apps = day.apps.entries
            .filter { (name, app) -> name !in unlisted && app.millis >= 60_000 }
            .sortedWith(compareByDescending<Map.Entry<String, AppDay>> { it.value.millis }.thenBy { it.key })
            .take(ScreenTimeWireLimits.MAX_USAGE_APPS)
            .map { (name, app) -> WireUsageApp(name, minutes(app.millis), app.opens) },
        gaps = day.gaps.map { WireUsageGap(it.from, it.to, it.reason) },
    )

    /** Well under the server's 256 KB. */
    const val MAX_BODY_BYTES = 192 * 1024

    /** [days] in requests of at most 31 days and [maxBytes] of JSON, in order; a day too big alone still goes alone. */
    fun batches(days: List<WireUsageDay>, maxBytes: Int = MAX_BODY_BYTES): List<UsageRequest> {
        val out = mutableListOf<UsageRequest>()
        var batch = mutableListOf<WireUsageDay>()
        var bytes = WRAPPER_BYTES
        for (day in days) {
            val size = Wire.json.encodeToString(WireUsageDay.serializer(), day).toByteArray().size + 1
            if (batch.isNotEmpty() && (batch.size >= ScreenTimeWireLimits.MAX_USAGE_DAYS || bytes + size > maxBytes)) {
                out += UsageRequest(batch)
                batch = mutableListOf()
                bytes = WRAPPER_BYTES
            }
            batch += day
            bytes += size
        }
        if (batch.isNotEmpty()) out += UsageRequest(batch)
        return out
    }

    /** `{"days":[` and `]}`. */
    private const val WRAPPER_BYTES = 11
}
