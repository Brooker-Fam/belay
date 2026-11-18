package family.brooker.belay.core.mobiledata

import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.StepCause
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
    fun `today so far goes at noon and at 6 PM, once each, counted up to them whenever it's read`() {
        val since = start + HOUR
        val sent = DataUseUploads.State(since = since, lastAt = since)
        assertEquals(emptyList(), DataUseUploads.plan(true, sent, zone, start + 11 * HOUR + 59 * MINUTE).read, "not before noon")
        val noon = start + 12 * HOUR
        for (at in listOf(noon, noon + 7 * MINUTE, noon + 5 * HOUR + 59 * MINUTE)) {
            assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, since, noon, complete = false)), DataUseUploads.plan(true, sent, zone, at).read, "at $at")
        }
        val atNoon = DataUseUploads.plan(true, sent, zone, noon + 7 * MINUTE)
        assertEquals(noon, atNoon.state.lastAt)
        assertEquals(emptyList(), DataUseUploads.plan(true, atNoon.state, zone, noon + 5 * HOUR).read, "once")
        val six = start + 18 * HOUR
        val atSix = DataUseUploads.plan(true, atNoon.state, zone, six + 40 * MINUTE)
        assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, since, six, complete = false)), atSix.read)
        assertEquals(emptyList(), DataUseUploads.plan(true, atSix.state, zone, end - MINUTE).read, "not again that day")
        // Missed noon (off, or offline): 6 PM's only.
        assertEquals(listOf(six), DataUseUploads.plan(true, sent, zone, six + HOUR).read.map { it.to })
        // A debug build's hook reads today up to now.
        assertEquals(listOf(noon + 20 * MINUTE), DataUseUploads.plan(true, atNoon.state, zone, noon + 20 * MINUTE, force = true).read.map { it.to })
        // The clock went back past the last report: the last of noon and 6 PM before now, again.
        assertEquals(listOf(noon), DataUseUploads.plan(true, atSix.state, zone, noon + HOUR).read.map { it.to })
        // Measuring that began after noon starts at 6 PM.
        val afternoon = DataUseUploads.State(since = noon + 2 * HOUR, lastAt = noon + 2 * HOUR)
        assertEquals(emptyList(), DataUseUploads.plan(true, afternoon, zone, noon + 3 * HOUR).read)
        assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, noon + 2 * HOUR, six, complete = false)), DataUseUploads.plan(true, afternoon, zone, six).read)
    }

    @Test
    fun `only a step neither a time passing nor a call brought reads, and the others remember nothing`() {
        val since = start + HOUR
        val sent = DataUseUploads.State(since = since, lastAt = since)
        val noon = start + 12 * HOUR + MINUTE
        for (cause in listOf(StepCause.TIME, StepCause.CALL)) {
            assertEquals(DataUseUploads.Plan(emptyList(), sent), DataUseUploads.plan(true, sent, zone, noon, cause), "$cause")
            // Nor the day once it's complete, nor measuring's start.
            assertEquals(emptyList(), DataUseUploads.plan(true, sent, zone, end + 3 * HOUR, cause).read, "$cause")
            assertEquals(DataUseUploads.Plan(emptyList(), DataUseUploads.State()), DataUseUploads.plan(true, DataUseUploads.State(), zone, noon, cause))
            // A debug build's hook reads anyway.
            assertEquals(1, DataUseUploads.plan(true, sent, zone, noon, cause, force = true).read.size)
        }
        assertEquals(1, DataUseUploads.plan(true, sent, zone, noon, StepCause.OTHER).read.size)
        // Measuring off forgets everything, whatever brought the step.
        assertEquals(DataUseUploads.State(), DataUseUploads.plan(false, sent, zone, noon, StepCause.TIME).state)
    }

    @Test
    fun `a day goes once more when it's complete, 2_5 hours after its end, and only once`() {
        val since = start + HOUR
        val state = DataUseUploads.State(since = since, lastAt = start + 18 * HOUR)
        // Just after midnight: yesterday isn't complete yet, and today has no noon yet.
        val early = DataUseUploads.plan(true, state, zone, end + 2 * HOUR)
        assertEquals(emptyList(), early.read)
        // A phone that missed yesterday's 6 PM sends yesterday up to it now.
        val missed = DataUseUploads.plan(true, DataUseUploads.State(since = since, lastAt = start + 12 * HOUR), zone, end + 2 * HOUR)
        assertEquals(listOf(DataUse.Range("2026-11-16", zone.id, since, start + 18 * HOUR, complete = false)), missed.read)
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
