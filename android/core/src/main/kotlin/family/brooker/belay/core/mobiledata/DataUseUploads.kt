package family.brooker.belay.core.mobiledata

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId

/**
 * Which days of mobile data use the phone reads and sends (`POST /api/v1/mobile-data`, through the
 * outbox): only while the policy's `mobile_data.measure` is on (collection is a parent's
 * decision), and only from when it turned on: Android keeps 90 days of history (platform notes
 * Q7), and nothing from before the kid's screen said so is sent.
 * - Today, about every [EVERY_MS] (Android's own numbers move every 30 minutes).
 * - Each day once more when it's complete: [COMPLETE_AFTER_MS] after its end, when Android's last
 *   2-hour bucket for it has closed and been polled, with everything counted to its end.
 * - At most [DAYS_BACK] days back: a phone that was off or offline longer sends the last week.
 * Each report replaces the day on the server, so sending one again is always safe.
 */
object DataUseUploads {
    const val EVERY_MS = 60L * 60 * 1000
    const val COMPLETE_AFTER_MS = 150L * 60 * 1000
    const val DAYS_BACK = 7L

    /** How many complete days are remembered as sent. */
    private const val KEEP_COMPLETE = 14

    /** What Belay remembers between steps. */
    @Serializable
    data class State(
        /** When this phone first saw measuring on; null while it's off. */
        val since: Long? = null,
        /** When a day that wasn't complete was last read. */
        val lastAt: Long? = null,
        /** "YYYY-MM-DD zone" of the days sent complete, the last [KEEP_COMPLETE]. */
        val complete: List<String> = emptyList(),
    )

    data class Plan(
        /** To read and queue, oldest first. */
        val read: List<DataUse.Range>,
        val state: State,
    )

    /** [force]: read today now (a debug build's test hook). */
    fun plan(measure: Boolean, state: State, zone: ZoneId, now: Long, force: Boolean = false): Plan {
        if (!measure) return Plan(emptyList(), State())
        // The phone's clock went back past when measuring started: count from now.
        val since = state.since?.takeIf { it <= now } ?: now
        val complete = state.complete.toMutableList()
        val due = force || state.lastAt == null || now < state.lastAt || now - state.lastAt >= EVERY_MS
        var lastAt = state.lastAt
        val first = maxOf(since, now - DAYS_BACK * DAY_MS)
        val out = mutableListOf<DataUse.Range>()
        var day = Instant.ofEpochMilli(first).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        while (!day.isAfter(today)) {
            val start = DataUse.startOf(day, zone)
            val end = DataUse.startOf(day.plusDays(1), zone)
            val from = maxOf(start, since)
            day = day.plusDays(1)
            if (from >= end || from > now) continue
            val key = "${DataUse.dayOf(start, zone)} ${zone.id}"
            if (now >= end + COMPLETE_AFTER_MS) {
                if (key in complete) continue
                out += DataUse.Range(DataUse.dayOf(start, zone), zone.id, from, end, complete = true)
                complete += key
            } else if (due) {
                out += DataUse.Range(DataUse.dayOf(start, zone), zone.id, from, minOf(now, end), complete = false)
                lastAt = now
            }
        }
        return Plan(out, State(since = since, lastAt = lastAt, complete = complete.takeLast(KEEP_COMPLETE)))
    }

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
