package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SimTest {
    private val card = SimSeen(present = true, subscriptionId = 1, carrierId = 1839)
    private val noCard = SimSeen(present = false, subscriptionId = -1, carrierId = -1)

    @Test
    fun `the first sight of the SIM is only noted`() {
        val watch = SimRules.next(SimWatch(), card, T0)
        assertEquals(SimWatch(card), watch)
        assertNull(SimRules.problem(watch, T0))
    }

    @Test
    fun `a different card, or none, is a change reported for a week`() {
        for (other in listOf(card.copy(subscriptionId = 2), card.copy(carrierId = 1), noCard)) {
            val watch = SimRules.next(SimWatch(card), other, T0)
            assertEquals(T0, watch.changedAt)
            assertEquals(SimRules.CHANGED_PROBLEM, SimRules.problem(watch, T0 + 6 * 24 * HOUR))
            assertNull(SimRules.problem(watch, T0 + 7 * 24 * HOUR))
        }
    }

    @Test
    fun `while the SIM is starting up or locked, nothing changes`() {
        val watch = SimWatch(card, changedAt = T0)
        assertEquals(watch, SimRules.next(watch, null, T0 + HOUR))
    }

    @Test
    fun `the same card again changes nothing`() {
        assertEquals(SimWatch(card), SimRules.next(SimWatch(card), card.copy(), T0))
    }

    @Test
    fun `the problem fits the protocol's limit`() {
        assert(SimRules.CHANGED_PROBLEM.length <= WireLimits.MAX_PROBLEM)
    }
}
