package family.brooker.belay.core.calls

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Wire
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up numbers only. */
class CallRecordsTest {
    private val android = EmergencyNumbers { it in setOf("911", "112") }
    private val cantSay = EmergencyNumbers { null }
    private val sam = WireContact("c-sam", "Sam", listOf("+15555550123"))
    private val private = setOf("+15555550150")

    private fun entry(number: String?, contact: WireContact? = null, privateNumbers: Set<String> = private, emergency: EmergencyNumbers = android) =
        CallRecords.entry("call-0001", T0, WireCallDirection.OUT, number, contact, 65, WireCallOutcome.ANSWERED, null, privateNumbers, emergency)

    @Test
    fun `calls with emergency numbers, 988 and private numbers are never kept`() {
        val never = listOf("911", "9-1-1", "988", "(988)", "112", "+15555550150", "+1 (555) 555-0150")
        for (number in never) {
            assertNull(entry(number), number)
            assertTrue(!CallRecords.keepable(number, private, android), number)
        }
        // Android can't say: its own no-SIM list still counts as emergency numbers.
        for (number in AlwaysAllowed.WHEN_ANDROID_CANT_SAY + "988") assertNull(entry(number, emergency = cantSay), number)
    }

    @Test
    fun `other calls are kept with the contact or the number`() {
        val withSam = assertNotNull(entry("+15555550123", sam))
        assertEquals("c-sam", withSam.contactId)
        val stranger = assertNotNull(entry("+1 555 555 0199"))
        assertEquals("+15555550199", stranger.number)
        assertNull(stranger.contactId)
        val withheld = assertNotNull(entry(null))
        assertNull(withheld.number)
        assertEquals(65, withheld.durationS)
    }

    @Test
    fun `the wire record names a contact by id, or carries the number for someone who isn't one`() {
        val contactRecord = assertNotNull(CallRecords.toWire(assertNotNull(entry("+15555550123", sam)), private, android))
        assertEquals("c-sam", contactRecord.contactId)
        assertNull(contactRecord.number, "a contact's number isn't sent")
        val strangerRecord = assertNotNull(CallRecords.toWire(assertNotNull(entry("+15555550199")), private, android))
        assertEquals("+15555550199", strangerRecord.number)
        val keys = Json.parseToJsonElement(Wire.json.encodeToString(WireCallRecord.serializer(), strangerRecord)).jsonObject.keys
        assertEquals(setOf("id", "at", "direction", "number", "duration_s", "outcome"), keys)
        // A short code isn't E.164: the record goes without it.
        val short = assertNotNull(entry("55501"))
        assertNull(assertNotNull(CallRecords.toWire(short, private, android)).number)
    }

    @Test
    fun `a number made private after the call stays on the phone and isn't sent`() {
        val kept = assertNotNull(entry("+15555550199"))
        assertNull(CallRecords.toWire(kept, private + "+15555550199", android))
        // And a stored record that somehow has an always-allowed number is never sent.
        assertNull(CallRecords.toWire(kept.copy(number = "988"), private, android))
        assertNull(CallRecords.toWire(kept.copy(number = "911"), private, android))
    }

    @Test
    fun `durations stay within what the server takes`() {
        val long = assertNotNull(CallRecords.entry("call-0002", T0, WireCallDirection.IN, "+15555550199", null, 100_000, WireCallOutcome.ANSWERED, null, private, android))
        assertEquals(CallRecords.MAX_DURATION_S, long.durationS)
        val negative = assertNotNull(CallRecords.entry("call-0003", T0, WireCallDirection.IN, "+15555550199", null, -5, WireCallOutcome.MISSED, null, private, android))
        assertEquals(0, negative.durationS)
    }

    @Test
    fun `only calls with always-allowed or private numbers are taken from Android's call log`() {
        val log = listOf(
            AndroidLogCall("988", T0 - HOUR, WireCallDirection.OUT, 600),
            AndroidLogCall("911", T0 - 2 * HOUR, WireCallDirection.OUT, 60),
            AndroidLogCall("+15555550150", T0 - 3 * HOUR, WireCallDirection.IN, 30),
            AndroidLogCall("+15555550123", T0 - HOUR, WireCallDirection.OUT, 90),
            AndroidLogCall("+15555550199", T0 - HOUR, WireCallDirection.IN, 0, blocked = true),
            AndroidLogCall("988", T0 - CallRecords.ANDROID_LOG_MS, WireCallDirection.OUT, 10),
            AndroidLogCall("988", T0 - HOUR, null, 10),
        )
        val shown = CallRecords.privateCalls(log, private, android, T0)
        assertEquals(listOf("988", "911", "+15555550150"), shown.map { it.number })
        assertEquals(listOf(AlwaysAllowedKind.CRISIS_988, AlwaysAllowedKind.EMERGENCY, null), shown.map { it.kind })
    }

    @Test
    fun `Android's call log opens the callback window for a call Belay's dialer didn't see`() {
        val log = listOf(
            AndroidLogCall("+15555550123", T0 - 10 * 60_000, WireCallDirection.OUT, 90),
            AndroidLogCall("911", T0 - HOUR, WireCallDirection.OUT, 60),
            AndroidLogCall("988", T0 - 30 * 60_000, WireCallDirection.IN, 60),
        )
        assertEquals(T0 - HOUR, CallRecords.lastEmergencyContact(log, android, T0), "outgoing only")
        assertNull(CallRecords.lastEmergencyContact(listOf(AndroidLogCall("911", T0 - 3 * HOUR, WireCallDirection.OUT, 60)), android, T0))
        assertNull(CallRecords.lastEmergencyContact(emptyList(), android, T0))
    }

    @Test
    fun `Belay keeps 30 days of its own calls, newest first`() {
        val old = assertNotNull(entry("+15555550199")).copy(id = "old", at = T0 - CallRecords.KEEP_MS)
        val recent = assertNotNull(entry("+15555550199")).copy(id = "recent", at = T0 - HOUR)
        val newest = assertNotNull(entry("+15555550199")).copy(id = "newest", at = T0)
        assertEquals(listOf("newest", "recent"), CallRecords.kept(listOf(recent, old, newest), T0).map { it.id })
    }
}
