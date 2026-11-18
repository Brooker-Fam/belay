package family.brooker.belay.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import family.brooker.belay.core.Checkins
import family.brooker.belay.core.EnrollProblem
import family.brooker.belay.core.OutboxDrain
import family.brooker.belay.core.OutboxItem
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.OutboxType
import family.brooker.belay.core.PolicyTooLarge
import family.brooker.belay.core.SyncPolicy
import family.brooker.belay.core.Verdict
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.network.Domains
import family.brooker.belay.core.network.NetworkDigest
import family.brooker.belay.enroll.Enroller
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.HealthReader
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.settings.TokenVault
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.OutboxRow
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.random.Random

/**
 * Talks to the family's server, on its own thread so network waits never hold up the
 * agent's reconcile thread. Enrollment runs here too, so it never overlaps a sync.
 * Every call is idempotent on the server, so sending again is always safe. The policy
 * long-poll runs on its own thread too ([PolicyPoll]); a check-in's policy is its fallback.
 */
object Sync {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-sync") }
    private val queued = AtomicBoolean(false)

    @Volatile
    private var checkinWanted = false

    @Volatile
    private var dueWanted = false

    /** How one sync run ended. [checkinFailed]: a check-in was due or asked for, and didn't happen. */
    data class Report(val connected: Boolean, val checkinFailed: Boolean = false)

    /**
     * Asks for a sync soon. Requests made while one waits to start join it. [checkin]: check in
     * whether or not one is due; [dueToo]: check in when one is due (core's SyncPolicy.checkinNow),
     * false for a step that only a time passing or a call brought (core's StepCause, the sixth
     * review's G3), whose due check-ins are the workers' to send.
     */
    fun request(context: Context, checkin: Boolean = false, dueToo: Boolean = true) {
        val app = context.applicationContext
        if (checkin) checkinWanted = true
        if (dueToo) dueWanted = true
        if (!queued.compareAndSet(false, true)) return
        executor.execute {
            queued.set(false)
            val checkinNow = checkinWanted
            checkinWanted = false
            val due = dueWanted
            dueWanted = false
            runSafely(app, checkinNow, due)
        }
    }

    /** For WorkManager: one run now, waiting for it (a check-in when one is due, too). Null when it didn't finish in time. */
    fun runAndWait(context: Context, checkin: Boolean, timeoutMs: Long): Report? {
        val app = context.applicationContext
        val run = executor.submit<Report> { runSafely(app, checkin, dueToo = true) }
        return try {
            run.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            null
        } catch (e: ExecutionException) {
            null
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        }
    }

    /**
     * Enrolls with [server] and [code] as typed, scanned or passed over adb, then calls
     * [done] on the sync thread. [replace]: may replace an existing connection (only the
     * adb path, which only the parent can use).
     */
    fun enroll(context: Context, server: String, code: String, replace: Boolean, done: (Enroller.Outcome) -> Unit) {
        val app = context.applicationContext
        executor.execute {
            val outcome = try {
                Enroller(app).enroll(server, code, replace)
            } catch (e: Exception) {
                Log.e(Agent.TAG, "enroll failed", e)
                Enroller.Outcome.Failed(EnrollProblem.PHONE_ERROR, e.javaClass.simpleName)
            }
            done(outcome)
        }
    }

    private fun runSafely(app: Context, checkin: Boolean, dueToo: Boolean): Report = try {
        SyncRun(app).run(checkin, dueToo)
    } catch (t: Exception) {
        Log.e(Agent.TAG, "sync failed", t)
        Report(connected = true, checkinFailed = checkin)
    }

    /**
     * The parent removed this phone on the server (or its token is lost): stop syncing. From
     * the sync thread or the long-poll. The phone keeps enforcing the last policy it got.
     */
    fun disconnect(app: Context, reason: String) {
        Log.w(Agent.TAG, "disconnected from the server: $reason")
        ConnectionStore.disconnected(app, System.currentTimeMillis(), reason)
        SyncWork.stop(app)
    }

    /**
     * A policy from the server, the answer to a request sent at [sentAt]: kept if it replaces
     * the stored one (core's PolicyRules: any other version, unless the request crossed a
     * newer answer), and then applied in an agent step. True when it was new.
     */
    fun received(app: Context, policy: WirePolicy, via: String, sentAt: Long, at: Long): Boolean {
        val store = AgentStore.get(app)
        val readable = readable(app, via, step = false)
        val kept = store.savePolicy(policy, sentAt, at)
        if (kept) Log.i(Agent.TAG, "policy ${policy.version} received ($via)")
        if (kept || readable) Agent.handle(app, Trigger.POLICY)
        return kept
    }

