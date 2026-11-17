package family.brooker.belay.core.location

import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.RequestsRequest
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireEnforcement
import family.brooker.belay.core.WireRequest
import family.brooker.belay.core.WireRequestKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LocationProtocolTest {
    private fun obj(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private val fix = WireFix(
        id = "fix-00000001", at = 1_794_867_161_711, lat = 40.71277, lng = -74.00597, accuracyM = 12,
        provider = WireLocationProvider.GPS, reason = WireFixReason.ON_DEMAND, commandId = "command-0001",
    )

    @Test
    fun `a policy without Phase 4 and 7 fields collects no location and lists nothing`() {
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":0}}""").policy
        assertNull(policy.location)
        assertTrue(policy.aiReads.isEmpty() && policy.helpSeen.isEmpty() && policy.parentNumbers.isEmpty())
        val off = Wire.json.decodeFromString(WireLocation.serializer(), "{}")
        assertEquals(WireLocationMode.OFF, off.mode)
        assertEquals(WireLocationProvider.GPS, off.provider)
        assertTrue(!off.keepOn && !off.fallbackFused && off.lost == null && off.places.isEmpty())
    }

    @Test
    fun `a Phase 4 and 7 policy parses with the server's names`() {
        val json = """{"server_time":5,"policy":{"version":12,
            "location":{"mode":"periodic","every_minutes":30,"hours":{"start":"07:00","end":"21:00"},
              "provider":"gps","fallback_fused":true,"keep_on":true,
              "places":[{"id":"p-school","name":"School","lat":40.7,"lng":-74.0,"radius_m":150,"notify":["arrive","leave"]}],
              "lost":{"since":3,"message":"This phone is lost. Please call 555-0100"}},
            "commands":[{"id":"command-0002","kind":"locate_now","issued_at":3,"expires_at":4}],
            "ai_reads":["apps","screen_time"],
            "help_seen":[{"request_id":"request-0009","at":4,"by":"Alex"}],
            "parent_numbers":[{"name":"Mom","number":"+15555550100"}]}}"""
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), json).policy
        val location = policy.location!!
        assertEquals(WireLocationMode.PERIODIC, location.mode)
        assertEquals(30, location.everyMinutes)
        assertEquals(WireHours("07:00", "21:00"), location.hours)
        assertEquals(listOf(WirePlaceNotify.ARRIVE, WirePlaceNotify.LEAVE), location.places.single().notify)
        assertEquals(150, location.places.single().radiusM)
        assertEquals("This phone is lost. Please call 555-0100", location.lost?.message)
        assertEquals(WireCommand.LOCATE_NOW, policy.commands.single().kind)
        assertEquals(listOf("apps", "screen_time"), policy.aiReads)
        assertEquals("request-0009", policy.helpSeen.single().requestId)
        assertEquals("+15555550100", policy.parentNumbers.single().number)
    }

    @Test
    fun `fixes and place events use the server's names`() {
        val event = WirePlaceEvent("event-0001", "p-school", WirePlaceEventKind.ARRIVED, 7, fix.id)
        val sent = obj(Wire.json.encodeToString(LocationsRequest.serializer(), LocationsRequest(listOf(fix), listOf(event))))
        val f = (sent["fixes"] as JsonArray).single().jsonObject
        assertEquals(setOf("id", "at", "lat", "lng", "accuracy_m", "provider", "reason", "command_id", "mock"), f.keys)
        assertEquals("\"on_demand\"", f["reason"].toString())
        val e = (sent["place_events"] as JsonArray).single().jsonObject
        assertEquals(setOf("id", "place_id", "kind", "at", "fix_id"), e.keys)
        assertEquals("\"arrived\"", e["kind"].toString())
        assertEquals(3, Wire.json.decodeFromString(LocationsResponse.serializer(), """{"server_time":1,"accepted":3,"later":1}""").accepted)
    }

    @Test
    fun `help and talk requests write only their own fields, and a withdrawal says when`() {
        val help = WireRequest("request-0010", WireRequestKind.HELP, askedAt = 9, location = fix.copy(reason = WireFixReason.HELP, commandId = null))
        val talk = WireRequest("request-0011", WireRequestKind.TALK, reason = "Can we talk about bedtime?", askedAt = 9)
        val withdrawn = talk.copy(withdrawnAt = 10)
        val sent = obj(Wire.json.encodeToString(RequestsRequest.serializer(), RequestsRequest(listOf(help, talk, withdrawn))))
        val (h, t, w) = (sent["requests"] as JsonArray).map { it.jsonObject }
        assertEquals(setOf("id", "kind", "asked_at", "location"), h.keys)
        assertEquals("\"help\"", h["kind"].toString())
        assertEquals(setOf("id", "kind", "reason", "asked_at"), t.keys)
        assertEquals(setOf("id", "kind", "reason", "asked_at", "withdrawn_at"), w.keys)
    }

    @Test
    fun `the enforcement report carries location status`() {
        val report = WireEnforcement(policyVersion = 12, location = WireLocationStatus(permission = true, locationOn = false, problem = "Location is turned off"))
        val json = obj(Wire.json.encodeToString(WireEnforcement.serializer(), report))
        assertEquals(setOf("permission", "location_on", "problem"), (json["location"] as JsonObject).keys)
    }
}
