package family.brooker.belay.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.PolicyRules
import family.brooker.belay.core.PolicyTooLarge
import family.brooker.belay.core.Verdict
import family.brooker.belay.enforce.PrivateDns
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.settings.TokenVault
import family.brooker.belay.store.AgentStore
import family.brooker.belay.update.AgentUpdater
import okhttp3.Call
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * How a parent's change reaches the phone in seconds: `GET /api/v1/policy?have=<version>&wait=50`
 * in a loop, on its own thread, owned by the foreground service ([start] and [stop]). A
 * process with a foreground service keeps its network access in Doze
 * (NetworkPolicyManager.isProcStateAllowedWhileIdleOrPowerSaveMode, AOSP 17); while the
 * phone sleeps, a request goes out when it next wakes.
 *
 * - A new policy is stored and applied through Agent.handle (Trigger.POLICY), then the
 *   loop asks again at once; a 204 (no change) too.
 * - Errors back off like the outbox (core's PolicyRules, at most five minutes; Retry-After
 *   is honored); 401 invalid_token disconnects the phone, like every other call.
 * - A policy too big to read (over 1 MiB) is reported, the last one read stays in force, and
 *   the loop waits five minutes to an hour (core's PolicyTooLarge): asking again soon would
 *   only fetch the same answer.
 * - Idle while not connected to a server or offline; a new network or an enrollment wakes it.
 * - An answer that comes back much sooner than the server may wait, without anything new,
 *   counts as a failure, so a server or proxy that doesn't hold requests can't make a loop.
 */
object PolicyPoll {
    private const val IDLE_NOT_CONNECTED_MS = 5L * 60 * 1000
    private const val IDLE_OFFLINE_MS = 5L * 60 * 1000

    /** A 204 sooner than this is too quick for a server that holds requests. */
    private const val TOO_QUICK_MS = 5_000L

    private var thread: Thread? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /** A wake-up for the idle loop; holds at most one. */
    private val wakeups = LinkedBlockingQueue<Unit>(1)

    @Volatile
    private var call: Call? = null

    @Synchronized
    fun start(context: Context) {
        val app = context.applicationContext
        if (thread?.isAlive == true) return
        registerNetworkCallback(app)
        thread = Thread({ loop(app) }, "belay-policy").apply {
            isDaemon = true
            start()
        }
    }

    @Synchronized
    fun stop(context: Context) {
        thread?.interrupt()
        thread = null
        call?.cancel()
        networkCallback?.let { callback ->
            runCatching { context.applicationContext.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(callback) }
        }
        networkCallback = null
    }

    /** Asks again now: after an enrollment, or when the network came back. */
    fun kick() {
        wakeups.offer(Unit)
    }

    private fun loop(app: Context) {
        var failures = 0
        Log.i(Agent.TAG, "policy long-poll started")
        try {
            while (!Thread.currentThread().isInterrupted) {
                val wait = try {
                    once(app, failures)
                } catch (e: InterruptedException) {
                    throw e
                } catch (e: Exception) {
                    // Never the end of the loop: an unexpected failure waits like any other.
                    Log.e(Agent.TAG, "policy long-poll step failed", e)
                    Poll.Failed
                }
                when (wait) {
                    Poll.Again -> failures = 0
                    Poll.Failed -> {
                        failures++
                        idle(PolicyRules.pollRetryMs(failures, null, Random.nextDouble()))
                    }
                    // Asking again soon would only fetch the same answer: wait longer.
                    Poll.TooLarge -> {
                        failures++
                        idle(PolicyTooLarge.retryMs(failures, Random.nextDouble()))
                    }
                    is Poll.Wait -> {
                        if (wait.failure) failures++
                        idle(wait.ms(failures))
                    }
                }
            }
        } catch (e: InterruptedException) {
            // stop()
        } finally {
            Log.i(Agent.TAG, "policy long-poll stopped")
        }
    }

    /** What the loop does after one round. */
    private sealed interface Poll {
        /** Ask again at once. */
        data object Again : Poll

        /** A failure: back off. */
        data object Failed : Poll

        /** The server's policy is too big to read: back off longer. */
        data object TooLarge : Poll

        /** Wait: a fixed time, or a backoff ([failure]) at least as long as Retry-After. */
        data class Wait(val failure: Boolean, private val fixedMs: Long? = null, private val retryAfterMs: Long? = null) : Poll {
            fun ms(failures: Int): Long = fixedMs ?: PolicyRules.pollRetryMs(failures, retryAfterMs, Random.nextDouble())
        }
    }

    private fun once(app: Context, failures: Int): Poll {
        val connection = ConnectionStore.read(app)
        val server = connection.server
        if (!connection.connected || server == null) return Poll.Wait(failure = false, fixedMs = IDLE_NOT_CONNECTED_MS)
        if (!Sync.online(app)) return Poll.Wait(failure = false, fixedMs = IDLE_OFFLINE_MS)
        // An unreadable token is the sync thread's to handle (it disconnects).
        val token = connection.sealedToken?.let(TokenVault::decrypt)
            ?: return Poll.Wait(failure = false, fixedMs = IDLE_NOT_CONNECTED_MS)
        val have = AgentStore.get(app).policyVersion() ?: -1
        val answer = try {
            DeviceApi(server).policy(token, have, PolicyRules.POLL_WAIT_S) { call = it }
        } finally {
            call = null
        }
        if (Thread.currentThread().isInterrupted) throw InterruptedException()
        return when (answer) {
            is DeviceApi.Answer.Ok -> {
                val body = answer.body
                // A 204: the server's policy is the one Belay has, so none is too big to read.
                if (body == null) Sync.readable(app, "long-poll")
                val new = body != null && Sync.received(app, body.policy, "long-poll", sentAt = answer.sentAt, at = answer.receivedAt)
                if (new || answer.receivedAt - answer.sentAt >= TOO_QUICK_MS) Poll.Again else Poll.Failed
            }
            is DeviceApi.Answer.Refused -> {
                val verdict = OutboxPolicy.verdict(answer.status, answer.error?.error, items = 1)
                if (verdict is Verdict.Disconnect) {
                    Sync.disconnect(app, verdict.reason)
                    Poll.Again
                } else {
                    Log.w(Agent.TAG, "policy long-poll: HTTP ${answer.status} (failure ${failures + 1})")
                    Poll.Wait(failure = true, retryAfterMs = OutboxPolicy.retryAfterMs(answer.retryAfter, System.currentTimeMillis()))
                }
            }
            is DeviceApi.Answer.Failed -> {
                Log.w(Agent.TAG, "policy long-poll: ${answer.reason} (failure ${failures + 1})")
                val tooLarge = answer.tooLarge
                if (tooLarge != null) {
                    Sync.policyTooLarge(app, tooLarge.bytes, "long-poll")
                    Poll.TooLarge
                } else {
                    Poll.Failed
                }
            }
        }
    }

    /** Waits [ms], or until [kick]. */
    private fun idle(ms: Long) {
        wakeups.poll(ms.coerceAtLeast(1), TimeUnit.MILLISECONDS)
    }

    private fun registerNetworkCallback(app: Context) {
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                kick()
                PrivateDns.networkBack(app)
                AgentUpdater.networkBack(app)
            }
        }
        try {
            app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "no network callback: the long-poll checks every few minutes instead", e)
        }
    }
}
