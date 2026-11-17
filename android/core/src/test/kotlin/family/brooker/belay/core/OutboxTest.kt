package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OutboxTest {
    private fun event(id: Long, bytes: Int = 400) = OutboxItem(id, OutboxType.EVENT, bytes)
    private fun snapshot(id: Long) = OutboxItem(id, OutboxType.SNAPSHOT, 200_000)
    private fun request(id: Long, bytes: Int = 300) = OutboxItem(id, OutboxType.REQUEST, bytes)

    /** A fake server: records each request's ids and answers with [answer]. */
    private class Server(val answer: (List<OutboxItem>) -> Verdict = { Verdict.Sent }) {
        val requests = mutableListOf<List<Long>>()
        fun send(batch: List<OutboxItem>): Verdict {
            requests += batch.map { it.id }
            return answer(batch)
        }
    }

    // The protocol's error table.

    @Test
    fun `success is sent`() {
        assertEquals(Verdict.Sent, OutboxPolicy.verdict(200, null, items = 3))
    }

    @Test
    fun `an invalid or too large batch is split, and a single item dropped`() {
        assertIs<Verdict.Split>(OutboxPolicy.verdict(400, "invalid_request", items = 2))
        assertIs<Verdict.Split>(OutboxPolicy.verdict(413, "too_large", items = 40))
        assertEquals(Verdict.Drop("HTTP 400 invalid_request"), OutboxPolicy.verdict(400, "invalid_request", items = 1))
        assertIs<Verdict.Drop>(OutboxPolicy.verdict(413, "too_large", items = 1))
    }

    @Test
    fun `only invalid_token disconnects the phone`() {
        assertIs<Verdict.Disconnect>(OutboxPolicy.verdict(401, "invalid_token", items = 1))
        // A 401 from something in front of the server isn't the parent removing the phone.
        assertIs<Verdict.Retry>(OutboxPolicy.verdict(401, null, items = 1))
    }

    @Test
    fun `rate limits, server errors and the unexpected are retried`() {
        assertEquals(Verdict.Retry("HTTP 429 rate_limited", 120_000), OutboxPolicy.verdict(429, "rate_limited", 5, 120_000))
        assertEquals(Verdict.Retry("HTTP 503", null), OutboxPolicy.verdict(503, null, 5))
        assertIs<Verdict.Retry>(OutboxPolicy.verdict(404, null, 5))
    }

    // Backoff and Retry-After.

    @Test
    fun `backoff doubles from 30 seconds, with jitter in the upper half`() {
        assertEquals(15_000L, OutboxPolicy.backoffMs(1, random = 0.0))
        assertEquals(30_000L, OutboxPolicy.backoffMs(1, random = 1.0))
        assertEquals(60_000L, OutboxPolicy.backoffMs(2, random = 1.0))
        assertEquals(120_000L, OutboxPolicy.backoffMs(3, random = 1.0))
        val samples = (0..10).map { OutboxPolicy.backoffMs(4, random = it / 10.0) }
        assertTrue(samples.all { it in 120_000L..240_000L })
        assertEquals(samples, samples.sorted())
    }

    @Test
    fun `backoff stops growing at an hour`() {
        assertEquals(OutboxPolicy.BACKOFF_MAX_MS, OutboxPolicy.backoffMs(9, random = 1.0))
        assertEquals(OutboxPolicy.BACKOFF_MAX_MS, OutboxPolicy.backoffMs(10_000, random = 1.0))
        assertEquals(OutboxPolicy.BACKOFF_MAX_MS / 2, OutboxPolicy.backoffMs(10_000, random = 0.0))
        assertEquals(15_000L, OutboxPolicy.backoffMs(0, random = 0.0), "no attempt yet counts as the first")
    }

    @Test
    fun `Retry-After is read as seconds or as a date`() {
        assertEquals(120_000L, OutboxPolicy.retryAfterMs("120", T0))
        assertEquals(5_000L, OutboxPolicy.retryAfterMs(" 5 ", T0))
        val date = DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.ofEpochMilli(T0 + 90_000).atOffset(ZoneOffset.UTC))
        assertEquals(90_000L, OutboxPolicy.retryAfterMs(date, T0))
        val past = DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.ofEpochMilli(T0 - HOUR).atOffset(ZoneOffset.UTC))
        assertEquals(0L, OutboxPolicy.retryAfterMs(past, T0))
    }

    @Test
    fun `a retry waits for Retry-After, and never less than the backoff`() {
        assertEquals(120_000L, OutboxPolicy.retryWaitMs(attempts = 1, retryAfterMs = 120_000, random = 1.0))
        assertEquals(30_000L, OutboxPolicy.retryWaitMs(attempts = 1, retryAfterMs = 0, random = 1.0), "Retry-After: 0")
        assertEquals(60_000L, OutboxPolicy.retryWaitMs(attempts = 2, retryAfterMs = null, random = 1.0))
    }

    @Test
    fun `the outbox waits out a backoff, but not a clock that went back`() {
        assertNull(OutboxPolicy.waitMs(nextAttemptAt = 0, now = T0), "never failed: due")
        assertNull(OutboxPolicy.waitMs(nextAttemptAt = T0, now = T0))
        assertEquals(30_000L, OutboxPolicy.waitMs(nextAttemptAt = T0 + 30_000, now = T0))
        assertEquals(OutboxPolicy.MAX_RETRY_AFTER_MS, OutboxPolicy.waitMs(T0 + OutboxPolicy.MAX_RETRY_AFTER_MS, T0))
        assertNull(OutboxPolicy.waitMs(nextAttemptAt = T0 + 3 * 24 * HOUR, now = T0), "longer than any wait: the clock moved")
    }

    @Test
    fun `an unreadable Retry-After is ignored, and a huge one capped`() {
        assertNull(OutboxPolicy.retryAfterMs(null, T0))
        assertNull(OutboxPolicy.retryAfterMs("", T0))
        assertNull(OutboxPolicy.retryAfterMs("soon", T0))
        assertNull(OutboxPolicy.retryAfterMs("-3", T0))
        assertEquals(OutboxPolicy.MAX_RETRY_AFTER_MS, OutboxPolicy.retryAfterMs("99999999999", T0))
    }

    // Batches.

    @Test
    fun `events go together up to the server's count limit`() {
        val queue = (1L..1500L).map { event(it, bytes = 100) }
        assertEquals(WireLimits.MAX_EVENTS_PER_REQUEST, OutboxPolicy.batchSize(queue))
        assertEquals(500, OutboxPolicy.batchSize(queue, from = 1000))
    }

    @Test
    fun `events go together up to the size limit, but a big one still goes alone`() {
        val queue = (1L..10L).map { event(it, bytes = 1000) }
        // 13 bytes of wrapper, then 1000 bytes per event and a comma between them.
        assertEquals(3, OutboxPolicy.batchSize(queue, maxBytes = 13 + 3 * 1000 + 2))
        assertEquals(2, OutboxPolicy.batchSize(queue, maxBytes = 13 + 3 * 1000 + 1))
        assertEquals(1, OutboxPolicy.batchSize(listOf(event(1, bytes = 1_000_000))))
    }

    @Test
    fun `a snapshot goes alone, and a batch of events stops before one`() {
        val queue = listOf(event(1), event(2), snapshot(3), event(4))
        assertEquals(2, OutboxPolicy.batchSize(queue, from = 0))
        assertEquals(1, OutboxPolicy.batchSize(queue, from = 2))
        assertEquals(1, OutboxPolicy.batchSize(queue, from = 3))
    }

    @Test
    fun `requests go together up to their own limits, and never with events`() {
        val requests = (1L..150L).map { request(it) }
        assertEquals(WireLimits.MAX_REQUESTS_PER_REQUEST, OutboxPolicy.batchSize(requests))
        val mixed = listOf(event(1), request(2), request(3), event(4))
        assertEquals(1, OutboxPolicy.batchSize(mixed, from = 0))
        assertEquals(2, OutboxPolicy.batchSize(mixed, from = 1))
        // 15 bytes of wrapper, then the requests and the commas between them.
        val big = (1L..3L).map { request(it, bytes = 40_000) }
        assertEquals(2, OutboxPolicy.batchSize(big))
        assertTrue(15 + 2 * 40_000 + 1 <= OutboxPolicy.MAX_REQUESTS_BODY_BYTES)
    }

    @Test
    fun `a request for a new app goes after the event that reported its install`() {
        val server = Server()
        OutboxDrain.run(listOf(event(1), request(2), snapshot(3), request(4)), send = server::send)
        assertEquals(listOf(listOf(1L), listOf(2L), listOf(3L), listOf(4L)), server.requests)
    }

    // The drain: nothing overtakes anything older.

    @Test
    fun `everything goes in the order it was made, inventories between the events around them`() {
        val server = Server()
        val result = OutboxDrain.run(listOf(event(1), event(2), snapshot(3), event(4), event(5)), send = server::send)
        assertEquals(listOf(listOf(1L, 2L), listOf(3L), listOf(4L, 5L)), server.requests)
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), result.sent)
        assertNull(result.stop)
    }

    @Test
    fun `an inventory waits behind earlier events that can't go yet`() {
        val server = Server { batch ->
            if (batch.any { it.type == OutboxType.EVENT }) Verdict.Retry("HTTP 503") else Verdict.Sent
        }
        val result = OutboxDrain.run(listOf(event(1), event(2), snapshot(3), event(4)), send = server::send)
        assertEquals(listOf(listOf(1L, 2L)), server.requests, "the snapshot was never sent")
        assertEquals(OutboxDrain.Stop.Retry(listOf(1L, 2L), "HTTP 503", null), result.stop)
        assertTrue(result.sent.isEmpty())
    }

    @Test
    fun `events found after an inventory wait for it`() {
        val server = Server { batch ->
            if (batch.single().type == OutboxType.SNAPSHOT) Verdict.Retry("HTTP 429 rate_limited", 60_000) else Verdict.Sent
        }
        val result = OutboxDrain.run(listOf(snapshot(1), event(2), event(3)), send = server::send)
        assertEquals(listOf(listOf(1L)), server.requests)
        assertEquals(OutboxDrain.Stop.Retry(listOf(1L), "HTTP 429 rate_limited", 60_000), result.stop)
    }

    @Test
    fun `a bad event is found by splitting, dropped alone, and the rest still go in order`() {
        val bad = 6L
        val server = Server { batch ->
            if (batch.any { it.id == bad }) OutboxPolicy.verdict(400, "invalid_request", batch.size) else Verdict.Sent
        }
        val result = OutboxDrain.run((1L..8L).map { event(it) }, send = server::send)
        assertEquals((1L..8L).filter { it != bad }, result.sent)
        assertEquals(listOf(OutboxDrain.Dropped(bad, "HTTP 400 invalid_request")), result.dropped)
        assertNull(result.stop)
        // Every accepted request was older than the next one: the order held through the splits.
        val accepted = server.requests.filter { bad !in it }.flatten()
        assertEquals(accepted.sorted(), accepted)
    }

    @Test
    fun `an inventory too large to send is dropped, and what comes after still goes`() {
        val server = Server { batch ->
            if (batch.single().type == OutboxType.SNAPSHOT) OutboxPolicy.verdict(413, "too_large", 1) else Verdict.Sent
        }
        val result = OutboxDrain.run(listOf(snapshot(1), event(2)), send = server::send)
        assertEquals(listOf(OutboxDrain.Dropped(1, "HTTP 413 too_large")), result.dropped)
        assertEquals(listOf(2L), result.sent)
    }

    @Test
    fun `a disconnect stops everything`() {
        val server = Server { Verdict.Disconnect("HTTP 401 invalid_token") }
        val result = OutboxDrain.run(listOf(event(1), snapshot(2)), send = server::send)
        assertEquals(OutboxDrain.Stop.Disconnect("HTTP 401 invalid_token"), result.stop)
        assertEquals(1, server.requests.size)
    }

    @Test
    fun `one run makes a limited number of requests`() {
        val server = Server()
        val queue = listOf(snapshot(1), event(2), snapshot(3), event(4))
        val result = OutboxDrain.run(queue, maxRequests = 2, send = server::send)
        assertEquals(OutboxDrain.Stop.Budget, result.stop)
        assertEquals(listOf(1L, 2L), result.sent)
        assertEquals(2, result.requests)
    }

    @Test
    fun `an empty outbox makes no request`() {
        val server = Server()
        val result = OutboxDrain.run(emptyList(), send = server::send)
        assertTrue(server.requests.isEmpty())
        assertNull(result.stop)
    }

    // Check-ins and the clock.

    @Test
    fun `a check-in is due every two hours`() {
        assertTrue(SyncPolicy.checkinDue(null, T0))
        assertFalse(SyncPolicy.checkinDue(T0, T0 + HOUR))
        assertTrue(SyncPolicy.checkinDue(T0, T0 + 2 * HOUR))
        assertTrue(SyncPolicy.checkinDue(T0, T0 + 2 * HOUR - 5 * 60_000), "a few minutes early is fine")
        assertTrue(SyncPolicy.checkinDue(T0, T0 - HOUR), "the clock went back")
    }

    @Test
    fun `clock skew is the server's time against the middle of the request`() {
        assertEquals(1_000L, SyncPolicy.clockSkewMs(serverTime = T0 + 1_500, sentAt = T0, receivedAt = T0 + 1_000))
        assertEquals(-60_000L, SyncPolicy.clockSkewMs(serverTime = T0, sentAt = T0 + 60_000, receivedAt = T0 + 60_000))
    }
}
