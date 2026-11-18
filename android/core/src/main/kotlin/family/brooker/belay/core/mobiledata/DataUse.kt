package family.brooker.belay.core.mobiledata

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Phase 13's mobile data use (data category `mobile_data`), folded into days for
 * `POST /api/v1/mobile-data`. :app reads Android's accounting (NetworkStatsManager, platform notes
 * Q6 to Q8) and names each uid's [Owner]; this puts it together:
 * - each app with its bytes, most first, at most 500;
 * - never an app Belay never blocks (the phone app, texting, the keyboard…) by itself: those go
 *   with Android's own uids and shared uids into one line, "Android, calls and texting", so the
 *   total stays right and a call or a text to 988 never shows;
 * - removed apps, and what other devices used through the phone's own hotspot, apart;
 * - the day's total, the sum of all of it (apps past the 500 are only in it).
 * Never which websites, which networks, or anything inside the traffic: Android doesn't say, and
 * Belay never asks.
 */
object DataUse {
    /** Whose a row of Android's accounting is, as :app names its uid. */
    sealed interface Owner {
        /** One app (an SDK sandbox's bytes count as its app's). */
        data class App(val packageName: String) : Owner

        /** Several packages at once (a shared uid), Android's own uids, other users' and uids with no package. */
        data object Android : Owner

        /** Apps removed since: Android moved their use there (UID_REMOVED). */
        data object Removed : Owner

        /** Other devices, through this phone's own hotspot (UID_TETHERING). */
        data object Hotspot : Owner
    }

    /** Received and sent bytes of one bucket Android returned. */
    data class Row(val owner: Owner, val bytes: Long)

    /** One local day to read, from [from] to [to] (ms), in [zone]. */
    data class Range(val day: String, val zone: String, val from: Long, val to: Long, val complete: Boolean)

    /**
     * One day as the phone sends it. [mobile] are Android's per-uid rows for the range on mobile
     * data, [wifiBytes] its total on Wi-Fi, [unlisted] the packages Belay never blocks
     * (NeverBlocked.of's keys): never listed by themselves.
     */
    fun day(range: Range, mobile: List<Row>, wifiBytes: Long, unlisted: Set<String>): WireMobileDataDay {
        val apps = HashMap<String, Long>()
        var android = 0L
        var removed = 0L
        var hotspot = 0L
        for (row in mobile) {
            val bytes = clamp(row.bytes)
            if (bytes == 0L) continue
            when (val owner = row.owner) {
                is Owner.App -> if (owner.packageName in unlisted) {
                    android = add(android, bytes)
                } else {
                    apps[owner.packageName] = add(apps[owner.packageName] ?: 0, bytes)
                }
                Owner.Android -> android = add(android, bytes)
                Owner.Removed -> removed = add(removed, bytes)
                Owner.Hotspot -> hotspot = add(hotspot, bytes)
            }
        }
        val sorted = apps.entries.sortedWith(compareByDescending<Map.Entry<String, Long>> { it.value }.thenBy { it.key })
        val total = sorted.fold(add(add(android, removed), hotspot)) { sum, e -> add(sum, e.value) }
        return WireMobileDataDay(
            day = range.day,
            zone = range.zone,
            from = range.from,
            asOf = range.to,
            complete = range.complete,
            mobileBytes = total,
            wifiBytes = clamp(wifiBytes),
            apps = sorted.take(MobileDataWireLimits.MAX_APPS).map { WireMobileDataApp(it.key, it.value) },
            androidBytes = android,
            removedBytes = removed,
            hotspotBytes = hotspot,
        )
    }

    /** "YYYY-MM-DD" of [at] in [zone]. */
    fun dayOf(at: Long, zone: ZoneId): String = Instant.ofEpochMilli(at).atZone(zone).toLocalDate().toString()

    /** When [day] starts in [zone] (a DST change makes a day 23 or 25 hours long). */
    fun startOf(day: LocalDate, zone: ZoneId): Long = day.atStartOfDay(zone).toInstant().toEpochMilli()

    private fun clamp(bytes: Long): Long = bytes.coerceIn(0, MobileDataWireLimits.MAX_BYTES)

    private fun add(a: Long, b: Long): Long = clamp(if (Long.MAX_VALUE - a < b) Long.MAX_VALUE else a + b)
}
