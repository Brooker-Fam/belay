package family.brooker.belay.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.CheckinRequest
import family.brooker.belay.core.OutboxDrain
import family.brooker.belay.core.OutboxItem
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.OutboxType
import family.brooker.belay.core.SyncPolicy
import family.brooker.belay.core.Verdict
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
 * agent's reconcile thread. Every call is idempotent on the server, so sending again is
 * always safe.
 */
object Sync {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-sync") }
    private val queued = AtomicBoolean(false)

    @Volatile
    private var checkinWanted = false

    /** How one sync run ended. [checkinFailed]: a check-in was due or asked for, and didn't happen. */
    data class Report(val connected: Boolean, val checkinFailed: Boolean = false)

    /** Asks for a sync soon. Requests made while one waits to start join it. */
    fun request(context: Context, checkin: Boolean = false) {
        val app = context.applicationContext
        if (checkin) checkinWanted = true
        if (!queued.compareAndSet(false, true)) return
        executor.execute {
            queued.set(false)
            val checkinNow = checkinWanted
            checkinWanted = false
            runSafely(app, checkinNow)
        }
    }

    /** For WorkManager: one run now, waiting for it. Null when it didn't finish in time. */
    fun runAndWait(context: Context, checkin: Boolean, timeoutMs: Long): Report? {
        val app = context.applicationContext
        val run = executor.submit<Report> { runSafely(app, checkin) }
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

    private fun runSafely(app: Context, checkin: Boolean): Report = try {
        SyncRun(app).run(checkin)
    } catch (t: RuntimeException) {
        Log.e(Agent.TAG, "sync failed", t)
        Report(connected = true, checkinFailed = checkin)
    }
}

/** One pass: check in if due, then the outbox, oldest first. */
private class SyncRun(private val app: Context) {
    private val store = AgentStore.get(app)

    fun run(checkinWanted: Boolean): Sync.Report {
        val connection = ConnectionStore.read(app)
        if (!connection.connected) return Sync.Report(connected = false)
        val token = TokenVault.decrypt(connection.sealedToken ?: return Sync.Report(connected = false))
        if (token == null) {
            disconnect("the device token can't be read any more")
            return Sync.Report(connected = false)
        }
        val checkinDue = checkinWanted || SyncPolicy.checkinDue(connection.lastCheckinAt, System.currentTimeMillis())
        if (!online()) {
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
        return when (val answer = api.checkin(token, CheckinRequest(device))) {
            is DeviceApi.Answer.Ok -> {
                val skew = SyncPolicy.clockSkewMs(answer.body.serverTime, answer.sentAt, answer.receivedAt)
                ConnectionStore.synced(app, answer.receivedAt, skew, checkin = true)
                Log.i(Agent.TAG, "checked in (clock skew ${skew / 1000} s)")
                Verdict.Sent
            }
            is DeviceApi.Answer.Refused -> verdictFor(answer, items = 1)
            is DeviceApi.Answer.Failed -> Verdict.Retry(answer.reason)
        }
    }

    /**
     * Sends what waits, strictly in order (OutboxDrain): the server applies events and
     * inventories as they arrive. Returns false if the server disconnected the phone.
     */
    private fun drain(api: DeviceApi, token: String): Boolean {
        val queue = store.queue()
        if (queue.isEmpty()) return true
        val now = System.currentTimeMillis()
        val head = queue.first()
        if (head.nextAttemptAt > now) {
            // Still waiting after a failure; everything behind the head waits with it.
            SyncWork.wake(app, head.nextAttemptAt - now)
            return true
        }
        val items = queue.map {
            OutboxItem(it.id, if (it.type == OutboxRow.TYPE_SNAPSHOT) OutboxType.SNAPSHOT else OutboxType.EVENT, it.bytes)
        }
        val result = OutboxDrain.run(items) { batch -> send(api, token, batch) }
        val finishedAt = System.currentTimeMillis()
        result.dropped.forEach {
            Log.w(Agent.TAG, "outbox: dropped item ${it.id}: ${it.reason}")
            store.markDropped(it.id, it.reason, finishedAt)
        }
        if (result.sent.isNotEmpty()) Log.i(Agent.TAG, "sent ${result.sent.size} items in ${result.requests} requests")
        when (val stop = result.stop) {
            null -> {}
            is OutboxDrain.Stop.Retry -> {
                val attempts = store.attempts(stop.ids) + 1
                val wait = stop.afterMs ?: OutboxPolicy.backoffMs(attempts, Random.nextDouble())
                store.markFailed(stop.ids, stop.reason, finishedAt + wait)
                ConnectionStore.failed(app, finishedAt, stop.reason)
                Log.w(Agent.TAG, "outbox: ${stop.reason}; trying again in ${wait / 1000} s (attempt $attempts)")
                SyncWork.wake(app, wait)
            }
            is OutboxDrain.Stop.Disconnect -> {
                disconnect(stop.reason)
                return false
            }
            OutboxDrain.Stop.Budget -> Sync.request(app)
        }
        return true
    }

    /** One request for [batch]: a snapshot alone, or events. */
    private fun send(api: DeviceApi, token: String, batch: List<OutboxItem>): Verdict {
        val ids = batch.map { it.id }
        val answer = if (batch.first().type == OutboxType.SNAPSHOT) {
            // Gone when a newer snapshot replaced it meanwhile: nothing to send.
            val payload = store.payload(ids.single()) ?: return Verdict.Sent
            api.inventory(token, payload)
        } else {
            val payloads = store.eventPayloads(ids)
            if (payloads.isEmpty()) return Verdict.Sent
            api.events(token, payloads)
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

    /** The parent removed this phone on the server (or its token is lost): stop syncing. */
    private fun disconnect(reason: String) {
        Log.w(Agent.TAG, "disconnected from the server: $reason")
        ConnectionStore.disconnected(app, System.currentTimeMillis(), reason)
        SyncWork.stop(app)
    }

    private fun online(): Boolean {
        val connectivity = app.getSystemService(ConnectivityManager::class.java) ?: return true
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