    /**
     * The server's policy answer was too big to read (more than PolicyTooLarge.MAX_BYTES):
     * Belay keeps enforcing the last policy it read, and the next step reports the problem
     * (a check-in carries it). [bytes]: its Content-Length, if the server sent one.
     */
    fun policyTooLarge(app: Context, bytes: Long?, via: String) {
        Log.w(Agent.TAG, "policy too big to read ($via): ${bytes ?: "more than ${PolicyTooLarge.MAX_BYTES}"} bytes; keeping the last policy")
        if (AgentStore.get(app).notePolicyTooLarge(bytes, System.currentTimeMillis())) Agent.handle(app, Trigger.POLICY_UNREADABLE)
    }

    /**
     * A policy answer was read again (or the server has no newer one): the problem goes. True
     * when there was one; with [step], the agent then drops it from the report.
     */
    fun readable(app: Context, via: String, step: Boolean = true): Boolean {
        val was = AgentStore.get(app).clearPolicyTooLarge()
        if (was) {
            Log.i(Agent.TAG, "the server's policy can be read again ($via)")
            if (step) Agent.handle(app, Trigger.POLICY_UNREADABLE)
        }
        return was
    }

    /**
     * A check-in soon, so the parent sees within seconds that a new policy is applied. Calls
     * within [CHECKIN_DEBOUNCE_MS] of each other (several policies in a row) make one.
     */
    fun checkinSoon(context: Context) {
        val app = context.applicationContext
        if (!checkinScheduled.compareAndSet(false, true)) return
        timer.schedule({
            checkinScheduled.set(false)
            request(app, checkin = true)
        }, CHECKIN_DEBOUNCE_MS, TimeUnit.MILLISECONDS)
    }

    private const val CHECKIN_DEBOUNCE_MS = 2_000L
    private val checkinScheduled = AtomicBoolean(false)
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "belay-sync-timer") }

    fun online(app: Context): Boolean {
        val connectivity = app.getSystemService(ConnectivityManager::class.java) ?: return true
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}

/** One pass: check in if asked, or due ([dueToo]: core's SyncPolicy.checkinNow), then the outbox, oldest first. */
private class SyncRun(private val app: Context) {
    private val store = AgentStore.get(app)

    fun run(checkinWanted: Boolean, dueToo: Boolean): Sync.Report {
        val connection = ConnectionStore.read(app)
        if (!connection.connected) return Sync.Report(connected = false)
        val token = TokenVault.decrypt(connection.sealedToken ?: return Sync.Report(connected = false))
        if (token == null) {
            disconnect("the device token can't be read any more")
            return Sync.Report(connected = false)
        }
        val checkinDue = SyncPolicy.checkinNow(checkinWanted, dueToo, connection.lastCheckinAt, System.currentTimeMillis())
        if (!Sync.online(app)) {
            // Not a failure: WorkManager runs the sync once there is a network.
            if (store.pendingCount() > 0) SyncWork.wake(app, 0)
            return Sync.Report(connected = true, checkinFailed = checkinDue)
        }
        val api = DeviceApi(requireNotNull(connection.server))
        var checkinFailed = false
        if (checkinDue) {
            when (val verdict = checkin(api, token)) {
                Verdict.Sent -> {}
                is Verdict.Disconnect -> {
                    disconnect(verdict.reason)
                    return Sync.Report(connected = false)
                }
                else -> {
                    checkinFailed = true
                    Log.w(Agent.TAG, "check-in failed: $verdict")
                    ConnectionStore.failed(app, System.currentTimeMillis(), "check-in: ${reason(verdict)}")
                }
            }
        }
        val connected = drain(api, token)
        store.pruneFinished(System.currentTimeMillis())
        return Sync.Report(connected = connected, checkinFailed = checkinFailed)
    }

