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

    /** Android on a US phone: 911 and 112, and a national number written in E.164 with its +1. */
    private val us = object : EmergencyNumbers {
        override fun isEmergency(number: String) = number in setOf("911", "112")

        override fun e164(number: String): String? = when {
            PhoneNumbers.isE164(number) -> number
            number.length == 10 && number.all(Char::isDigit) -> "+1$number"
            number.length == 11 && number.startsWith('1') && number.all(Char::isDigit) -> "+$number"
            else -> null
        }
    }
    private val sam = WireContact("c-sam", "Sam", listOf("+15555550123"))
    private val private = setOf("+15555550150")

    private fun entry(
        number: String?,
        contact: WireContact? = null,
        privateNumbers: Set<String> = private,
        emergency: EmergencyNumbers = android,
        direction: WireCallDirection = WireCallDirection.OUT,
        unverified: Boolean = false,
    ) = CallRecords.entry("call-0001", T0, direction, number, contact, 65, WireCallOutcome.ANSWERED, null, privateNumbers, emergency, unverified = unverified)

    @Test
    fun `calls with emergency numbers, 988 and private numbers are never kept`() {
        val never = listOf("911", "9-1-1", "988", "(988)", "112", "+15555550150", "+1 (555) 555-0150", "+18002738255", "1-800-273-8255")
        for (number in never) {
            for (direction in WireCallDirection.entries) assertNull(entry(number, direction = direction), "$number $direction")
            assertTrue(!CallRecords.keepable(number, private, android), number)
        }
        // Android can't say: its own no-SIM list still counts as emergency numbers.
        for (number in AlwaysAllowed.WHEN_ANDROID_CANT_SAY + "988") assertNull(entry(number, emergency = cantSay), number)
    }

    @Test
    fun `nor when the kid dials a caller-id code before them`() {
        val never = listOf("*67911", "*67 988", "#31#988", "*82988", "*31#911", "*67 1-800-273-8255", "*67+15555550150", "#31#5555550150", "*82 (555) 555-0150")
        for (number in never) {
            assertNull(entry(number, emergency = us), number)
            assertTrue(!CallRecords.keepable(number, private, us), number)
        }
        // The probes' numbers, kept and sent with no number before.
        assertNull(entry(PhoneNumbers.key("*67988"), emergency = us))
        assertNull(entry(PhoneNumbers.key("*675555550150"), emergency = us))
        assertTrue(CallRecords.isPrivate("*675555550150", private, us))
        assertTrue(!CallRecords.isPrivate("*675555550150", emptySet(), us))
    }

    @Test
    fun `other calls are kept with the contact or the number`() {
        val withSam = assertNotNull(entry("+15555550123", sam))
        assertEquals("c-sam", withSam.contactId)
        val stranger = assertNotNull(entry("+1 555 555 0199"))
        assertEquals("+15555550199", stranger.number)
        assertNull(stranger.contactId)
        val withheld = assertNotNull(entry(null, direction = WireCallDirection.IN))
        assertNull(withheld.number)
        assertEquals(65, withheld.durationS)
    }

    @Test
    fun `an outgoing call is kept only with its contact or its number in E164, caller-id codes taken off`() {
        // What the kid dialed with *67 before an ordinary number: the number it reached.
        assertEquals("+15555550199", assertNotNull(entry("*675555550199", emergency = us)).number)
        assertEquals("+15555550199", assertNotNull(entry("#31#+15555550199", emergency = us)).number)
        assertEquals("+15555550199", assertNotNull(entry("5555550199", emergency = us)).number)
        // No number Belay can write in E.164 (a short code, a national number without the phone's
        // country, nothing at all): neither kept nor sent, since it could only say that the kid called
        // someone, when, and for how long.
        for (number in listOf("55501", "*611", "5555550199", null, "*67")) assertNull(entry(number), "$number")
        // A code read two ways ("*27" then 25555550199, or "*272" then 5555550199): the reading that's a number.
        assertEquals("+15555550199", assertNotNull(entry("*2725555550199", emergency = us)).number)
        assertEquals("+15555550199", CallRecords.reached("*2725555550199", us))
        assertNull(CallRecords.reached("*2725555550199", android), "no formatter: no number")
        // A contact's call is kept by the contact.
        assertEquals("c-sam", assertNotNull(entry("+15555550123", sam)).contactId)
        // An incoming short code is kept, and sent without its number.
        val short = assertNotNull(entry("55501", direction = WireCallDirection.IN))
        assertNull(assertNotNull(CallRecords.toWire(short, private, android)).number)
        // A stored outgoing record without a number (from before) is never sent.
        assertNull(CallRecords.toWire(assertNotNull(entry("+15555550199")).copy(number = "*675555550199"), private, android))
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
    }

    @Test
    fun `a stranger's caller id that failed the network's check is kept, and sent without a number that's 911, 988 or private`() {
        for (shown in listOf("911", "988", "+18002738255", "112", "+15555550150")) {
            val spoofed = assertNotNull(entry(shown, direction = WireCallDirection.IN, unverified = true), shown)
            assertTrue(spoofed.unverified, shown)
            assertEquals(PhoneNumbers.key(shown), spoofed.number, "the kid's recent calls show what it showed")
            val wire = assertNotNull(CallRecords.toWire(spoofed, private, android), shown)
            assertNull(wire.number, "$shown: the server would drop it, and it would say nothing a parent can use")
            assertNull(wire.contactId)
        }
        // An ordinary number it showed goes, as any unknown caller's, so a parent can block it.
        val ordinary = assertNotNull(entry("+15555550199", direction = WireCallDirection.IN, unverified = true))
        assertEquals("+15555550199", assertNotNull(CallRecords.toWire(ordinary, private, android)).number)
        // Only incoming calls are checked by the network: an outgoing one is never unverified.
        assertNull(entry("988", unverified = true))
        // A spoofed caller id that rang only because of the window is never sent either.
        assertNull(CallRecords.toWire(assertNotNull(entry("988", direction = WireCallDirection.IN, unverified = true)).copy(callback = true), private, android))
        // Stored before the field existed: verified, as every record was.
        val old = Wire.json.decodeFromString(CallEntry.serializer(), """{"id":"call-0006","at":$T0,"direction":"in","outcome":"answered"}""")
        assertTrue(!old.unverified)
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
    fun `a call that rang only because of the callback window stays on the phone and is never sent`() {
        // A 988 counselor calling back from a number that isn't a contact: its record would tell.
        val callback = assertNotNull(
            CallRecords.entry("call-0004", T0, WireCallDirection.IN, "+15555550199", null, 300, WireCallOutcome.ANSWERED, null, private, android, callback = true),
        )
        assertTrue(callback.callback)
        assertNull(CallRecords.toWire(callback, private, android))
        assertNotNull(CallRecords.toWire(callback.copy(callback = false), private, android))
        // Stored before the field existed: an ordinary call.
        val old = Wire.json.decodeFromString(CallEntry.serializer(), """{"id":"call-0005","at":$T0,"direction":"in","outcome":"answered"}""")
        assertTrue(!old.callback)
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
        // With a caller-id code before them too.
        val prefixed = CallRecords.privateCalls(listOf(AndroidLogCall("*67911", T0 - HOUR, WireCallDirection.OUT, 60), AndroidLogCall("*675555550150", T0 - HOUR, WireCallDirection.OUT, 60)), private, us, T0)
        assertEquals(listOf(AlwaysAllowedKind.EMERGENCY, null), prefixed.map { it.kind })
        // A stranger's spoofed caller id that Belay keeps itself isn't listed twice.
        val spoofed = assertNotNull(entry("988", direction = WireCallDirection.IN, unverified = true)).copy(at = T0 - HOUR + 2_000)
        val incoming = listOf(AndroidLogCall("988", T0 - HOUR, WireCallDirection.IN, 0))
        assertEquals(emptyList(), CallRecords.privateCalls(incoming, private, android, T0, kept = listOf(spoofed)))
        assertEquals(1, CallRecords.privateCalls(incoming, private, android, T0, kept = listOf(spoofed.copy(at = T0 - 3 * HOUR))).size)
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
        // 911 dialed with *67 in the preloaded dialer opens it too.
        assertEquals(T0 - HOUR, CallRecords.lastEmergencyContact(listOf(AndroidLogCall("*67911", T0 - HOUR, WireCallDirection.OUT, 60)), android, T0))
    }

    @Test
    fun `Belay keeps 30 days of its own calls, newest first`() {
        val old = assertNotNull(entry("+15555550199")).copy(id = "old", at = T0 - CallRecords.KEEP_MS)
        val recent = assertNotNull(entry("+15555550199")).copy(id = "recent", at = T0 - HOUR)
        val newest = assertNotNull(entry("+15555550199")).copy(id = "newest", at = T0)
        assertEquals(listOf("newest", "recent"), CallRecords.kept(listOf(recent, old, newest), T0).map { it.id })
    }
}
