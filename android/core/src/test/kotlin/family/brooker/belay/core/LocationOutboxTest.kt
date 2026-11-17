package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Phase 4: fixes and place events in the outbox. */
class LocationOutboxTest {
    private fun fix(id: Long, bytes: Int = 220) = OutboxItem(id, OutboxType.FIX, bytes)
    private fun placeEvent(id: Long, bytes: Int = 120) = OutboxItem(id, OutboxType.PLACE_EVENT, bytes)
    private fun event(id: Long) = OutboxItem(id, OutboxType.EVENT, 400)
    private fun usage(id: Long) = OutboxItem(id, OutboxType.USAGE, 2_000)

    private class Server(val answer: (List<OutboxItem>) -> Verdict = { Verdict.Sent }) {
        val requests = mutableListOf<List<Long>>()
        fun send(batch: List<OutboxItem>): Verdict {
            requests += batch.map { it.id }
            return answer(batch)
        }
    }

    @Test
    fun `fixes and place events share a lane of their own`() {
        assertEquals(2, OutboxPolicy.lane(OutboxType.FIX))
        assertEquals(2, OutboxPolicy.lane(OutboxType.PLACE_EVENT))
        assertEquals(1, OutboxPolicy.lane(OutboxType.USAGE))
        assertEquals(0, OutboxPolicy.lane(OutboxType.REQUEST))
    }

    @Test
    fun `fixes and the place events after them go in one request, up to 200`() {
        val queue = listOf(fix(1), fix(2), placeEvent(3), fix(4))
        assertEquals(4, OutboxPolicy.batchSize(queue))
        val many = (1L..250L).map { fix(it) }
        assertEquals(200, OutboxPolicy.batchSize(many))
        assertEquals(50, OutboxPolicy.batchSize(many, from = 200))
    }

    @Test
    fun `a batch of fixes stays under 48 KB, which is under the server's 64 KB`() {
        val big = (1L..100L).map { fix(it, bytes = 1_000) }
        val size = OutboxPolicy.batchSize(big)
        assertTrue(OutboxPolicy.LOCATIONS_WRAPPER_BYTES + size * 1_001 <= OutboxPolicy.MAX_LOCATIONS_BODY_BYTES)
        assertTrue(size < 100)
        assertTrue(OutboxPolicy.MAX_LOCATIONS_BODY_BYTES < 64 * 1024)
    }

    @Test
    fun `a server without POST locations holds back only the location lane`() {
        val notFound = OutboxPolicy.verdict(404, "not_found", items = 2)
        val lanes = listOf(event(1), fix(2), usage(3), placeEvent(4)).groupBy { OutboxPolicy.lane(it.type) }
        val main = Server()
        val usageLane = Server()
        val locations = Server { notFound }
        assertNull(OutboxDrain.run(lanes.getValue(0), send = main::send).stop)
        assertNull(OutboxDrain.run(lanes.getValue(1), send = usageLane::send).stop)
        assertIs<OutboxDrain.Stop.Retry>(OutboxDrain.run(lanes.getValue(2), send = locations::send).stop)
        assertEquals(listOf(listOf(2L, 4L)), locations.requests, "one request, the fix before the event that names it")
    }
}
