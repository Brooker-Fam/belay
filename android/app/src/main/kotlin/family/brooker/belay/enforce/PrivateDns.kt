package family.brooker.belay.enforce

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.PrivateDnsRow
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The phone's Private DNS, on its own thread. DevicePolicyManager.setGlobalPrivateDnsModeSpecifiedHost
 * first opens a TLS connection to the host's port 853 from the caller's process, and only
 * sets it if that works (AOSP 17 `PrivateDnsConnectivityChecker`; its connect has no
 * timeout of its own). So it never runs on the main thread or the agent's: this thread
 * does it, records the outcome (the only writer of the private_dns row), and asks the agent
 * for a step, which reports any problem.
 *
 * Belay remembers the host it set. When the policy no longer names one, Belay sets Android's
 * default (Automatic: opportunistic), but only if the phone still has Belay's host.
 */
object PrivateDns {
    /** After a failed attempt, the next try waits this long (or for a new network). */
    const val RETRY_MS = 5L * 60 * 1000

    private val executor = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "belay-dns") }
    private val busy = AtomicBoolean(false)

    @Volatile
    private var wanted: String? = null

    /**
     * From the agent step: make the phone's Private DNS what [host] says (null: Belay's own
     * host, if set, goes). [recheck] (after a boot or a full scan) looks at the phone's
     * setting again even when Belay's record says it's done.
     */
    fun want(context: Context, host: String?, row: PrivateDnsRow?, now: Long, recheck: Boolean) {
        val done = host == row?.setHost
        if (done && !(recheck && host != null)) return
        val failedRecently = host != null && row?.attemptHost == host && row.error != null &&
            row.attemptAt != null && now - row.attemptAt in 0 until RETRY_MS
        if (failedRecently && !recheck) return
        submit(context.applicationContext, host)
    }

    /** A new network: a failed host gets its next try now. */
    fun networkBack(context: Context) {
        val row = AgentStore.get(context).privateDns() ?: return
        if (row.error != null && row.attemptHost != null) submit(context.applicationContext, row.attemptHost)
    }

    private fun submit(app: Context, host: String?) {
        wanted = host
        if (!busy.compareAndSet(false, true)) return
        executor.execute {
            try {
                run(app, wanted)
            } catch (t: Throwable) {
                Log.e(Agent.TAG, "Private DNS step failed", t)
            } finally {
                busy.set(false)
            }
            Agent.handle(app, Trigger.PRIVATE_DNS)
        }
    }

    private fun run(app: Context, host: String?) {
        val store = AgentStore.get(app)
        val before = store.privateDns()
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(app)
        if (!dpm.isDeviceOwnerApp(app.packageName)) return
        val now = System.currentTimeMillis()
        val currentMode = dpm.getGlobalPrivateDnsMode(admin)
        val currentHost = dpm.getGlobalPrivateDnsHost(admin)
        val alreadySet = currentMode == DevicePolicyManager.PRIVATE_DNS_MODE_PROVIDER_HOSTNAME && currentHost == host
        val row = if (host != null) {
            val result = if (alreadySet) {
                DevicePolicyManager.PRIVATE_DNS_SET_NO_ERROR
            } else {
                try {
                    dpm.setGlobalPrivateDnsModeSpecifiedHost(admin, host)
                } catch (e: RuntimeException) {
                    Log.w(Agent.TAG, "Private DNS $host", e)
                    DevicePolicyManager.PRIVATE_DNS_SET_ERROR_FAILURE_SETTING
                }
            }
            when (result) {
                DevicePolicyManager.PRIVATE_DNS_SET_NO_ERROR -> PrivateDnsRow(setHost = host, attemptHost = host, attemptAt = now, error = null)
                DevicePolicyManager.PRIVATE_DNS_SET_ERROR_HOST_NOT_SERVING -> before.failed(host, now, ERROR_NOT_SERVING)
                else -> before.failed(host, now, ERROR_NOT_SET)
            }
        } else {
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
        store.savePrivateDns(row)
        if (row.error != null) {
            Log.w(Agent.TAG, "Private DNS $host: ${row.error}; trying again in ${RETRY_MS / 60_000} minutes")
            executor.schedule({ Agent.handle(app, Trigger.PRIVATE_DNS_RETRY) }, RETRY_MS, TimeUnit.MILLISECONDS)
        } else {
            Log.i(Agent.TAG, "Private DNS: ${host ?: "Belay's host taken back"}")
        }
    }

    /** Keeps the host Belay had set (if any) when a new one fails. */
    private fun PrivateDnsRow?.failed(host: String, now: Long, error: String) =
        PrivateDnsRow(setHost = this?.setHost, attemptHost = host, attemptAt = now, error = error)

    /** The problem to report for [row], when [host] is what the policy wants and it isn't set. */
    fun problem(host: String?, row: PrivateDnsRow?): String? {
        if (host == null || row?.setHost == host || row?.attemptHost != host || row.error == null) return null
        return when (row.error) {
            ERROR_NOT_SERVING -> "Private DNS: $host didn't answer from this phone, so it isn't set yet. Belay tries again every few minutes."
            else -> "Private DNS: Android didn't set $host. Belay tries again every few minutes."
        }
    }

    private const val ERROR_NOT_SERVING = "not serving"
    private const val ERROR_NOT_SET = "not set"
}
