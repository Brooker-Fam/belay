package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PolicyTooLargeTest {
    @Test
    fun `a policy too big to read is a problem with its size, and the long-poll waits longer`() {
        assertEquals(
            "The rules from the server are too big to read (1537 KB). Belay keeps the last rules it could read.",
            PolicyTooLarge.problem(1_573_888),
        )
        assertTrue("(1538 KB)" in PolicyTooLarge.problem(1_573_889), "a part of a KB counts as one")
        assertEquals(
            "The rules from the server are too big to read (more than 1024 KB). Belay keeps the last rules it could read.",
            PolicyTooLarge.problem(null),
        )
        assertTrue(PolicyTooLarge.problem(Long.MAX_VALUE).length <= WireLimits.MAX_PROBLEM)
        assertEquals(PolicyTooLarge.FIRST_WAIT_MS, PolicyTooLarge.retryMs(1, 0.0))
        assertEquals(PolicyTooLarge.MAX_WAIT_MS, PolicyTooLarge.retryMs(20, 1.0))
        assertTrue(PolicyTooLarge.retryMs(1, 1.0) > PolicyRules.pollRetryMs(1, null, 1.0), "longer than the long-poll's usual wait")
    }
}
