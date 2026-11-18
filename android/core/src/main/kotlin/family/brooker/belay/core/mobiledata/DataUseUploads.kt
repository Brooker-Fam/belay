package family.brooker.belay.core.mobiledata

import family.brooker.belay.core.StepCause
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * Which days of mobile data use the phone reads and sends (`POST /api/v1/mobile-data`, through the
 * outbox): only while the policy's `mobile_data.measure` is on (collection is a parent's
 * decision), and only from when it turned on: Android keeps 90 days of history (platform notes
 * Q7), and nothing from before the kid's screen said so is sent.
 * - Today so far, counted up to the last of [SO_FAR_AT] (noon and 6 PM by the phone's clock) that
 *   has passed, once each: a day is told in at most three parts, never by the hour, whenever the
 *   phone reads and sends it (the seventh review's M3: a day re-sent about hourly, with the time
 *   it was read, gave each hour's mobile data and Wi-Fi, so when the kid was off Wi-Fi).
 * - Each day once more when it's complete: [COMPLETE_AFTER_MS] after its end, when Android's last
 *   2-hour bucket for it has closed and been polled, with everything counted to its end.
 * - When measuring turns on, today counted from then to then (nothing yet): the parent page says
 *   counting began.
 * - At most [DAYS_BACK] days back: a phone that was off or offline longer sends the last week.
 * - Only at a step something other than a time passing or a call brought ([StepCause.dueReads]):
 *   while a lock waits for a call the policy timer steps every minute, so a read became due and
 *   went out within a minute of when it was due, all through the call, where the hourly watchdog
 *   sends it at its own minute (the seventh review's M2, the sixth's G3 by another way). The
 *   watchdog's step comes every hour anyway.
 * Each report replaces the day on the server, so sending one again is always safe.
 */
object DataUseUploads {
    /** The phone's local times today's so far is counted up to: noon and 6 PM. */
    val SO_FAR_AT: List<LocalTime> = listOf(LocalTime.NOON, LocalTime.of(18, 0))
    const val COMPLETE_AFTER_MS = 150L * 60 * 1000
    const val DAYS_BACK = 7L

    /** How many complete days are remembered as sent. */
    private const val KEEP_COMPLETE = 14

    /** What Belay remembers between steps. */
    @Serializable
    data class State(
        /** When this phone first saw measuring on; null while it's off. */
        val since: Long? = null,
        /** The latest time a day that wasn't complete was counted up to (one of [SO_FAR_AT], or when measuring began). */
        val lastAt: Long? = null,
        /** "YYYY-MM-DD zone" of the days sent complete, the last [KEEP_COMPLETE]. */
        val complete: List<String> = emptyList(),
    )

    data class Plan(
        /** To read and queue, oldest first. */
        val read: List<DataUse.Range>,
        val state: State,
    )

    /**
     * What to read at a step brought by [cause] at [now]. [force]: read today up to now (a debug
     * build's test hook), whatever the cause.
     */
    fun plan(measure: Boolean, state: State, zone: ZoneId, now: Long, cause: StepCause = StepCause.OTHER, force: Boolean = false): Plan {
        if (!measure) return Plan(emptyList(), State())
        // Only a time passing, or a call: nothing becomes due, and nothing is remembered.
        if (!cause.dueReads && !force) return Plan(emptyList(), state)
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        // Measuring just turned on, or the phone's clock went back past when it did: count from now.
        if (state.since == null || state.since > now) {
            val began = DataUse.Range(DataUse.dayOf(now, zone), zone.id, now, now, complete = false)
            return Plan(listOf(began), State(since = now, lastAt = now, complete = state.complete))
        }
        val since = state.since
        // The clock went back past the last report: as if none had been sent since.
        val lastAt = state.lastAt?.takeIf { it <= now }
        val complete = state.complete.toMutableList()
        var counted = lastAt
        val first = maxOf(since, now - DAYS_BACK * DAY_MS)
        val out = mutableListOf<DataUse.Range>()
        var day = Instant.ofEpochMilli(first).atZone(zone).toLocalDate()
        while (!day.isAfter(today)) {
            val start = DataUse.startOf(day, zone)
            val end = DataUse.startOf(day.plusDays(1), zone)
            val from = maxOf(start, since)
            val date = day
            day = day.plusDays(1)
            if (from >= end || from > now) continue
            val key = "${DataUse.dayOf(start, zone)} ${zone.id}"
            if (now >= end + COMPLETE_AFTER_MS) {
                if (key in complete) continue
                out += DataUse.Range(DataUse.dayOf(start, zone), zone.id, from, end, complete = true)
                complete += key
                continue
            }
            val to = if (force && date == today) now else soFarAt(date, zone, now)?.takeIf { it > from && (lastAt == null || it > lastAt) }
            if (to != null) {
                out += DataUse.Range(DataUse.dayOf(start, zone), zone.id, from, to, complete = false)
                counted = maxOf(counted ?: to, to)
            }
        }
        return Plan(out, State(since = since, lastAt = counted, complete = complete.takeLast(KEEP_COMPLETE)))
    }

    /** The last of [SO_FAR_AT] on [day] (by the phone's clock in [zone]) at or before [now]; null before noon. */
    fun soFarAt(day: LocalDate, zone: ZoneId, now: Long): Long? =
        SO_FAR_AT.map { day.atTime(it).atZone(zone).toInstant().toEpochMilli() }.filter { it <= now }.maxOrNull()

    private const val DAY_MS = 24L * 60 * 60 * 1000
}

/**
 * Phase 13's record on the phone (Room's `mobile_data` row, as JSON): the Wi-Fi-only list as Belay
 * last asked Android for it, the report, and the uploads' state. Written only by the agent thread.
 */
@Serializable
data class MobileDataState(
    val wifiOnly: WifiOnly.Applied = WifiOnly.Applied(),
    /** `enforcement.mobile_data`, as the last step read Android's list. */
    val report: WireMobileDataStatus? = null,
    val uploads: DataUseUploads.State = DataUseUploads.State(),
)
