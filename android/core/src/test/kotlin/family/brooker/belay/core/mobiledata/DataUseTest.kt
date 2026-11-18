package family.brooker.belay.core.mobiledata

import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireEnforcement
import family.brooker.belay.core.mobiledata.DataUse.Owner
import family.brooker.belay.core.mobiledata.DataUse.Row
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Phase 13's mobile data use on the phone: Android's rows folded into a day (apps most first, the
 * never-blocked apps and Android's own together, removed apps and the hotspot apart), which days
 * are read and sent when, and the protocol's names. Made-up apps only.
 */
class DataUseTest {
    private val zone = ZoneId.of("America/New_York")
    private val day = LocalDate.of(2026, 11, 16)
    private val start = DataUse.startOf(day, zone)
    private val end = DataUse.startOf(day.plusDays(1), zone)
    private val range = DataUse.Range("2026-11-16", zone.id, start, start + 10 * HOUR, complete = false)
    private val unlisted = setOf("com.example.texts", "com.example.dialer")

    @Test
    fun `apps most first, with the never-blocked apps, shared uids and Android's own in one line`() {
        val rows = listOf(
            Row(Owner.App("com.example.video"), 300_000_000),
            // Several rows for one uid (states, roaming): added up.
            Row(Owner.App("com.example.video"), 50_000_000),
            Row(Owner.App("com.example.maps"), 20_000_000),
            Row(Owner.App("com.example.texts"), 4_000_000),
            Row(Owner.App("com.example.dialer"), 1_000_000),
            Row(Owner.Android, 7_000_000),
            Row(Owner.Removed, 2_000_000),
            Row(Owner.Hotspot, 9_000_000),
            Row(Owner.App("com.example.idle"), 0),
        )
        val sent = DataUse.day(range, rows, wifiBytes = 2_100_000_000, unlisted = unlisted)
        assertEquals(listOf(WireMobileDataApp("com.example.video", 350_000_000), WireMobileDataApp("com.example.maps", 20_000_000)), sent.apps)
        assertEquals(12_000_000, sent.androidBytes, "texting, the dialer and Android's own, together: a text to 988 never shows")
        assertEquals(2_000_000, sent.removedBytes)
        assertEquals(9_000_000, sent.hotspotBytes)
        assertEquals(393_000_000, sent.mobileBytes, "everything adds up to the total")
        assertEquals(2_100_000_000, sent.wifiBytes)
        assertEquals(range.from, sent.from)
        assertEquals(range.to, sent.asOf)
        assertFalse(sent.complete)
    }

    @Test
    fun `at most 500 apps, the rest only in the total`() {
        val rows = (1..600).map { Row(Owner.App("com.example.app$it"), it.toLong()) }
        val sent = DataUse.day(range, rows, 0, emptySet())
        assertEquals(500, sent.apps.size)
        assertEquals("com.example.app600", sent.apps.first().packageName)
        assertEquals(101L, sent.apps.last().bytes)
        assertEquals((1L..600L).sum(), sent.mobileBytes)
        // Ties are in package order, so the same rows always give the same day.
        val tie = DataUse.day(range, listOf(Row(Owner.App("com.example.b"), 5), Row(Owner.App("com.example.a"), 5)), 0, emptySet())
        assertEquals(listOf("com.example.a", "com.example.b"), tie.apps.map { it.packageName })
    }

    @Test
    fun `bytes are never negative and never past what the server takes`() {
        val sent = DataUse.day(range, listOf(Row(Owner.App("com.example.video"), -5), Row(Owner.Android, Long.MAX_VALUE), Row(Owner.Removed, Long.MAX_VALUE)), -1, emptySet())
        assertEquals(emptyList(), sent.apps)
        assertEquals(MobileDataWireLimits.MAX_BYTES, sent.androidBytes)
        assertEquals(MobileDataWireLimits.MAX_BYTES, sent.mobileBytes)
        assertEquals(0, sent.wifiBytes)
    }

    @Test
    fun `nothing is read or kept while measuring is off`() {
        val plan = DataUseUploads.plan(measure = false, DataUseUploads.State(since = start, lastAt = start, complete = listOf("x")), zone, start + HOUR)
        assertEquals(emptyList(), plan.read)
        assertEquals(DataUseUploads.State(), plan.state)
    }

    @Test
    fun `the first report counts only from when measuring turned on, and goes at once`() {
        val on = start + 15 * HOUR
        val plan = DataUseUploads.plan(true, DataUseUploads.State(), zone, now = on + MINUTE)
        assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, on + MINUTE, on + MINUTE, complete = false)), plan.read)
        assertEquals(on + MINUTE, plan.state.since)
        assertEquals(on + MINUTE, plan.state.lastAt)
    }

    @Test
    fun `today goes about hourly`() {
        val since = start + HOUR
        val sent = DataUseUploads.State(since = since, lastAt = start + 2 * HOUR)
        assertEquals(emptyList(), DataUseUploads.plan(true, sent, zone, start + 2 * HOUR + 59 * MINUTE).read, "not yet")
        val due = DataUseUploads.plan(true, sent, zone, start + 3 * HOUR)
        assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, since, start + 3 * HOUR, complete = false)), due.read)
        assertEquals(start + 3 * HOUR, due.state.lastAt)
        // A debug build's hook reads today now.
        assertEquals(1, DataUseUploads.plan(true, sent, zone, start + 2 * HOUR + 5 * MINUTE, force = true).read.size)
        // The clock went back past the last report: due again.
        assertEquals(1, DataUseUploads.plan(true, sent, zone, start + 90 * MINUTE).read.size)
    }

    @Test
    fun `a day goes once more when it's complete, 2_5 hours after its end, and only once`() {
        val since = start + HOUR
        val state = DataUseUploads.State(since = since, lastAt = end - 10 * MINUTE)
        // Just after midnight: yesterday isn't complete yet; it goes again with today, hourly.
        val early = DataUseUploads.plan(true, state, zone, end + 2 * HOUR)
        assertEquals(listOf(false, false), early.read.map { it.complete })
        assertEquals(listOf("2026-11-16", "2026-11-17"), early.read.map { it.day })
        assertEquals(end, early.read.first().to, "counted to the day's end")
        // 2.5 hours after: complete, counted to its end.
        val done = DataUseUploads.plan(true, early.state, zone, end + 150 * MINUTE)
        assertEquals(DataUse.Range("2026-11-16", zone.id, since, end, complete = true), done.read.single())
        assertEquals(listOf("2026-11-16 America/New_York"), done.state.complete)
        // Never again.
        val later = DataUseUploads.plan(true, done.state, zone, end + 4 * HOUR)
        assertTrue(later.read.none { it.day == "2026-11-16" })
    }

    @Test
    fun `a phone off for a fortnight sends at most the last week, never before measuring began`() {
        val since = start - 20 * DAY
        val now = start + 12 * HOUR
        val plan = DataUseUploads.plan(true, DataUseUploads.State(since = since, lastAt = since + HOUR), zone, now)
        assertEquals(8, plan.read.size)
        assertEquals("2026-11-09", plan.read.first().day)
        assertTrue(plan.read.dropLast(1).all { it.complete })
        assertTrue(plan.read.all { it.from >= since })
        // Measuring turned on this morning: nothing from before it, though Android keeps 90 days.
        val today = DataUseUploads.plan(true, DataUseUploads.State(since = start + 6 * HOUR, lastAt = start + 6 * HOUR), zone, now)
        assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, start + 6 * HOUR, now, complete = false)), today.read)
        // The days remembered as sent are the newest 14.
        assertTrue(plan.state.complete.size <= 14)
    }

    @Test
    fun `a day with a clock change is 23 or 25 hours, as the zone says`() {
        val fallBack = LocalDate.of(2026, 11, 1)
        val since = DataUse.startOf(fallBack, zone)
        val after = DataUse.startOf(fallBack.plusDays(1), zone)
        assertEquals(25 * HOUR, after - since)
        val plan = DataUseUploads.plan(true, DataUseUploads.State(since = since, lastAt = since), zone, after + 3 * HOUR)
        assertEquals(DataUse.Range("2026-11-01", zone.id, since, after, complete = true), plan.read.first())
    }

    @Test
    fun `the protocol's names, and a policy from before Phase 13 still reads`() {
        val json = Json.parseToJsonElement(
            Wire.json.encodeToString(
                WireMobileDataDay.serializer(),
                DataUse.day(range, listOf(Row(Owner.App("com.example.video"), 5)), 7, emptySet()),
            ),
        ).jsonObject
        assertEquals(
            setOf("day", "zone", "from", "as_of", "complete", "mobile_bytes", "wifi_bytes", "apps", "android_bytes", "removed_bytes", "hotspot_bytes"),
            json.keys,
        )
        assertEquals(setOf("package", "bytes"), (json.getValue("apps") as kotlinx.serialization.json.JsonArray).first().jsonObject.keys)
        // An older server sends no mobile_data: nothing is Wi-Fi only, nothing measured.
        val old = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":3}}""").policy
        assertEquals(WireMobileData(), old.mobileData)
        val new = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":4,"mobile_data":{"wifi_only":["com.example.video"],"measure":true}}}""").policy
        assertEquals(WireMobileData(listOf("com.example.video"), measure = true), new.mobileData)
        // The report: left out while null, and named as the server's schema names it.
        val report = Json.parseToJsonElement(Wire.json.encodeToString(WireEnforcement.serializer(), WireEnforcement(policyVersion = 4, mobileData = WireMobileDataStatus(listOf("com.example.video"))))).jsonObject
        assertEquals("""{"wifi_only":["com.example.video"]}""", report.getValue("mobile_data").toString())
        val none = Json.parseToJsonElement(Wire.json.encodeToString(WireEnforcement.serializer(), WireEnforcement(policyVersion = 4))) as JsonObject
        assertFalse("mobile_data" in none)
    }

    private companion object {
        const val MINUTE = 60_000L
        const val HOUR = 60 * MINUTE
        const val DAY = 24 * HOUR
    }
}
