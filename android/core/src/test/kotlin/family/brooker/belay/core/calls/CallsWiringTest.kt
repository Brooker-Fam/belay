package family.brooker.belay.core.calls

import family.brooker.belay.core.AnsweredRequest
import family.brooker.belay.core.CategoryPermissions
import family.brooker.belay.core.CategoryPermissions.CALL_PHONE
import family.brooker.belay.core.CategoryPermissions.PROCESS_OUTGOING_CALLS
import family.brooker.belay.core.CategoryPermissions.READ_CALL_LOG
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.OutboxDrain
import family.brooker.belay.core.OutboxItem
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.OutboxType
import family.brooker.belay.core.RequestsRequest
import family.brooker.belay.core.Requests
import family.brooker.belay.core.Verdict
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Phase 5's calls in the outbox, the kid's contact request, and the permissions calls ties to. */
class CallsWiringTest {
    private fun call(id: Long, bytes: Int = 150) = OutboxItem(id, OutboxType.CALL, bytes)
    private fun event(id: Long) = OutboxItem(id, OutboxType.EVENT, 400)
    private fun fix(id: Long) = OutboxItem(id, OutboxType.FIX, 220)

    @Test
    fun `call records go in a lane of their own, up to 500 and under 96 KB`() {
        assertEquals(3, OutboxPolicy.lane(OutboxType.CALL))
        assertEquals(setOf(0, 1, 2), (OutboxType.entries - OutboxType.CALL).map(OutboxPolicy::lane).toSet())
        val many = (1L..600L).map { call(it) }
        assertEquals(500, OutboxPolicy.batchSize(many))
        val big = (1L..400L).map { call(it, bytes = 1_000) }
        val size = OutboxPolicy.batchSize(big)
        assertTrue(OutboxPolicy.CALLS_WRAPPER_BYTES + size * 1_001 <= OutboxPolicy.MAX_CALLS_BODY_BYTES)
        assertTrue(OutboxPolicy.MAX_CALLS_BODY_BYTES < CallsWireLimits.MAX_BODY_BYTES)
        assertEquals("{\"calls\":[]}".length, OutboxPolicy.CALLS_WRAPPER_BYTES)
    }

    @Test
    fun `a server without POST calls holds back only the calls lane`() {
        val lanes = listOf(event(1), call(2), fix(3), call(4)).groupBy { OutboxPolicy.lane(it.type) }
        val notFound = OutboxPolicy.verdict(404, "not_found", items = 2)
        var callRequests = 0
        assertNull(OutboxDrain.run(lanes.getValue(0)) { Verdict.Sent }.stop)
        assertNull(OutboxDrain.run(lanes.getValue(2)) { Verdict.Sent }.stop)
        val stop = OutboxDrain.run(lanes.getValue(3)) {
            callRequests++
            notFound
        }.stop
        assertIs<OutboxDrain.Stop.Retry>(stop)
        assertEquals(1, callRequests, "both records in one request, retried later")
    }

    @Test
    fun `Ask to add a contact sends the name, the number in E164 and why`() {
        val ask = assertNotNull(Requests.contact("  Coach Lee  ", "+1 (555) 555-0142", "My soccer coach", T0, ids()))
        assertEquals(WireRequestKind.CONTACT, ask.kind)
        val wire = Requests.toWire(ask)
        assertEquals("Coach Lee", wire.contactName)
        assertEquals("+15555550142", wire.contactNumber)
        val keys = (Json.parseToJsonElement(Wire.json.encodeToString(RequestsRequest.serializer(), RequestsRequest(listOf(wire)))).jsonObject["requests"] as JsonArray).single().jsonObject.keys
        assertEquals(setOf("id", "kind", "reason", "asked_at", "contact_name", "contact_number"), keys)
    }

    @Test
    fun `a contact request needs a name and a whole number`() {
        assertNull(Requests.contact("  ", "+15555550142", null, T0, ids()))
        assertNull(Requests.contact("Coach", "5550142", null, T0, ids()), "the phone formats it to E.164 first")
        assertNull(Requests.contact("Coach", "", null, T0, ids()))
        val long = assertNotNull(Requests.contact("N".repeat(90), "+15555550142", null, T0, ids()))
        assertEquals(CallsWireLimits.MAX_CONTACT_NAME, long.contactName?.length)
        assertNull(Requests.toWire(long).reason, "why is optional")
    }

    @Test
    fun `a pending contact request can be changed and taken back like the others`() {
        val ask = assertNotNull(Requests.contact("Coach Lee", "+15555550142", null, T0, ids()))
        val answered = listOf(AnsweredRequest(ask, null))
        val edited = assertNotNull(Requests.edit(answered, ask.id, "My coach"))
        assertEquals("My coach", Requests.toWire(edited).reason)
        assertEquals("Coach Lee", Requests.toWire(edited).contactName)
        val withdrawn = assertNotNull(Requests.withdraw(answered, ask.id, T0 + 1))
        assertEquals(T0 + 1, Requests.toWire(withdrawn).withdrawnAt)
    }

    @Test
    fun `the call permissions are granted only while the policy has calls`() {
        val declared = listOf("android.permission.POST_NOTIFICATIONS", CALL_PHONE, READ_CALL_LOG, PROCESS_OUTGOING_CALLS)
        val callPermissions = setOf(CALL_PHONE, READ_CALL_LOG, PROCESS_OUTGOING_CALLS)
        for (calls in listOf(WireCalls(), WireCalls(mode = WireCallMode.CONTACTS, log = true))) {
            val plan = CategoryPermissions.plan(declared, CategoryPermissions.categoriesOn(WirePolicy(version = 1, calls = calls), false), false)
            assertTrue(plan.grant.containsAll(callPermissions), "granted with $calls")
        }
        for (policy in listOf(null, WirePolicy(version = 1), WirePolicy(version = 1, location = WireLocation(mode = WireLocationMode.ON_DEMAND)))) {
            val plan = CategoryPermissions.plan(declared, CategoryPermissions.categoriesOn(policy, false), false)
            assertTrue(plan.deny.containsAll(callPermissions), "denied with $policy")
            assertTrue("android.permission.POST_NOTIFICATIONS" in plan.grant)
        }
        assertTrue(callPermissions.all(CategoryPermissions::tied))
        assertEquals(DataCategories.CALLS_ID, CategoryPermissions.CATEGORY[CALL_PHONE])
    }

    @Test
    fun `numbers are compared as E164, or as what Android dials`() {
        assertEquals("+15555550100", PhoneNumbers.e164("+1 (555) 555-0100"))
        assertEquals("+15555550100", PhoneNumbers.e164("+1.555.555.0100,,123"))
        assertNull(PhoneNumbers.e164("(555) 555-0100"))
        assertNull(PhoneNumbers.e164("+0123456789"))
        assertNull(PhoneNumbers.e164("+12345"))
        assertEquals("5555550100", PhoneNumbers.key("(555) 555-0100"))
        assertEquals("*86", PhoneNumbers.key("*86"))
        assertEquals("+15555550100", PhoneNumbers.key("+1 555 555 0100"))
        assertNull(PhoneNumbers.key("  -  "))
        assertNull(PhoneNumbers.key(null))
        assertEquals("+12", PhoneNumbers.dialable("+1+2"), "a plus only at the start")
        assertTrue(PhoneNumbers.isE164("+15555550100"))
        assertFalse(PhoneNumbers.isE164("15555550100"))
    }
}
