package family.brooker.belay.core.network

import family.brooker.belay.core.Applied
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireEnforcement
import family.brooker.belay.core.screentime.WireNetworkLogStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Which of Android's batches Belay takes, what it reports, and the protocol's names. */
class NetworkLogTest {
    private val on = NetworkLog.turnedOn(at = 100, bootCount = 12)

    @Test
    fun `the first batch after turning logging on is batch 1`() {
        assertEquals(listOf(1L), NetworkLog.tokens(on, 1, 12))
        val took = NetworkLog.took(on, 1, 12, at = 200, lookups = 40)
        assertEquals(1, took.lastToken)
        assertEquals(200, took.lastBatchAt)
        assertEquals(40, took.lastBatchLookups)
        // The same notice again takes nothing twice.
        assertEquals(emptyList(), NetworkLog.tokens(took, 1, 12))
    }

    @Test
    fun `batches missed since the last are taken too, as far back as Android keeps them`() {
        val took3 = NetworkLog.took(on, 3, 12, 300, 10)
        assertEquals(listOf(4L, 5L, 6L), NetworkLog.tokens(took3, 6, 12))
        assertEquals(listOf(16L, 17L, 18L, 19L, 20L), NetworkLog.tokens(took3, 20, 12))
    }

    @Test
    fun `after a restart, or when Android counts from 1 again, the count starts over`() {
        val took9 = NetworkLog.took(on, 9, 12, 300, 10)
        assertEquals(listOf(1L, 2L), NetworkLog.tokens(took9, 2, 13), "a new boot")
        assertEquals(listOf(1L, 2L, 3L), NetworkLog.tokens(took9, 3, 12), "a smaller token in the same boot")
        assertEquals(listOf(4L, 5L, 6L, 7L, 8L), NetworkLog.tokens(took9, 8, null), "no boot count: Android's own count decides")
        assertEquals(emptyList(), NetworkLog.tokens(took9, 0, 12))
        assertEquals(emptyList(), NetworkLog.tokens(took9, -1, 12))
    }

    @Test
    fun `a refusal pauses the report until a batch comes through again`() {
        val refused = NetworkLog.refused(on, 500)
        assertEquals(WireNetworkLogStatus(enabled = true, paused = true), NetworkLog.report(policyOn = true, androidOn = true, otherUsers = 0, state = refused))
        val again = NetworkLog.took(refused, 1, 12, 600, 3)
        assertNull(again.refusedAt)
        assertEquals(WireNetworkLogStatus(enabled = true, paused = false), NetworkLog.report(true, true, 0, again))
    }

    @Test
    fun `the report says whether Android logs, and whether another user or profile paused it`() {
        assertNull(NetworkLog.report(policyOn = false, androidOn = false, otherUsers = 1, state = null), "nothing to say")
        assertEquals(WireNetworkLogStatus(enabled = true, paused = true), NetworkLog.report(true, true, otherUsers = 1, state = on))
        assertEquals(WireNetworkLogStatus(enabled = true, paused = false), NetworkLog.report(true, true, 0, on))
        // On in the policy, but Android's isn't (Belay isn't device owner): reported as off, not paused.
        assertEquals(WireNetworkLogStatus(enabled = false, paused = false), NetworkLog.report(true, false, 1, null))
        // Off in the policy, but still on in Android until Belay turns it off: reported, so the parent sees it.
        assertEquals(WireNetworkLogStatus(enabled = true, paused = false), NetworkLog.report(false, true, 0, null))
    }

    private fun obj(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `network days use the server's names`() {
        val day = WireNetworkDay("2026-11-17", "America/Los_Angeles", 1794867161711, listOf(WireNetworkEntry("com.example.chat", "example.com", 42)), dropped = 0)
        val json = obj(Wire.json.encodeToString(NetworkRequest.serializer(), NetworkRequest(listOf(day))))
        val sent = (json["days"] as JsonArray).single().jsonObject
        assertEquals(setOf("day", "zone", "as_of", "entries", "dropped"), sent.keys)
        assertEquals(setOf("package", "domain", "lookups"), (sent["entries"] as JsonArray).single().jsonObject.keys)
        assertEquals(day, Wire.json.decodeFromString(WireNetworkDay.serializer(), Wire.json.encodeToString(WireNetworkDay.serializer(), day)))
        assertEquals(NetworkResponse(5, 1), Wire.json.decodeFromString(NetworkResponse.serializer(), """{"server_time":5,"accepted":1,"later":true}"""))
    }

    @Test
    fun `the policy's network_log is off unless it says on, and the report carries enabled and paused`() {
        val old = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":3}}""").policy
        assertFalse(old.networkLog.enabled)
        val on = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":1,"policy":{"version":4,"network_log":{"enabled":true}}}""").policy
        assertTrue(on.networkLog.enabled)
        val report = Enforcement.report(Applied(policyVersion = 4), networkLog = WireNetworkLogStatus(enabled = true, paused = false))
        val json = obj(Wire.json.encodeToString(WireEnforcement.serializer(), report!!))
        assertEquals("""{"enabled":true,"paused":false}""", json["network_log"].toString())
        // Off: left out of the check-in altogether.
        val off = obj(Wire.json.encodeToString(WireEnforcement.serializer(), Enforcement.report(Applied(policyVersion = 4))!!))
        assertFalse("network_log" in off.keys)
    }
}
