package family.brooker.belay.core.network

import family.brooker.belay.core.Wire
import java.time.Instant
import java.time.ZoneId
import java.util.EnumMap

/**
 * One DNS lookup as Android logged it (DnsEvent): the app, as `PackageManager.getNameForUid` names
 * its uid (null for a uid without one, "name:uid" for a shared user id); the hostname as the app
 * asked for it; and when (the phone's clock).
 */
data class DnsLookup(val packageName: String?, val hostname: String?, val at: Long)

/** An app, and a domain it looked up. */
data class NetworkKey(val packageName: String, val domain: String)

/**
 * One local day of lookups as the phone keeps it (Room's network_days and network_counts) until
 * the day is over and sent: how many times each app looked up each domain, and nothing else.
 */
data class NetworkDay(
    /** "YYYY-MM-DD" in [zone]. */
    val day: String,
    /** The phone's zone when the day was last added to. */
    val zone: String,
    /** The newest lookup counted. */
    val asOf: Long,
    val counts: Map<NetworkKey, Int>,
    /** Entries that came after the day already held [NetworkDigest.MAX_KEPT]: not kept, counted in `dropped`. */
    val overflow: Int = 0,
)

/**
 * Network logging's arithmetic (Phase 3), pure: Android's DNS events reduced to lookups per app,
 * per domain, per local day, which is all that's kept and sent. The raw events (hostnames, IP
 * addresses, times) never reach storage or the outbox, and connect events (an IP and a port) are
 * never read. Never kept, whatever the policy says:
 * - lookups by the apps Belay never blocks (core's NeverBlocked: Belay, the phone app, the texting
 *   app, the keyboard, the home screen, Android's own packages…), so a call or text to 988 never
 *   shows, and by uids Android names "name:uid" (a shared user id: Android's own processes, Play
 *   services, the shell), where Belay can't tell which app it was;
 * - lookups of 988's websites and of the family's private ones, or of a name under one
 *   ([Domains.neverKept], checked against the whole name before it's reduced), counted together
 *   as [Skip.PRIVATE] for Belay's own log, which never names one; nothing sent counts them;
 * - IP addresses, reverse lookups and other names that aren't websites or online services ([Domains]).
 * A day keeps at most [MAX_KEPT] entries and sends the [MAX_SENT] most looked up (fewer if they'd
 * pass [MAX_DAY_BYTES]); the rest are counted in `dropped`. A day kept from before a website was
 * made private loses it at the next batch ([merge]), or at the next step ([without]).
 */
object NetworkDigest {
    /** The server takes at most this many entries a day. */
    const val MAX_SENT = NetworkWireLimits.MAX_ENTRIES

    /** Kept on the phone, so the day's most looked up are sent, not its first. */
    const val MAX_KEPT = 2 * MAX_SENT

    /** Today and the two days before: a batch Android finished late still finds its day. */
    const val KEEP_DAYS = 3L

    /** One day's JSON, at most: one day always fits in a request, well under the server's 512 KB. */
    const val MAX_DAY_BYTES = 400 * 1024

    /** A Java-style package name, as the server checks it (`packageName` in schemas.ts). */
    private val PACKAGE = Regex("^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$")
    private const val MAX_PACKAGE = 255

    /**
     * Why a lookup wasn't kept, for Belay's own log (counts only, never a name). [PRIVATE] is 988's
     * websites and the family's private ones together, so the log never says which it was.
     */
    enum class Skip { NO_APP, SHARED_UID, NEVER_BLOCKED, NOT_A_DOMAIN, PRIVATE, TOO_OLD }

    /** One batch, reduced: counts per day, the newest lookup of each, and what wasn't kept. */
    class Batch(
        val days: Map<String, Map<NetworkKey, Int>>,
        val newest: Map<String, Long>,
        val skipped: Map<Skip, Int>,
    ) {
        val kept: Int get() = days.values.sumOf { it.values.sum() }
    }

    /** The oldest day the phone keeps at [now]. */
    fun keepFrom(zone: ZoneId, now: Long): String = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().minusDays(KEEP_DAYS - 1).toString()

    /**
     * Reduces Android's lookups to counts. [never] is the apps Belay never blocks; [zone] the
     * phone's own zone, whose midnights end the days; [private] the family's private websites
     * ([Domains.privateSet]). A lookup stamped after [now] (the clock went back since) counts
     * today; one before the oldest day kept isn't kept. A lookup never kept moves nothing: not a
     * day's count, nor its newest time.
     */
    fun reduce(lookups: List<DnsLookup>, never: Set<String>, zone: ZoneId, now: Long, private: Set<String> = emptySet()): Batch {
        val oldest = keepFrom(zone, now)
        val days = HashMap<String, HashMap<NetworkKey, Int>>()
        val newest = HashMap<String, Long>()
        val skipped = EnumMap<Skip, Int>(Skip::class.java)
        val skip = { why: Skip ->
            skipped.merge(why, 1, Int::plus)
            Unit
        }
        for (lookup in lookups) {
            val key = keyOf(lookup, never, private, skip) ?: continue
            val at = minOf(lookup.at, now)
            val day = Instant.ofEpochMilli(at).atZone(zone).toLocalDate().toString()
            if (day < oldest) {
                skip(Skip.TOO_OLD)
                continue
            }
            days.getOrPut(day) { HashMap() }.merge(key, 1) { a, b -> minOf(a + b, NetworkWireLimits.MAX_COUNT) }
            newest.merge(day, at, ::maxOf)
        }
        return Batch(days, newest, skipped)
    }

