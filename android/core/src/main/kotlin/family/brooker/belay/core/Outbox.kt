package family.brooker.belay.core

import family.brooker.belay.core.screentime.UsageReport
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * What the outbox holds: app events, inventory snapshots, the kid's requests (Phase 2), usage
 * days (Phase 3), fixes and place events (Phase 4), and call records (Phase 5). Usage goes in a
 * lane of its own ([OutboxPolicy.lane]): each day replaces the server's, so it needs no order, and
 * a server without `POST /usage` yet must not hold back anything else. Fixes and place events share
 * a third lane, for the same reason (`POST /locations`, idempotent by each item's id); a place event
 * goes after the fix it names. Call records have a fourth (`POST /calls`, idempotent by id), so a
 * server from before Phase 5 (404, tried again later) holds back nothing else.
 */
enum class OutboxType { EVENT, SNAPSHOT, REQUEST, USAGE, FIX, PLACE_EVENT, CALL }

/**
 * One item waiting to be sent. [id]s grow in the order the agent made the items, and
 * [bytes] is the size of its JSON payload (UTF-8).
 */
data class OutboxItem(val id: Long, val type: OutboxType, val bytes: Int)

/** What the agent does with the server's answer to one request (docs/protocol.md, "Errors"). */
sealed interface Verdict {
    /** Accepted, or the server already had it: done. */
    data object Sent : Verdict

    /** Too large, or refused as invalid, with more than one item in it: send each half. */
    data class Split(val reason: String) : Verdict

    /** Refused on its own: it would only fail again, so it is dropped and the reason kept. */
    data class Drop(val reason: String) : Verdict

    /** Not now: try again after [afterMs] (the server's Retry-After), or after a backoff. */
    data class Retry(val reason: String, val afterMs: Long? = null) : Verdict

    /** The server no longer accepts this phone's token (the parent removed it): stop syncing. */
    data class Disconnect(val reason: String) : Verdict
}

object OutboxPolicy {
    /** Beyond this many unsent events, the oldest go: the next inventory still shows the result. */
    const val MAX_PENDING_EVENTS = 5000

    /** Sent and dropped items are kept a while, for the screen and for tests, then deleted. */
    const val KEEP_FINISHED_MS = 7L * 24 * 60 * 60 * 1000
    const val MAX_FINISHED = 1000

    /** Well under the server's 512 KB limit for `POST /api/v1/events`. */
    const val MAX_EVENTS_BODY_BYTES = 384 * 1024

    /** `{"events":[` and `]}` around the comma-separated events. */
    const val EVENTS_WRAPPER_BYTES = 13

    /** Well under the server's 128 KB limit for `POST /api/v1/requests`. */
    const val MAX_REQUESTS_BODY_BYTES = 96 * 1024

    /** `{"requests":[` and `]}` around the comma-separated requests. */
    const val REQUESTS_WRAPPER_BYTES = 15

    /** Phase 3: well under the server's 256 KB limit for `POST /api/v1/usage`. */
    const val MAX_USAGE_BODY_BYTES = UsageReport.MAX_BODY_BYTES

    /** `{"days":[` and `]}` around the comma-separated days. */
    const val USAGE_WRAPPER_BYTES = 11

    /** The server takes at most 31 days in one request. */
    const val MAX_USAGE_DAYS_PER_REQUEST = 31

    /** Unsent usage days kept: one per day, the newest; older ones give way. */
    const val MAX_PENDING_USAGE = 31

    /** Phase 4: well under the server's 64 KB limit for `POST /api/v1/locations`. */
    const val MAX_LOCATIONS_BODY_BYTES = 48 * 1024

    /** `{"fixes":[`, `],"place_events":[` and `]}` around the two comma-separated lists. */
    const val LOCATIONS_WRAPPER_BYTES = 31

    /** The server takes at most 200 fixes and 200 place events in one request: 200 in all is always within both. */
    const val MAX_LOCATIONS_PER_REQUEST = 200

    /**
     * Unsent fixes and place events kept, the newest; older ones give way. Lost mode makes one
     * every 5 minutes: a week offline is about 2000.
     */
    const val MAX_PENDING_LOCATIONS = 2000

    /** Phase 5: well under the server's 128 KB limit for `POST /api/v1/calls`. */
    const val MAX_CALLS_BODY_BYTES = 96 * 1024

    /** `{"calls":[` and `]}` around the comma-separated records. */
    const val CALLS_WRAPPER_BYTES = 12

    /** The server takes at most 500 records in one request. */
    const val MAX_CALLS_PER_REQUEST = 500

    /** Unsent call records kept, the newest; older ones give way (weeks of calls offline). */
    const val MAX_PENDING_CALLS = 2000

    /**
     * The lanes the outbox is sent in: everything in order, then usage on its own (Phase 3), then
     * fixes and place events (Phase 4), then call records (Phase 5). A failure in one holds back
     * only the rest of that lane.
     */
    fun lane(type: OutboxType): Int = when (type) {
        OutboxType.USAGE -> 1
        OutboxType.FIX, OutboxType.PLACE_EVENT -> 2
        OutboxType.CALL -> 3
        else -> 0
    }

    /** Fixes and place events go in the same request; every other type in requests of its own. */
    private fun batchKind(type: OutboxType): OutboxType = if (type == OutboxType.PLACE_EVENT) OutboxType.FIX else type

    const val BACKOFF_FIRST_MS = 30_000L
    const val BACKOFF_MAX_MS = 60L * 60 * 1000
    const val MAX_RETRY_AFTER_MS = 24L * 60 * 60 * 1000

    /** Requests one sync run may make, so splitting a bad batch can't turn into a storm. */
    const val MAX_REQUESTS_PER_RUN = 64

    /**
     * The protocol's table: 400 `invalid_request` and 413 split a batch until the item at
     * fault is alone, then drop it; 401 `invalid_token` disconnects; 429 waits for
     * Retry-After; 5xx retries with backoff. Anything else (a proxy's 401, a 404 while the
     * server is being upgraded) is retried too: waiting loses nothing.
     */
    fun verdict(status: Int, error: String?, items: Int, retryAfterMs: Long? = null): Verdict {
        val what = if (error.isNullOrBlank()) "HTTP $status" else "HTTP $status $error"
        return when {
            status in 200..299 -> Verdict.Sent
            status == 401 && error == "invalid_token" -> Verdict.Disconnect(what)
            status == 400 || status == 413 -> if (items > 1) Verdict.Split(what) else Verdict.Drop(what)
            else -> Verdict.Retry(what, retryAfterMs)
        }
    }

    /**
     * The wait after the [attempts]-th failure in a row (1, 2, ...): doubling from 30 s up
     * to an hour, at a random point ([random] in 0..1) in the upper half, so retries spread out.
     */
    fun backoffMs(attempts: Int, random: Double): Long {
        val doublings = (attempts.coerceAtLeast(1) - 1).coerceAtMost(20)
        val ceiling = (BACKOFF_FIRST_MS shl doublings).coerceAtMost(BACKOFF_MAX_MS)
        val half = ceiling / 2
        return half + (half * random.coerceIn(0.0, 1.0)).toLong()
    }

    /**
     * The wait after the [attempts]-th failure in a row: never sooner than the server asked
     * ([retryAfterMs], from Retry-After), and never sooner than the backoff, so a
     * "Retry-After: 0" can't turn into a loop.
     */
    fun retryWaitMs(attempts: Int, retryAfterMs: Long?, random: Double): Long =
        maxOf(retryAfterMs ?: 0, backoffMs(attempts, random))

    /**
     * How long the head of the outbox (and so everything behind it) still waits after a
     * failure, or null when it may go now. A wait longer than any backoff or Retry-After
     * means the phone's clock went back: it goes now rather than wait for the clock.
     */
    fun waitMs(nextAttemptAt: Long, now: Long): Long? {
        val wait = nextAttemptAt - now
        return if (wait <= 0 || wait > MAX_RETRY_AFTER_MS) null else wait
    }

    /**
     * A Retry-After header in milliseconds from [now]: delay-seconds or an HTTP-date. Null
     * when absent or unreadable; capped at a day.
     */
    fun retryAfterMs(value: String?, now: Long): Long? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        text.toLongOrNull()?.let { seconds ->
            return if (seconds < 0) null else seconds.coerceAtMost(MAX_RETRY_AFTER_MS / 1000) * 1000
        }
        val at = try {
            ZonedDateTime.parse(text, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
        } catch (e: DateTimeParseException) {
            return null
        }
        return (at - now).coerceIn(0, MAX_RETRY_AFTER_MS)
    }

    /**
     * How many items from [from] go in one request. A snapshot goes alone. Events go
     * together up to the server's count limit and [maxBytes], and so do requests, usage
     * days, and fixes with place events (each with their own limits); a batch never mixes kinds
     * (fixes and place events count as one) or passes a snapshot: always at least one item.
     */
    fun batchSize(queue: List<OutboxItem>, from: Int = 0, maxBytes: Int? = null): Int {
        require(from in queue.indices) { "nothing to send" }
        val type = batchKind(queue[from].type)
        if (type == OutboxType.SNAPSHOT) return 1
        val maxCount = when (type) {
            OutboxType.EVENT -> WireLimits.MAX_EVENTS_PER_REQUEST
            OutboxType.USAGE -> MAX_USAGE_DAYS_PER_REQUEST
            OutboxType.FIX -> MAX_LOCATIONS_PER_REQUEST
            OutboxType.CALL -> MAX_CALLS_PER_REQUEST
            else -> WireLimits.MAX_REQUESTS_PER_REQUEST
        }
        val byteLimit = maxBytes ?: when (type) {
            OutboxType.EVENT -> MAX_EVENTS_BODY_BYTES
            OutboxType.USAGE -> MAX_USAGE_BODY_BYTES
            OutboxType.FIX -> MAX_LOCATIONS_BODY_BYTES
            OutboxType.CALL -> MAX_CALLS_BODY_BYTES
            else -> MAX_REQUESTS_BODY_BYTES
        }
        var count = 0
        var bytes = when (type) {
            OutboxType.EVENT -> EVENTS_WRAPPER_BYTES
            OutboxType.USAGE -> USAGE_WRAPPER_BYTES
            OutboxType.FIX -> LOCATIONS_WRAPPER_BYTES
            OutboxType.CALL -> CALLS_WRAPPER_BYTES
            else -> REQUESTS_WRAPPER_BYTES
        }.toLong()
        while (from + count < queue.size && count < maxCount) {
            val item = queue[from + count]
            if (batchKind(item.type) != type) break
            val next = bytes + item.bytes + (if (count > 0) 1 else 0)
            if (count > 0 && next > byteLimit) break
            bytes = next
            count++
        }
        return count
    }
}

/**
 * Sends the outbox in the order the agent made it. The server applies events and
 * inventories in arrival order, and diffs each inventory against what it has, so nothing
 * may overtake anything older: consecutive events go in batches, each snapshot on its own,
 * and an item that can't go now holds back everything after it. A request for a new app
 * goes after the event that reported its install.
 */
object OutboxDrain {
    data class Dropped(val id: Long, val reason: String)

    sealed interface Stop {
        /** [ids] failed; they and everything after them wait. */
        data class Retry(val ids: List<Long>, val reason: String, val afterMs: Long?) : Stop

        data class Disconnect(val reason: String) : Stop

        /** This run's request budget is spent; the rest goes in the next run. */
        data object Budget : Stop
    }

    /** [stop] is null when everything in the queue was sent or dropped. */
    data class Result(val sent: List<Long>, val dropped: List<Dropped>, val stop: Stop?, val requests: Int)

    /** [queue] oldest first. [send] makes one request and says what its answer means. */
    fun run(
        queue: List<OutboxItem>,
        maxRequests: Int = OutboxPolicy.MAX_REQUESTS_PER_RUN,
        send: (List<OutboxItem>) -> Verdict,
    ): Result {
        val sent = mutableListOf<Long>()
        val dropped = mutableListOf<Dropped>()
        // Halves of a split batch, which go before anything newer.
        val halves = ArrayDeque<List<OutboxItem>>()
        var next = 0
        var requests = 0
        while (halves.isNotEmpty() || next < queue.size) {
            if (requests >= maxRequests) return Result(sent, dropped, Stop.Budget, requests)
            val batch = halves.removeFirstOrNull()
                ?: queue.subList(next, next + OutboxPolicy.batchSize(queue, next)).also { next += it.size }
            requests++
            when (val verdict = send(batch)) {
                Verdict.Sent -> batch.mapTo(sent) { it.id }
                is Verdict.Split -> if (batch.size > 1) {
                    halves.addFirst(batch.subList(batch.size / 2, batch.size))
                    halves.addFirst(batch.subList(0, batch.size / 2))
                } else {
                    dropped += Dropped(batch.single().id, verdict.reason)
                }
                is Verdict.Drop -> batch.mapTo(dropped) { Dropped(it.id, verdict.reason) }
                is Verdict.Retry ->
                    return Result(sent, dropped, Stop.Retry(batch.map { it.id }, verdict.reason, verdict.afterMs), requests)
                is Verdict.Disconnect -> return Result(sent, dropped, Stop.Disconnect(verdict.reason), requests)
            }
        }
        return Result(sent, dropped, null, requests)
    }
}

object SyncPolicy {
    const val CHECKIN_INTERVAL_MS = 2L * 60 * 60 * 1000

    /** WorkManager and Doze move runs around a little; a check-in this close to due counts as due. */
    const val CHECKIN_EARLY_MS = 10L * 60 * 1000

    fun checkinDue(lastCheckinAt: Long?, now: Long): Boolean =
        lastCheckinAt == null || now < lastCheckinAt || now - lastCheckinAt >= CHECKIN_INTERVAL_MS - CHECKIN_EARLY_MS

    /** The server's clock minus the phone's, taking the middle of the request as when the server answered. */
    fun clockSkewMs(serverTime: Long, sentAt: Long, receivedAt: Long): Long =
        serverTime - (sentAt + (receivedAt - sentAt) / 2)
}