    private fun checkin(api: DeviceApi, token: String): Verdict {
        val device = DeviceStatus.read(app, HealthReader(app).read())
        // Under the server's 32 KB, whatever the lists hold (core's Checkins).
        val request = Checkins.fit(device)
        if (request.status != device) Log.w(Agent.TAG, "check-in trimmed to ${Checkins.bytes(request)} bytes")
        return when (val answer = api.checkin(token, request)) {
            is DeviceApi.Answer.Ok -> {
                val skew = SyncPolicy.clockSkewMs(answer.body.serverTime, answer.sentAt, answer.receivedAt)
                ConnectionStore.synced(app, answer.receivedAt, skew, checkin = true)
                Log.i(Agent.TAG, "checked in (clock skew ${skew / 1000} s)")
                // The long-poll's fallback: the answer carries the server's current policy.
                try {
                    Sync.received(app, answer.body.policy, "check-in", sentAt = answer.sentAt, at = answer.receivedAt)
                } catch (e: RuntimeException) {
                    Log.e(Agent.TAG, "the check-in's policy couldn't be stored", e)
                }
                Verdict.Sent
            }
            is DeviceApi.Answer.Refused -> verdictFor(answer, items = 1)
            is DeviceApi.Answer.Failed -> {
                val tooLarge = answer.tooLarge
                if (tooLarge != null) {
                    // The server stored the status before it answered: the check-in went out.
                    // Belay keeps the last policy it read, and reports this one.
                    ConnectionStore.synced(app, System.currentTimeMillis(), null, checkin = true)
                    Sync.policyTooLarge(app, tooLarge.bytes, "check-in")
                    Verdict.Sent
                } else {
                    Verdict.Retry(answer.reason)
                }
            }
        }
    }

    /**
     * Sends what waits, strictly in order (OutboxDrain): the server applies events and
     * inventories as they arrive. Usage days (Phase 3) go in a lane of their own after it,
     * fixes and place events (Phase 4) in a third, call records (Phase 5) in a fourth, and network
     * days (Phase 3's network logging) in a fifth, so a server without `POST /usage`,
     * `POST /locations`, `POST /calls` or `POST /network` yet (it answers 404, which waits and tries
     * again) holds back nothing else. Returns false if the server disconnected the phone.
     */
    private fun drain(api: DeviceApi, token: String): Boolean {
        val queue = store.queue()
        if (queue.isEmpty()) return true
        val lanes = queue.map { OutboxItem(it.id, typeOf(it.type), it.bytes) to it.nextAttemptAt }
            .groupBy { OutboxPolicy.lane(it.first.type) }
            .toSortedMap()
        // The soonest wake any lane asks for; one wake covers both (a newer wake replaces the last).
        var wakeIn: Long? = null
        for ((lane, items) in lanes) {
            when (val outcome = drainLane(api, token, items, side = lane != OutboxPolicy.lane(OutboxType.EVENT))) {
                LaneOutcome.Disconnected -> return false
                is LaneOutcome.Wait -> wakeIn = minOf(wakeIn ?: outcome.ms, outcome.ms)
                LaneOutcome.Done -> {}
            }
        }
        wakeIn?.let { SyncWork.wake(app, it) }
        return true
    }

    private sealed interface LaneOutcome {
        data object Done : LaneOutcome

        data class Wait(val ms: Long) : LaneOutcome

        data object Disconnected : LaneOutcome
    }

    /**
     * One lane, oldest first; its head waits out a backoff, and everything behind it with it.
     * [side]: the usage, the location, the calls or the network lane, whose failures aren't a connection problem.
     */
    private fun drainLane(api: DeviceApi, token: String, lane: List<Pair<OutboxItem, Long>>, side: Boolean): LaneOutcome {
        val wait = OutboxPolicy.waitMs(lane.first().second, System.currentTimeMillis())
        if (wait != null) return LaneOutcome.Wait(wait)
        val result = OutboxDrain.run(lane.map { it.first }) { batch -> send(api, token, batch) }
        val finishedAt = System.currentTimeMillis()
        result.dropped.forEach {
            Log.w(Agent.TAG, "outbox: dropped item ${it.id}: ${it.reason}")
            store.markDropped(it.id, it.reason, finishedAt)
        }
        val what = when (lane.first().first.type) {
            OutboxType.USAGE -> "usage days"
            OutboxType.FIX, OutboxType.PLACE_EVENT -> "fixes and place events"
            OutboxType.CALL -> "call records"
            OutboxType.NETWORK -> "network days"
            else -> "items"
        }
        if (result.sent.isNotEmpty()) Log.i(Agent.TAG, "sent ${result.sent.size} $what in ${result.requests} requests")
        return when (val stop = result.stop) {
            null -> LaneOutcome.Done
            is OutboxDrain.Stop.Retry -> {
                val attempts = store.attempts(stop.ids) + 1
                val wait = OutboxPolicy.retryWaitMs(attempts, stop.afterMs, Random.nextDouble())
                store.markFailed(stop.ids, stop.reason, finishedAt + wait)
                // A server that doesn't take usage or locations yet isn't a connection problem for the kid's screen.
                if (!side) ConnectionStore.failed(app, finishedAt, stop.reason)
                Log.w(Agent.TAG, "outbox${if (side) " ($what)" else ""}: ${stop.reason}; trying again in ${wait / 1000} s (attempt $attempts)")
                LaneOutcome.Wait(wait)
            }
            is OutboxDrain.Stop.Disconnect -> {
                disconnect(stop.reason)
                LaneOutcome.Disconnected
            }
            OutboxDrain.Stop.Budget -> {
                // The rest of this run's outbox: its check-in, if any, went out already.
                Sync.request(app, dueToo = false)
                LaneOutcome.Done
            }
        }
    }

