package family.brooker.belay.enforce

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.PrivateDnsRow
import family.brooker.belay.sync.Sync
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The phone's Private DNS, on its own thread. DevicePolicyManager.setGlobalPrivateDnsModeSpecifiedHost
 * first opens a TLS connection to the host's port 853 from the caller's process, and only
 * sets it if that works (AOSP 17 `PrivateDnsConnectivityChecker`). Its connect has no
 * timeout of its own, it answers "host not serving" whenever the phone is offline, and
 * Android refuses it (SecurityException) while there is another user or profile on the
 * phone. So:
 * - it never runs on the main thread or the agent's: this thread does it, with its own
 *   timeout, records the outcome (the only writer of the private_dns row), and asks the
 *   agent for a step, which reports any problem;
 * - offline, it doesn't try (and reports nothing); a new network brings the next try;
 * - a failure is tried again five minutes later, or on a new network.
 *
 * Belay remembers the host it set. When the policy no longer names one, Belay sets Android's
 * default (Automatic: opportunistic), but only if the phone still has Belay's host.
 */
object PrivateDns {
    /** After a failed attempt, the next try waits this long (or for a new network). */
    const val RETRY_MS = 5L * 60 * 1000

    /** The longest Belay waits for Android's check of the host. */
    private const val CHECK_TIMEOUT_S = 30L

