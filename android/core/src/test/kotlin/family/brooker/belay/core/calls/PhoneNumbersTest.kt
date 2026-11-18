package family.brooker.belay.core.calls

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Made-up numbers only (555-01xx), and the codes North American and GSM networks take. */
class PhoneNumbersTest {
    @Test
    fun `caller-id codes before a number come off, every way of reading them`() {
        assertEquals(listOf("911", "11"), PhoneNumbers.withoutCodes("*67911"))
        assertEquals(listOf("5555550199", "555550199"), PhoneNumbers.withoutCodes("*67 (555) 555-0199"))
        // GSM's hide and show codes, and their general forms.
        assertEquals(listOf("911"), PhoneNumbers.withoutCodes("#31#911"))
        assertEquals(listOf("#911", "911"), PhoneNumbers.withoutCodes("*31#911"))
        assertEquals(listOf("988"), PhoneNumbers.withoutCodes("#99#988"))
        // A three-digit code reads two ways.
        assertEquals(listOf("2911", "911"), PhoneNumbers.withoutCodes("*272911"))
        // Two codes, and an international number after one ('+' only counts first, so it goes).
        assertTrue("911" in PhoneNumbers.withoutCodes("*67*82911"))
        assertEquals(listOf("15555550199", "5555550199"), PhoneNumbers.withoutCodes("*67+15555550199"))
        // Post-dial digits aren't part of it.
        assertEquals(listOf("911", "11"), PhoneNumbers.withoutCodes("*67911,123"))
    }

    @Test
    fun `no code, or nothing after one, leaves nothing`() {
        for (n in listOf(null, "", "911", "+15555550199", "5555550199", "*6", "*67", "#31#", "**67911", "#3#911", "6*7911")) {
            assertEquals(emptyList(), PhoneNumbers.withoutCodes(n), "'$n'")
        }
    }
}
