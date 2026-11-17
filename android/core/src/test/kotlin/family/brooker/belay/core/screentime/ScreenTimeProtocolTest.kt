package family.brooker.belay.core.screentime

import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.RequestsRequest
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.core.WireEnforcement
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequest
import family.brooker.belay.core.WireRequestAnswer
import family.brooker.belay.core.WireRequestStatus
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.time.DayOfWeek
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ScreenTimeProtocolTest {
    private fun obj(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun <T> roundTrip(serializer: KSerializer<T>, value: T) {
        val json = Wire.json.encodeToString(serializer, value)
        assertEquals(value, Wire.json.decodeFromString(serializer, json), json)
    }

    private val screenTime = WireScreenTime(
        measure = true,
        zone = "America/New_York",
        dayStarts = "04:00",
        limits = listOf(
            WireLimit("l-games", "Games", listOf("com.example.blocks", "com.example.racer"), 60, WireByDay(sat = 120, sun = 120)),
            WireLimit("l-total", "Phone", listOf(WireLimit.EVERY_APP), 180),
        ),
        schedules = listOf(
            WireSchedule(
                "s-school", WireScheduleKind.SCHOOL, "School", WireDay.entries.take(5), "08:00", "15:00",
                allow = listOf("com.example.calculator"), skip = listOf("2026-11-26"),
            ),
            WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", WireDay.entries, "21:00", "07:00", lock = true),
        ),
        exempt = listOf("com.example.homework"),
        ifUnmeasured = WireIfUnmeasured.KEEP_OPEN,
        extra = listOf(WireExtra("x-1", "l-games", 15, "2026-11-17", requestId = "r-1", packageName = "com.example.blocks")),
        selfServe = WireSelfServe(minutes = 10, times = 2),
        warnBefore = 10,
    )

    @Test
    fun `a policy without Phase 3 fields enforces and collects nothing`() {
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":0}}""").policy
        assertNull(policy.screenTime)
        assertNull(policy.stage)
        assertNull(policy.agreement)
        assertFalse(policy.networkLog.enabled)
        assertTrue(policy.commands.isEmpty())
    }

    @Test
    fun `an empty screen_time measures nothing and limits nothing`() {
        val st = Wire.json.decodeFromString(WireScreenTime.serializer(), "{}")
        assertFalse(st.measure)
        assertEquals(WireScreenTime.ZONE_PHONE, st.zone)
        assertEquals("00:00", st.dayStarts)
        assertTrue(st.limits.isEmpty() && st.schedules.isEmpty() && st.exempt.isEmpty() && st.extra.isEmpty())
        assertNull(st.selfServe)
        assertEquals(WireIfUnmeasured.PAUSE_LIMITED, st.ifUnmeasured)
        assertEquals(5, st.warnBefore)
    }

    @Test
    fun `a Phase 3 policy parses with the server's snake_case names`() {
        val json = """{"server_time":5,"policy":{"version":9,
            "screen_time":{"measure":true,"zone":"America/New_York","day_starts":"04:00",
              "limits":[{"id":"l-games","name":"Games","packages":["com.example.blocks"],"minutes":60,
                "by_day":{"sat":120,"sun":120}}],
              "schedules":[{"id":"s-bed","kind":"bedtime","name":"Bedtime","days":["sun","mon"],
                "start":"21:00","end":"07:00","allow":["com.example.audiobooks"],"lock":true,"skip":["2026-11-26"]}],
              "exempt":["com.example.homework"],"if_unmeasured":"keep_open",
              "extra":[{"id":"x-1","limit_id":"*","minutes":15,"day":"2026-11-17","request_id":"r-1"}],
              "self_serve":{"minutes":10,"times":2},"warn_before":3},
            "stage":{"name":"Explorer","number":2,"since":1,"next":{"name":"Navigator",
              "unlocks":["Daily screen time goes from 1 h 30 min to 2 h"],"how":"A month of kept limits"}},
            "agreement":{"version":3,"sections":[{"title":"Phones at dinner","text":"In the basket."}],"kid_agreed_at":2},
            "network_log":{"enabled":true},
            "commands":[{"id":"c-1","kind":"lock_now","issued_at":3,"expires_at":4},
              {"id":"c-2","kind":"locate_now","issued_at":3,"expires_at":4}],
            "requests":[{"id":"r-1","status":"approved","minutes":15,"answered_at":4}]}}"""
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), json).policy
        val st = policy.screenTime!!
        assertEquals("04:00", st.dayStarts)
        assertEquals(120, st.limits.single().byDay?.get(DayOfWeek.SATURDAY))
        assertNull(st.limits.single().byDay?.get(DayOfWeek.MONDAY))
        val bedtime = st.schedules.single()
        assertEquals(WireScheduleKind.BEDTIME, bedtime.kind)
        assertEquals(listOf(DayOfWeek.SUNDAY, DayOfWeek.MONDAY), bedtime.days.map { it.dayOfWeek })
        assertTrue(bedtime.lock)
        assertEquals(WireIfUnmeasured.KEEP_OPEN, st.ifUnmeasured)
        assertEquals(WireExtra.EVERY_LIMIT, st.extra.single().limitId)
        assertNull(st.extra.single().packageName)
        assertEquals(WireSelfServe(10, 2), st.selfServe)
        assertEquals("Navigator", policy.stage?.next?.name)
        assertEquals(3, policy.agreement?.version)
        assertTrue(policy.networkLog.enabled)
        assertEquals(listOf(WireCommand.LOCK_NOW, "locate_now"), policy.commands.map { it.kind }, "a later phase's kind still parses")
        assertEquals(15, policy.requests.single().minutes)
    }

    @Test
    fun `Phase 2's reader still parses a policy with Phase 3 fields`() {
        val json = """{"server_time":5,"policy":{"version":9,"screen_time":{"measure":true},"network_log":{"enabled":false},
            "requests":[{"id":"r-1","status":"approved","minutes":15}]}}"""
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), json).policy
        assertEquals(9, policy.version)
        assertEquals("r-1", policy.requests.single().id)
    }

    @Test
    fun `every policy type survives a round trip`() {
        roundTrip(WireScreenTime.serializer(), screenTime)
        roundTrip(
            WirePolicy.serializer(),
            WirePolicy(
                version = 9,
                screenTime = screenTime,
                stage = WireStage("Explorer", 2, 100, WireStageNext("Navigator", listOf("More time"), "Ask us", screenTime)),
                agreement = WireAgreement(3, listOf(WireAgreementSection("Dinner", "No phones")), kidAgreedAt = 5, parentsAgreedAt = 4),
                networkLog = WireNetworkLog(enabled = true),
                commands = listOf(WireCommand("c-1", WireCommand.LOCK_NOW, 1, 2)),
                requests = listOf(WireRequestAnswer("r-1", WireRequestStatus.APPROVED, minutes = 30)),
            ),
        )
    }

    @Test
    fun `a limit and a schedule use the server's names`() {
        val limit = obj(Wire.json.encodeToString(WireLimit.serializer(), screenTime.limits.first()))
        assertEquals(setOf("id", "name", "packages", "minutes", "by_day"), limit.keys)
        assertEquals(setOf("sat", "sun"), (limit["by_day"] as JsonObject).keys, "days without an override are left out")
        val schedule = obj(Wire.json.encodeToString(WireSchedule.serializer(), screenTime.schedules.first()))
        assertEquals(setOf("id", "kind", "name", "days", "start", "end", "allow", "lock", "skip"), schedule.keys)
        assertEquals("\"school\"", schedule["kind"].toString())
        assertEquals("[\"mon\",\"tue\",\"wed\",\"thu\",\"fri\"]", schedule["days"].toString())
        val st = obj(Wire.json.encodeToString(WireScreenTime.serializer(), screenTime))
        assertEquals(
            setOf(
                "measure", "zone", "day_starts", "limits", "schedules", "exempt", "if_unmeasured", "extra",
                "self_serve", "warn_before",
            ),
            st.keys,
        )
        val extra = (st["extra"] as JsonArray).single().jsonObject
        assertEquals(setOf("id", "limit_id", "minutes", "day", "request_id", "package"), extra.keys)
    }

    @Test
    fun `a usage day uses the server's names`() {
        val day = WireUsageDay(
            day = "2026-11-17", zone = "America/New_York", asOf = 1_794_867_161_711, complete = false,
            screenMinutes = 95, unlocks = 31, byHour = List(24) { if (it == 16) 40 else 0 },
            apps = listOf(WireUsageApp("com.example.blocks", 40, 3)),
            gaps = listOf(WireUsageGap(1, 2, WireGapReason.NO_USAGE_ACCESS)),
        )
        roundTrip(UsageRequest.serializer(), UsageRequest(listOf(day)))
        val json = obj(Wire.json.encodeToString(UsageRequest.serializer(), UsageRequest(listOf(day))))
        val sent = (json["days"] as JsonArray).single().jsonObject
        assertEquals(
            setOf("day", "zone", "as_of", "complete", "screen_minutes", "unlocks", "by_hour", "apps", "gaps"),
            sent.keys,
        )
        assertEquals(setOf("package", "minutes", "opens"), (sent["apps"] as JsonArray).single().jsonObject.keys)
        assertEquals("\"no_usage_access\"", (sent["gaps"] as JsonArray).single().jsonObject["reason"].toString())
        val answer = Wire.json.decodeFromString(UsageResponse.serializer(), """{"server_time":1,"accepted":1,"later":true}""")
        assertEquals(1, answer.accepted)
    }

    @Test
    fun `a more-time request writes only its own fields`() {
        val request = MoreTime.request(
            "r-1", limitId = "l-games", minutes = 15, askedAt = 7, packageName = "com.example.blocks",
            reason = "One more level",
        )
        roundTrip(WireRequest.serializer(), request)
        val json = obj(Wire.json.encodeToString(RequestsRequest.serializer(), RequestsRequest(listOf(request))))
        val sent = (json["requests"] as JsonArray).single().jsonObject
        assertEquals(setOf("id", "kind", "limit_id", "minutes", "package", "reason", "asked_at"), sent.keys)
        assertEquals("\"more_time\"", sent["kind"].toString())
        val bare = obj(Wire.json.encodeToString(WireRequest.serializer(), MoreTime.request("r-2", "l-games", 30, 8)))
        assertEquals(setOf("id", "kind", "limit_id", "minutes", "asked_at"), bare.keys)
    }

    @Test
    fun `an agreement answer writes only its own fields`() {
        val answer = AgreementAnswer.request("r-3", version = 3, answer = WireAgreementAnswer.TALK, askedAt = 9)
        roundTrip(WireRequest.serializer(), answer)
        val sent = obj(Wire.json.encodeToString(WireRequest.serializer(), answer))
        assertEquals(setOf("id", "kind", "version", "answer", "asked_at"), sent.keys)
        assertEquals("\"talk\"", sent["answer"].toString())
    }

    @Test
    fun `the enforcement report leaves minutes out when they're not sent`() {
        val status = WireScreenTimeStatus(
            day = "2026-11-17", measured = true,
            limits = listOf(WireLimitStatus("l-games", state = WireLimitState.USED_UP)),
            schedule = WireScheduleNow("s-bed", 9),
            selfServe = listOf(WireSelfServeTake(WireExtra.EVERY_LIMIT, "com.example.blocks", 10, 8)),
        )
        val report = WireEnforcement(
            policyVersion = 9,
            screenTime = status,
            commands = listOf(WireCommandResult("c-1", WireCommandOutcome.EXPIRED, 3)),
            networkLog = WireNetworkLogStatus(enabled = true, paused = true),
        )
        roundTrip(WireEnforcement.serializer(), report)
        val json = obj(Wire.json.encodeToString(WireEnforcement.serializer(), report))
        val sent = json["screen_time"] as JsonObject
        assertEquals(setOf("day", "measured", "limits", "schedule", "self_serve"), sent.keys, "no used_minutes")
        assertEquals(setOf("id", "state"), (sent["limits"] as JsonArray).single().jsonObject.keys)
        assertEquals("\"used_up\"", (sent["limits"] as JsonArray).single().jsonObject["state"].toString())
        assertEquals("\"expired\"", (json["commands"] as JsonArray).single().jsonObject["result"].toString())
    }

    @Test
    fun `days map to java's days of the week`() {
        assertEquals(DayOfWeek.MONDAY, WireDay.MON.dayOfWeek)
        assertEquals(WireDay.SUN, WireDay.of(DayOfWeek.SUNDAY))
        DayOfWeek.entries.forEach { assertEquals(it, WireDay.of(it).dayOfWeek) }
    }
}