    /** The app and domain a lookup counts for, or null (and why, to [skip]) when it's never kept. */
    private fun keyOf(lookup: DnsLookup, never: Set<String>, private: Set<String>, skip: (Skip) -> Unit): NetworkKey? {
        val name = lookup.packageName
        val why = when {
            name == null -> Skip.NO_APP
            ':' in name -> Skip.SHARED_UID
            name.length > MAX_PACKAGE || !PACKAGE.matches(name) -> Skip.NO_APP
            name in never -> Skip.NEVER_BLOCKED
            else -> null
        }
        if (why != null || name == null) {
            skip(why ?: Skip.NO_APP)
            return null
        }
        val host = Domains.hostname(lookup.hostname)
        if (host == null) {
            skip(Skip.NOT_A_DOMAIN)
            return null
        }
        // The whole name, before it's reduced: a private "help.example.org" never counts as "example.org".
        if (Domains.neverKept(host, private)) {
            skip(Skip.PRIVATE)
            return null
        }
        return NetworkKey(name, Domains.registrable(host))
    }

    /**
     * Adds a [batch] to the days the phone keeps ([stored], by day). Returns the days it changed,
     * oldest first, each with everything counted so far, as they're to be kept and sent again,
     * without what was counted of the family's [private] websites before they were private.
     */
    fun merge(stored: Map<String, NetworkDay>, batch: Batch, zone: ZoneId, private: Set<String> = emptySet()): List<NetworkDay> =
        batch.days.keys.sorted().map { day ->
            val base = stored[day]?.let { without(it, private) ?: it }
            val counts = HashMap(base?.counts.orEmpty())
            var overflow = base?.overflow ?: 0
            for ((key, n) in batch.days.getValue(day)) {
                val had = counts[key]
                when {
                    had != null -> counts[key] = minOf(had.toLong() + n, NetworkWireLimits.MAX_COUNT.toLong()).toInt()
                    counts.size < MAX_KEPT -> counts[key] = minOf(n, NetworkWireLimits.MAX_COUNT)
                    else -> overflow = minOf(overflow + 1, NetworkWireLimits.MAX_COUNT)
                }
            }
            NetworkDay(day, zone.id, maxOf(base?.asOf ?: 0, batch.newest[day] ?: 0), counts, overflow)
        }

    /**
     * A day the phone keeps, without the entries of the family's [private] websites (or 988's): what
     * it counted of them before they were private. Null when it has none, so nothing changes. Its
     * `asOf` stays, though the newest lookup counted may have been one of them: a time, from before
     * the website was private, and never a count.
     */
    fun without(day: NetworkDay, private: Set<String>): NetworkDay? {
        val kept = day.counts.filterKeys { !Domains.neverKept(it.domain, private) }
        return if (kept.size == day.counts.size) null else day.copy(counts = kept)
    }

    /**
     * The day as `POST /api/v1/network` sends it: its entries most looked up first (then by app and
     * domain, so the same day always gives the same list), at most [MAX_SENT] and [MAX_DAY_BYTES];
     * `dropped` counts the rest, and the entries never kept.
     */
    fun wire(day: NetworkDay): WireNetworkDay {
        val sorted = day.counts.entries.sortedWith(
            compareByDescending<Map.Entry<NetworkKey, Int>> { it.value }.thenBy { it.key.packageName }.thenBy { it.key.domain },
        )
        var bytes = Wire.json.encodeToString(
            WireNetworkDay.serializer(),
            WireNetworkDay(day.day, day.zone, day.asOf, emptyList(), NetworkWireLimits.MAX_COUNT),
        ).length.toLong()
        val entries = ArrayList<WireNetworkEntry>(minOf(sorted.size, MAX_SENT))
        for ((key, lookups) in sorted) {
            if (entries.size >= MAX_SENT) break
            val entry = WireNetworkEntry(key.packageName, key.domain, lookups)
            // Package names and domains are ASCII: a character is a byte.
            val size = Wire.json.encodeToString(WireNetworkEntry.serializer(), entry).length + if (entries.isEmpty()) 0 else 1
            if (bytes + size > MAX_DAY_BYTES) break
            bytes += size
            entries += entry
        }
        val dropped = minOf((sorted.size - entries.size).toLong() + day.overflow, NetworkWireLimits.MAX_COUNT.toLong()).toInt()
        return WireNetworkDay(day.day, day.zone, day.asOf, entries, dropped)
    }
}
