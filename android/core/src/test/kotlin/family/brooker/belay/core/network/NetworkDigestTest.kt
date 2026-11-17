package family.brooker.belay.core.network

import family.brooker.belay.core.Wire
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Android's DNS lookups to counts per app, per domain, per local day. Made-up apps and names only. */
class NetworkDigestTest {
    private val zone = ZoneId.of("America/Los_Angeles")

    /** 2026-11-17 in Los Angeles, at [hour]:[minute]. */
    private fun at(hour: Int, minute: Int = 0, day: Int = 17) = ZonedDateTime.of(2026, 11, day, hour, minute, 0, 0, zone).toInstant().toEpochMilli()

    private val now = at(15)
    private val chat = "com.example.chat"
    private val game = "com.example.blocks"
    private val dialer = "com.example.dialer"
    private val never = setOf(dialer, "family.brooker.belay")

    private fun lookup(pkg: String?, host: String?, time: Long = at(9)) = DnsLookup(pkg, host, time)

    @Test
    fun `lookups count per app, per registrable domain, per day`() {
        val batch = NetworkDigest.reduce(
            listOf(
                lookup(chat, "chat-7.cdn.example.com"),
                lookup(chat, "EXAMPLE.com.", at(10)),
                lookup(chat, "media.example.net"),
                lookup(game, "api.example.com", at(11)),
            ),
            never, zone, now,
        )
        assertEquals(setOf("2026-11-17"), batch.days.keys)
        assertEquals(
            mapOf(NetworkKey(chat, "example.com") to 2, NetworkKey(chat, "example.net") to 1, NetworkKey(game, "example.com") to 1),
            batch.days.getValue("2026-11-17"),
        )
        assertEquals(at(11), batch.newest.getValue("2026-11-17"))
        assertEquals(4, batch.kept)
        assertTrue(batch.skipped.isEmpty())
    }

    @Test
    fun `days end at midnight in the phone's zone`() {
        val batch = NetworkDigest.reduce(
            listOf(lookup(chat, "example.com", at(23, 59, day = 16)), lookup(chat, "example.com", at(0, 1))),
            never, zone, now,
        )
        assertEquals(mapOf(NetworkKey(chat, "example.com") to 1), batch.days.getValue("2026-11-16"))
        assertEquals(mapOf(NetworkKey(chat, "example.com") to 1), batch.days.getValue("2026-11-17"))
        // The same moments in UTC are one day: 07:59 and 08:01 on the 17th.
        val utc = NetworkDigest.reduce(listOf(lookup(chat, "example.com", at(23, 59, day = 16)), lookup(chat, "example.com", at(0, 1))), never, ZoneId.of("UTC"), now)
        assertEquals(mapOf("2026-11-17" to mapOf(NetworkKey(chat, "example.com") to 2)), utc.days)
    }

    @Test
    fun `never-blocked apps, shared user ids, uids without an app, 988 and what isn't a name are never kept`() {
        val batch = NetworkDigest.reduce(
            listOf(
                lookup(dialer, "example.com"),
                lookup("family.brooker.belay", "belay.example.org"),
                lookup("android.uid.system:1000", "example.com"),
                lookup("android.uid.shell:2000", "example.com"),
                lookup(null, "example.com"),
                lookup("not a package", "example.com"),
                lookup(chat, "988lifeline.org"),
                lookup(chat, "chat.988lifeline.org"),
                lookup(chat, "988.ca"),
                lookup(chat, "192.0.2.10"),
                lookup(chat, "10.2.0.192.in-addr.arpa"),
                lookup(chat, "null"),
                lookup(chat, null),
                lookup(chat, "example.com"),
            ),
            never, zone, now,
        )
        assertEquals(mapOf("2026-11-17" to mapOf(NetworkKey(chat, "example.com") to 1)), batch.days)
        assertEquals(
            mapOf(
                NetworkDigest.Skip.NEVER_BLOCKED to 2,
                NetworkDigest.Skip.SHARED_UID to 2,
                NetworkDigest.Skip.NO_APP to 2,
                NetworkDigest.Skip.CRISIS_988 to 3,
                NetworkDigest.Skip.NOT_A_DOMAIN to 4,
            ),
            batch.skipped,
        )
    }

    @Test
    fun `a lookup after now counts today, and one before the days kept isn't kept`() {
        val batch = NetworkDigest.reduce(
            listOf(lookup(chat, "example.com", at(9, day = 18)), lookup(chat, "example.com", at(9, day = 15)), lookup(chat, "example.com", at(9, day = 14))),
            never, zone, now,
        )
        assertEquals(setOf("2026-11-15", "2026-11-17"), batch.days.keys)
        assertEquals(now, batch.newest.getValue("2026-11-17"))
        assertEquals(mapOf(NetworkDigest.Skip.TOO_OLD to 1), batch.skipped)
        assertEquals("2026-11-15", NetworkDigest.keepFrom(zone, now))
    }

