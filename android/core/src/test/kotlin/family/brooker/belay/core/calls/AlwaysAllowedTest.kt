package family.brooker.belay.core.calls

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AlwaysAllowedTest {
    /** Android on a US SIM: 911 and the 3GPP 112, as EmergencyNumberTracker reports with a SIM. */
    private val us = EmergencyNumbers { it in setOf("911", "112") }

    /** Android on a UK SIM: 999 and 112 (and 911 by 3GPP). */
    private val uk = EmergencyNumbers { it in setOf("999", "112", "911") }

    /** Android says nothing is an emergency number (a broken or odd SIM list). */
    private val none = EmergencyNumbers { false }

    /** Telephony isn't running: Android can't say. */
    private val cantSay = EmergencyNumbers { null }

    /** Telephony throws, as TelephonyManager does while the phone process restarts. */
    private val throws = EmergencyNumbers { throw IllegalStateException("telephony service is null.") }

    private val androids = listOf(us, uk, none, cantSay, throws)

    @Test
    fun `911 and 988 always work, whatever Android says`() {
        for (android in androids) {
            assertEquals(AlwaysAllowedKind.EMERGENCY, AlwaysAllowed.kind("911", android))
            assertEquals(AlwaysAllowedKind.CRISIS_988, AlwaysAllowed.kind("988", android))
            assertTrue(AlwaysAllowed.allows("911", android))
            assertTrue(AlwaysAllowed.allows("988", android))
        }
    }

    @Test
    fun `911 and 988 work with formatting and post-dial digits`() {
        val forms911 = listOf("911", " 911 ", "9-1-1", "9 1 1", "(911)", "9.1.1", "911,123", "911;4", "911p1", "911w2")
        val forms988 = listOf("988", " 988", "9-8-8", "(988)", "9 8 8", "988,,1", "988P5")
        for (android in androids) {
            forms911.forEach { assertEquals(AlwaysAllowedKind.EMERGENCY, AlwaysAllowed.kind(it, android), "'$it'") }
            forms988.forEach { assertEquals(AlwaysAllowedKind.CRISIS_988, AlwaysAllowed.kind(it, android), "'$it'") }
        }
    }

    @Test
    fun `the Lifeline's older number counts as 988, however it's written`() {
        val forms = listOf("+18002738255", "+1 (800) 273-8255", "1-800-273-8255", "18002738255", "(800) 273-8255", "800.273.8255", "8002738255,1")
        for (android in androids) {
            forms.forEach { assertEquals(AlwaysAllowedKind.CRISIS_988, AlwaysAllowed.kind(it, android), "'$it'") }
        }
        // Its neighbors are ordinary numbers.
        assertNull(AlwaysAllowed.kind("+18002738256", us))
        assertNull(AlwaysAllowed.kind("8002738254", us))
    }

    @Test
    fun `every number Android reports as an emergency number works, as Android reports it`() {
        assertTrue(AlwaysAllowed.allows("112", us))
        assertTrue(AlwaysAllowed.allows("999", uk))
        assertTrue(AlwaysAllowed.allows("9 9 9", uk), "formatting doesn't hide one")
        assertFalse(AlwaysAllowed.allows("999", us), "999 isn't one on a US SIM")
        // The seam gets the dialable form.
        val asked = mutableListOf<String>()
        AlwaysAllowed.kind("(1) 12", EmergencyNumbers { asked += it; it == "112" })
        assertEquals(listOf("112"), asked)
    }

    @Test
    fun `when Android can't say, its own no-SIM list counts`() {
        for (android in listOf(cantSay, throws)) {
            for (number in AlwaysAllowed.WHEN_ANDROID_CANT_SAY) assertTrue(AlwaysAllowed.allows(number, android), number)
            assertFalse(AlwaysAllowed.allows("+15555550100", android))
            assertFalse(AlwaysAllowed.allows("411", android))
        }
        // When Android can say, it decides (beyond 911 and 988).
        assertFalse(AlwaysAllowed.allows("000", us))
    }

    @Test
    fun `911 and 988 dialed with a caller-id code before them always work too`() {
        val emergency = listOf("*67911", "*67 911", "*82 911", "#31#911", "*31#911", "*272911", "*67*82911", "*67911,1")
        val crisis = listOf("*67988", "#31#988", "*82(988)", "*67 1-800-273-8255", "*6718002738255", "*67 800 273 8255", "#31#+18002738255")
        for (android in androids) {
            emergency.forEach { assertEquals(AlwaysAllowedKind.EMERGENCY, AlwaysAllowed.dialed(it, android), "'$it'") }
            crisis.forEach { assertEquals(AlwaysAllowedKind.CRISIS_988, AlwaysAllowed.dialed(it, android), "'$it'") }
            (emergency + crisis).forEach { assertTrue(AlwaysAllowed.opensCallbackWindow(it, android), "'$it'") }
            // kind is what Android itself sees: the whole string, an ordinary number (platform notes T17).
            (emergency + crisis).forEach { assertNull(AlwaysAllowed.kind(it, android), "'$it'") }
        }
        // Android's own emergency numbers, after a code.
        assertEquals(AlwaysAllowedKind.EMERGENCY, AlwaysAllowed.dialed("*67999", uk))
        assertNull(AlwaysAllowed.dialed("*67999", us))
        // Not after something that isn't a code, and not with digits after them.
        for (n in listOf("*6911", "**67911", "*679115", "67911", "+67911", "*67", "#31#", "##31#911")) {
            assertNull(AlwaysAllowed.dialed(n, us), "'$n'")
        }
    }

    @Test
    fun `ordinary numbers and no number aren't always allowed`() {
        for (android in androids) {
            assertNull(AlwaysAllowed.kind(null, android))
            assertNull(AlwaysAllowed.kind("", android))
            assertNull(AlwaysAllowed.kind("   ", android))
            assertNull(AlwaysAllowed.kind("+15555550123", android))
            // Not 988 or 911, though they contain them.
            assertNull(AlwaysAllowed.kind("+1988", android))
            assertNull(AlwaysAllowed.kind("9888", android))
            assertNull(AlwaysAllowed.kind("19115", android))
        }
    }
}