    private val executor = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "belay-dns") }

    /** Runs the blocking call, so a check that never ends can't hold up the next attempt. */
    private val caller = Executors.newCachedThreadPool { r -> Thread(r, "belay-dns-check").apply { isDaemon = true } }
    private val busy = AtomicBoolean(false)

    @Volatile
    private var wanted: String? = null

    /**
     * From the agent step: make the phone's Private DNS what [host] says (null: Belay's own
     * host, if set, goes). [recheck] (after a boot, a full scan or a new network) looks at the
     * phone's setting again even when Belay's record says it's done, or a try just failed.
     */
    fun want(context: Context, host: String?, row: PrivateDnsRow?, now: Long, recheck: Boolean) {
        val done = host == row?.setHost
        if (done && !(recheck && host != null)) return
        // The same attempt failed a moment ago: its retry is scheduled.
        val failedRecently = row != null && row.attemptHost == host && row.error != null &&
            row.attemptAt != null && now - row.attemptAt in 0 until RETRY_MS
        if (failedRecently && !recheck) return
        submit(context.applicationContext, host)
    }

    /** A new network: after a failure (offline included), an agent step tries the policy's host again. */
    fun networkBack(context: Context) {
        val row = AgentStore.get(context).privateDns() ?: return
        if (row.error != null) Agent.handle(context, Trigger.PRIVATE_DNS_RETRY)
    }

    private fun submit(app: Context, host: String?) {
        wanted = host
        if (!busy.compareAndSet(false, true)) return
        executor.execute {
            val target = wanted
            val store = AgentStore.get(app)
            try {
                run(app, store, target)
            } catch (t: Throwable) {
                // Recorded as a failed attempt, so the step that follows doesn't simply try again.
                Log.e(Agent.TAG, "Private DNS step failed", t)
                runCatching { store.savePrivateDns(store.privateDns().failed(target, System.currentTimeMillis(), ERROR_NOT_SET)) }
                retryLater(app)
            } finally {
                busy.set(false)
            }
            Agent.handle(app, Trigger.PRIVATE_DNS)
        }
    }

    private fun run(app: Context, store: AgentStore, host: String?) {
        val before = store.privateDns()
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(app)
        if (!dpm.isDeviceOwnerApp(app.packageName)) return
        val now = System.currentTimeMillis()
        val currentMode = dpm.getGlobalPrivateDnsMode(admin)
        val currentHost = dpm.getGlobalPrivateDnsHost(admin)
        val alreadySet = currentMode == DevicePolicyManager.PRIVATE_DNS_MODE_PROVIDER_HOSTNAME && currentHost == host
        val row = when {
            host == null -> {
                val mine = before?.setHost
                if (mine != null && currentMode == DevicePolicyManager.PRIVATE_DNS_MODE_PROVIDER_HOSTNAME && currentHost == mine) {
                    try {
                        dpm.setGlobalPrivateDnsModeOpportunistic(admin)
                    } catch (e: RuntimeException) {
                        Log.w(Agent.TAG, "Private DNS back to automatic", e)
                    }
                }
                PrivateDnsRow(setHost = null, attemptHost = null, attemptAt = now, error = null)
            }
            alreadySet -> PrivateDnsRow(setHost = host, attemptHost = host, attemptAt = now, error = null)
            // Offline, Android's check would only say "not serving": wait for a network.
            !Sync.online(app) -> before.failed(host, now, ERROR_OFFLINE)
            else -> when (val result = setHost(dpm, admin, host)) {
                DevicePolicyManager.PRIVATE_DNS_SET_NO_ERROR -> PrivateDnsRow(setHost = host, attemptHost = host, attemptAt = now, error = null)
                DevicePolicyManager.PRIVATE_DNS_SET_ERROR_HOST_NOT_SERVING -> before.failed(host, now, ERROR_NOT_SERVING)
                else -> before.failed(host, now, if (result == OTHER_USERS) ERROR_OTHER_USERS else ERROR_NOT_SET)
            }
        }
        store.savePrivateDns(row)
        when (row.error) {
            null -> Log.i(Agent.TAG, "Private DNS: ${host ?: "Belay's host taken back"}")
            ERROR_OFFLINE -> Log.i(Agent.TAG, "Private DNS $host: offline; trying again on a network")
            else -> {
                Log.w(Agent.TAG, "Private DNS $host: ${row.error}; trying again in ${RETRY_MS / 60_000} minutes")
                retryLater(app)
            }
        }
    }

    /** Android's call, with Belay's own timeout. A result code, or [OTHER_USERS]. */
    private fun setHost(dpm: DevicePolicyManager, admin: ComponentName, host: String): Int {
        val call = caller.submit<Int> { dpm.setGlobalPrivateDnsModeSpecifiedHost(admin, host) }
        return try {
            call.get(CHECK_TIMEOUT_S, TimeUnit.SECONDS)
        } catch (e: TimeoutException) {
            call.cancel(true)
            Log.w(Agent.TAG, "Private DNS $host: no answer in $CHECK_TIMEOUT_S s")
            DevicePolicyManager.PRIVATE_DNS_SET_ERROR_HOST_NOT_SERVING
        } catch (e: ExecutionException) {
            Log.w(Agent.TAG, "Private DNS $host", e.cause)
            // Android refuses it while users or profiles that aren't affiliated exist.
            if (e.cause is SecurityException) OTHER_USERS else DevicePolicyManager.PRIVATE_DNS_SET_ERROR_FAILURE_SETTING
        }
    }

    private fun retryLater(app: Context) {
        executor.schedule({ Agent.handle(app, Trigger.PRIVATE_DNS_RETRY) }, RETRY_MS, TimeUnit.MILLISECONDS)
    }

    /** Keeps the host Belay had set (if any) when a new one fails. */
    private fun PrivateDnsRow?.failed(host: String?, now: Long, error: String) =
        PrivateDnsRow(setHost = this?.setHost, attemptHost = host, attemptAt = now, error = error)

    /**
     * The problem to report when [host] is what the policy wants and the last try failed.
     * Nothing while the phone is offline: that's no fault of the host's.
     */
    fun problem(host: String?, row: PrivateDnsRow?): String? {
        if (host == null || row?.setHost == host || row?.attemptHost != host || row.error == null) return null
        return when (row.error) {
            ERROR_OFFLINE -> null
            ERROR_NOT_SERVING -> "Private DNS: $host didn't answer from this phone, so it isn't set yet. Belay tries again every few minutes."
            ERROR_OTHER_USERS -> "Private DNS: Android doesn't let Belay set $host while there is another user or profile on this phone."
            else -> "Private DNS: Android didn't set $host. Belay tries again every few minutes."
        }
    }

    /** Not one of DevicePolicyManager's codes: SecurityException, another user or profile. */
    private const val OTHER_USERS = -1000

    private const val ERROR_OFFLINE = "offline"
    private const val ERROR_NOT_SERVING = "not serving"
    private const val ERROR_OTHER_USERS = "other users"
    private const val ERROR_NOT_SET = "not set"
}
