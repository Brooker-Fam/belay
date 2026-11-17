package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class EnrollmentTest {
    @Test
    fun `codes are normalized the way people type them`() {
        assertEquals("7KQ2M9XA", Enrollment.normalizeCode("7kq2-m9xa"))
        assertEquals("7KQ2M9XA", Enrollment.normalizeCode(" 7KQ2 M9XA "))
        assertEquals("11002345", Enrollment.normalizeCode("ILO02345"), "I and L read as 1, O as 0")
    }

    @Test
    fun `codes that can't be codes are refused`() {
        assertNull(Enrollment.normalizeCode("7KQ2M9X"), "too short")
        assertNull(Enrollment.normalizeCode("7KQ2M9XAB"), "too long")
        assertNull(Enrollment.normalizeCode("7KQ2M9XU"), "U isn't Crockford base32")
        assertNull(Enrollment.normalizeCode("7KQ2M9X!"))
    }

    @Test
    fun `servers are normalized to an https origin`() {
        assertEquals("https://belay.example.org", Enrollment.normalizeServer("Belay.Example.org/"))
        assertEquals("https://belay.example.org:8443", Enrollment.normalizeServer("https://belay.example.org:8443"))
    }

    @Test
    fun `plain http only for hosts allowed to use it`() {
        assertNull(Enrollment.normalizeServer("http://belay.example.org"))
        assertEquals("http://10.0.2.2:8080", Enrollment.normalizeServer("http://10.0.2.2:8080", setOf("10.0.2.2")))
    }

    @Test
    fun `servers with paths, credentials or queries are refused`() {
        assertNull(Enrollment.normalizeServer("https://belay.example.org/api"))
        assertNull(Enrollment.normalizeServer("https://user:pw@belay.example.org"))
        assertNull(Enrollment.normalizeServer("https://belay.example.org?x=1"))
        assertNull(Enrollment.normalizeServer("ftp://belay.example.org"))
        assertNull(Enrollment.normalizeServer(""))
    }

    @Test
    fun `the QR link parses`() {
        assertEquals(
            EnrollTarget("https://belay.example.org", "7KQ2M9XA"),
            Enrollment.parseLink("belay://enroll?server=https%3A%2F%2Fbelay.example.org&code=7kq2m9xa"),
        )
    }

    @Test
    fun `the server's answers become problems the screen can explain`() {
        assertEquals(EnrollProblem.CODE_REFUSED, Enrollment.problemFor(400, "invalid_code"))
        assertEquals(EnrollProblem.REFUSED, Enrollment.problemFor(400, "invalid_request"))
        assertEquals(EnrollProblem.RATE_LIMITED, Enrollment.problemFor(429, "rate_limited"))
        assertEquals(EnrollProblem.SERVER_ERROR, Enrollment.problemFor(502, null))
        assertEquals(EnrollProblem.NOT_BELAY, Enrollment.problemFor(404, null))
        assertEquals(EnrollProblem.NOT_BELAY, Enrollment.problemFor(403, null), "no Belay error code: something else answered")
        assertEquals("invalid_code", EnrollProblem.CODE_REFUSED.code)
    }

    @Test
    fun `other links don't`() {
        assertNull(Enrollment.parseLink("https://belay.example.org/enroll?code=7KQ2M9XA"))
        assertNull(Enrollment.parseLink("belay://enroll?server=https%3A%2F%2Fbelay.example.org"))
        assertNull(Enrollment.parseLink("belay://enroll?server=http%3A%2F%2Fevil.example&code=7KQ2M9XA"))
        assertNull(Enrollment.parseLink("not a link"))
    }
}
