package family.brooker.belay.core.calls

import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.RequestsRequest
import family.brooker.belay.core.Wire
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

class CallsProtocolTest {
    private fun obj(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `a policy without Phase 5 fields leaves calls alone`() {
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":0}}""").policy
        assertNull(policy.calls)
        assertTrue(policy.contacts.isEmpty())
        val calls = Wire.json.decodeFromString(WireCalls.serializer(), "{}")
        assertEquals(WireCalls(), calls)
        assertEquals(WireCallMode.OPEN, calls.mode)
        assertEquals(WireOutgoing.ANY, calls.outgoing)
    }

    @Test
    fun `a Phase 5 policy parses with the server's names`() {
        val json = """{"server_time":5,"policy":{"version":20,
            "calls":{"mode":"contacts","unknown":"voicemail","withheld":"reject","outgoing":"contacts","quiet":true,"log":true},
            "contacts":[{"id":"c-mom","name":"Mom","numbers":["+15555550100"],"calls":true,"texts":true,"parent":true},
                        {"id":"c-sam","name":"Sam","numbers":["+15555550123","+15555550124"],"calls":true,"texts":false,"parent":false}]}}"""
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), json).policy
        val calls = policy.calls!!
        assertEquals(WireCallMode.CONTACTS, calls.mode)
        assertEquals(WireCallAction.VOICEMAIL, calls.unknown)
        assertEquals(WireCallAction.REJECT, calls.withheld)
        assertEquals(WireOutgoing.CONTACTS, calls.outgoing)
        assertTrue(calls.quiet && calls.log)
        assertEquals(listOf(true, false), policy.contacts.map { it.parent })
        assertEquals(2, policy.contacts[1].numbers.size)
    }

    @Test
    fun `call records, the report and a contact request use the server's names`() {
        val record = WireCallRecord("call-00000001", 7, WireCallDirection.IN, number = "+15555550999", outcome = WireCallOutcome.REJECTED, reason = WireCallReason.UNKNOWN)
        val sent = (obj(Wire.json.encodeToString(CallsRequest.serializer(), CallsRequest(listOf(record))))["calls"] as JsonArray).single().jsonObject
        assertEquals(setOf("id", "at", "direction", "number", "duration_s", "outcome", "reason"), sent.keys)
        assertEquals("\"rejected\"", sent["outcome"].toString())
        val report = obj(Wire.json.encodeToString(WireEnforcement.serializer(), WireEnforcement(policyVersion = 20, calls = WireCallsStatus(dialer = false, problem = "Calls are going through the phone's own app"))))
        assertEquals(setOf("dialer", "problem"), (report["calls"] as JsonObject).keys)
        val ask = WireRequest("request-0020", WireRequestKind.CONTACT, reason = "My coach", askedAt = 9, contactName = "Coach Lee", contactNumber = "+15555550142")
        val request = (obj(Wire.json.encodeToString(RequestsRequest.serializer(), RequestsRequest(listOf(ask))))["requests"] as JsonArray).single().jsonObject
        assertEquals(setOf("id", "kind", "reason", "asked_at", "contact_name", "contact_number"), request.keys)
        assertEquals("\"contact\"", request["kind"].toString())
    }
}
