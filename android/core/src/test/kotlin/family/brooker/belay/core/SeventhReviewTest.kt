package family.brooker.belay.core

import family.brooker.belay.core.kid.Caregivers
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The seventh security review's probes on the phone (commit c7063d1), turned to assert what holds
 * now. Made-up names only.
 * - J5: a caregiver's name keeps no invisible or format character.
 */
class SeventhReviewTest {
    // ── J5: a caregiver's name, cleaned again on the phone ────────────────────────────────

    @Test
    fun `J5 - every invisible and format character goes from a caregiver's name, and every run of spaces is one`() {
        assertEquals("Grandma", Caregivers.name("Grand\u2060ma"), "a word joiner")
        assertEquals("Coach Lee", Caregivers.name("Coach Lee\u061c"), "an Arabic letter mark")
        assertEquals("Coach Lee", Caregivers.name("Coach\u2028Lee"), "a line separator")
        assertEquals("Aunt Robin", Caregivers.name("Aunt\u00a0\u2003 Robin\u2029"), "no-break and em spaces, a paragraph separator")
        assertEquals("Grandma", Caregivers.name("\ufeffGran\u202ed\u200bma\u00ad"), "a byte-order mark, an override, a zero-width space, a soft hyphen")
        assertEquals("Nana", Caregivers.name("Na\u200dna\uDB40\uDC41"), "a zero-width joiner, and a tag character")
        assertEquals("Grandma", Caregivers.who("Grand\u2060ma"))
    }
}