    private fun typeOf(type: String): OutboxType = when (type) {
        OutboxRow.TYPE_SNAPSHOT -> OutboxType.SNAPSHOT
        OutboxRow.TYPE_REQUEST -> OutboxType.REQUEST
        OutboxRow.TYPE_USAGE -> OutboxType.USAGE
        OutboxRow.TYPE_FIX -> OutboxType.FIX
        OutboxRow.TYPE_PLACE_EVENT -> OutboxType.PLACE_EVENT
        OutboxRow.TYPE_CALL -> OutboxType.CALL
        OutboxRow.TYPE_NETWORK -> OutboxType.NETWORK
        else -> OutboxType.EVENT
    }

    /** One request for [batch]: a snapshot alone, events, or the kid's requests. */
    private fun send(api: DeviceApi, token: String, batch: List<OutboxItem>): Verdict {
        val ids = batch.map { it.id }
        val answer = when (batch.first().type) {
            OutboxType.SNAPSHOT -> {
                // Gone when a newer snapshot replaced it meanwhile: nothing to send.
                val payload = store.payload(ids.single()) ?: return Verdict.Sent
                api.inventory(token, payload)
            }
            OutboxType.EVENT -> {
                val payloads = store.eventPayloads(ids)
                if (payloads.isEmpty()) return Verdict.Sent
                api.events(token, payloads)
            }
            OutboxType.REQUEST -> {
                // Gone when a newer send of the same request replaced it meanwhile.
                val payloads = store.requestPayloads(ids)
                if (payloads.isEmpty()) return Verdict.Sent
                api.requests(token, payloads)
            }
            OutboxType.USAGE -> {
                // Gone when a newer report of the same day replaced it meanwhile.
                val payloads = store.usagePayloads(ids)
                if (payloads.isEmpty()) return Verdict.Sent
                api.usage(token, payloads)
            }
            OutboxType.FIX, OutboxType.PLACE_EVENT -> {
                // Gone when location went off meanwhile.
                val (fixes, placeEvents) = store.locationPayloads(ids)
                if (fixes.isEmpty() && placeEvents.isEmpty()) return Verdict.Sent
                api.locations(token, fixes, placeEvents)
            }
            OutboxType.CALL -> {
                // Gone when logging went off meanwhile.
                val payloads = store.callPayloads(ids)
                if (payloads.isEmpty()) return Verdict.Sent
                api.calls(token, payloads)
            }
            OutboxType.NETWORK -> {
                // Gone when a newer report of the same day replaced it, or network logging went off, meanwhile.
                // One queued before a website was made private goes without it, before a step takes it out of the day.
                val private = Domains.privateSet(store.policy()?.networkLog?.privateDomains.orEmpty())
                val payloads = store.networkPayloads(ids).map { NetworkDigest.sendable(it, private) }
                if (payloads.isEmpty()) return Verdict.Sent
                api.network(token, payloads)
            }
        }
        return when (answer) {
            is DeviceApi.Answer.Ok -> {
                store.markSent(ids, answer.receivedAt)
                ConnectionStore.synced(app, answer.receivedAt, null, checkin = false)
                Verdict.Sent
            }
            is DeviceApi.Answer.Refused -> verdictFor(answer, batch.size)
            is DeviceApi.Answer.Failed -> Verdict.Retry(answer.reason)
        }
    }

    private fun verdictFor(answer: DeviceApi.Answer.Refused, items: Int): Verdict = OutboxPolicy.verdict(
        status = answer.status,
        error = answer.error?.error,
        items = items,
        retryAfterMs = OutboxPolicy.retryAfterMs(answer.retryAfter, System.currentTimeMillis()),
    )

    private fun reason(verdict: Verdict): String = when (verdict) {
        Verdict.Sent -> "sent"
        is Verdict.Split -> verdict.reason
        is Verdict.Drop -> verdict.reason
        is Verdict.Retry -> verdict.reason
        is Verdict.Disconnect -> verdict.reason
    }

    private fun disconnect(reason: String) = Sync.disconnect(app, reason)
}