    @Test
    fun `a batch adds to the day kept, and only the days it touched change`() {
        val stored = mapOf(
            "2026-11-17" to NetworkDay("2026-11-17", "America/Los_Angeles", at(8), mapOf(NetworkKey(chat, "example.com") to 5)),
            "2026-11-16" to NetworkDay("2026-11-16", "America/Los_Angeles", at(22, day = 16), mapOf(NetworkKey(game, "example.org") to 2)),
        )
        val batch = NetworkDigest.reduce(listOf(lookup(chat, "example.com"), lookup(game, "example.net", at(10))), never, zone, now)
        val merged = NetworkDigest.merge(stored, batch, zone)
        assertEquals(listOf("2026-11-17"), merged.map { it.day })
        assertEquals(mapOf(NetworkKey(chat, "example.com") to 6, NetworkKey(game, "example.net") to 1), merged.single().counts)
        assertEquals(at(10), merged.single().asOf)
        // A new day starts from nothing, in the zone the phone has now.
        val tokyo = NetworkDigest.merge(emptyMap(), batch, ZoneId.of("Asia/Tokyo")).single()
        assertEquals("Asia/Tokyo", tokyo.zone)
        assertEquals(2, tokyo.counts.size)
    }

    @Test
    fun `a day keeps at most 10000 entries, and counts the ones that came after`() {
        val full = (0 until NetworkDigest.MAX_KEPT).associate { NetworkKey(chat, "site$it.example") to 1 }
        val stored = mapOf("2026-11-17" to NetworkDay("2026-11-17", zone.id, at(8), full))
        val batch = NetworkDigest.reduce(listOf(lookup(chat, "site0.example"), lookup(chat, "new1.example"), lookup(game, "new2.example")), never, zone, now)
        val merged = NetworkDigest.merge(stored, batch, zone).single()
        assertEquals(NetworkDigest.MAX_KEPT, merged.counts.size)
        assertEquals(2, merged.counts.getValue(NetworkKey(chat, "site0.example")))
        assertEquals(2, merged.overflow)
    }

    @Test
    fun `the day sent has its 5000 most looked up, and dropped counts the rest`() {
        val counts = (0 until 6000).associate { NetworkKey(if (it % 2 == 0) chat else game, "site$it.example") to it + 1 }
        val day = NetworkDay("2026-11-17", zone.id, at(14), counts, overflow = 3)
        val wire = NetworkDigest.wire(day)
        assertEquals(NetworkDigest.MAX_SENT, wire.entries.size)
        assertEquals(6000, wire.entries.first().lookups)
        assertEquals(1001, wire.entries.last().lookups)
        assertEquals(1000 + 3, wire.dropped)
        assertEquals(listOf("2026-11-17", "America/Los_Angeles", at(14).toString()), listOf(wire.day, wire.zone, wire.asOf.toString()))
        assertTrue(Wire.json.encodeToString(WireNetworkDay.serializer(), wire).length <= NetworkDigest.MAX_DAY_BYTES)
    }

    @Test
    fun `the same lookups always give the same list, most looked up first`() {
        val counts = mapOf(NetworkKey(game, "example.org") to 2, NetworkKey(chat, "example.net") to 2, NetworkKey(chat, "example.com") to 7)
        val wire = NetworkDigest.wire(NetworkDay("2026-11-17", zone.id, at(14), counts))
        // A tie goes by app, then domain: com.example.blocks before com.example.chat.
        assertEquals(listOf(WireNetworkEntry(chat, "example.com", 7), WireNetworkEntry(game, "example.org", 2), WireNetworkEntry(chat, "example.net", 2)), wire.entries)
        assertEquals(0, wire.dropped)
    }

    @Test
    fun `a day that would pass 400 KB sends fewer entries, and counts the rest as dropped`() {
        // Long, valid names: 4000 entries of about 300 bytes each.
        val longPkg = "com.example." + "a".repeat(200)
        val counts = (0 until 4000).associate { NetworkKey(longPkg, "${"b".repeat(50)}$it.example") to 1 }
        val wire = NetworkDigest.wire(NetworkDay("2026-11-17", zone.id, at(14), counts))
        assertTrue(wire.entries.size < 4000)
        assertEquals(4000 - wire.entries.size, wire.dropped)
        assertTrue(Wire.json.encodeToString(WireNetworkDay.serializer(), wire).length <= NetworkDigest.MAX_DAY_BYTES)
    }

    @Test
    fun `counts stop at a million`() {
        val stored = mapOf("2026-11-17" to NetworkDay("2026-11-17", zone.id, at(8), mapOf(NetworkKey(chat, "example.com") to NetworkWireLimits.MAX_COUNT)))
        val merged = NetworkDigest.merge(stored, NetworkDigest.reduce(listOf(lookup(chat, "example.com")), never, zone, now), zone).single()
        assertEquals(NetworkWireLimits.MAX_COUNT, merged.counts.getValue(NetworkKey(chat, "example.com")))
    }
}
