package family.brooker.belay.core.calls

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Made-up numbers only (555-01xx), and the caller-id codes North American and GSM networks take. */
class PhoneNumbersTest {
    @Test
    fun `the codes that hide or show the caller's number come off, one or more of them`() {
        assertEquals("911", PhoneNumbers.withoutCodes("*67911"))
        assertEquals("911", PhoneNumbers.withoutCodes("*82 911"))
        assertEquals("5555550199", PhoneNumbers.withoutCodes("*67 (555) 555-0199"))
        // GSM's hide and show codes (TS 22.030's CLIR).
        assertEquals("911", PhoneNumbers.withoutCodes("#31#911"))
        assertEquals("911", PhoneNumbers.withoutCodes("*31#911"))
        // Two or more, in any order, and an international number after one ('+' only counts first, so it goes).
        assertEquals("911", PhoneNumbers.withoutCodes("*67*82911"))
        assertEquals("988", PhoneNumbers.withoutCodes("#31#*67988"))
        assertEquals("911", PhoneNumbers.withoutCodes("*31#*67911"))
        assertEquals("911", PhoneNumbers.withoutCodes("*67*67*67*67911"))
        assertEquals("15555550199", PhoneNumbers.withoutCodes("*67+15555550199"))
        // Post-dial digits aren't part of it.
        assertEquals("911", PhoneNumbers.withoutCodes("*67911,123"))
    }

    @Test
    fun `no other code comes off, and none that reads as another code`() {
        // Three-digit codes, and two-digit ones that don't hide or show the number.
        for (n in listOf("*272911", "*2725555550199", "*611", "*228", "*69911", "#99#988", "*21#911")) {
            assertNull(PhoneNumbers.withoutCodes(n), "'$n'")
        }
        // The digit after *67 stays the number's ("*67 1911" is 1911, never 911).
        assertEquals("1911", PhoneNumbers.withoutCodes("*671911"))
        assertEquals("2911", PhoneNumbers.withoutCodes("*822911"))
        assertEquals("9112", PhoneNumbers.withoutCodes("*679112"))
        // *67 and *82 followed by what makes the string a supplementary service code ("*67#" is
        // call forwarding's, to GSM): Android reads that code, so neither it nor what follows comes off.
        for (n in listOf("*67#911", "*67#31#988", "*67*31#988", "*679#911", "*82#911", "*67*82#911")) {
            assertNull(PhoneNumbers.withoutCodes(n), "'$n'")
        }
        // A code after one that stays: "#31#" then "*67#911" keeps *67's '#'.
        assertEquals("*67#911", PhoneNumbers.withoutCodes("#31#*67#911"))
    }

    @Test
    fun `no code, or nothing after one, leaves nothing`() {
        for (n in listOf(null, "", "911", "+15555550199", "5555550199", "*6", "*67", "#31#", "*67#31#", "**67911", "#3#911", "6*7911", "*31911", "#31911")) {
            assertNull(PhoneNumbers.withoutCodes(n), "'$n'")
        }
    }
}
