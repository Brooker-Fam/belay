package family.brooker.belay.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import family.brooker.belay.core.SyncPolicy
import java.util.concurrent.TimeUnit

/**
 * WorkManager is the backstop for sync: the service and the agent's own triggers sync
 * right away, and these make sure it happens anyway, once there is a network.
 * - "checkin": every 2 hours, a check-in (and whatever waits in the outbox).
 * - "sync": once, when a send failed or the phone was offline, at the time the outbox's
 *   backoff says.
 */
object SyncWork {
    private const val SYNC = "sync"
    private const val CHECKIN = "checkin"

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Runs a sync once the phone is online, no sooner than [delayMs] from now. Replaces an earlier wake. */
    fun wake(context: Context, delayMs: Long) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInitialDelay(delayMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
            .setConstraints(network)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(SYNC, ExistingWorkPolicy.REPLACE, request)
    }

    /** Idempotent: an existing schedule is kept. */
    fun scheduleCheckins(context: Context) {
        val request = PeriodicWorkRequestBuilder<CheckinWorker>(SyncPolicy.CHECKIN_INTERVAL_MS, TimeUnit.MILLISECONDS)
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(CHECKIN, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** Disconnected: nothing to sync with. */
    fun stop(context: Context) {
        WorkManager.getInstance(context).run {
            cancelUniqueWork(SYNC)
            cancelUniqueWork(CHECKIN)
        }
    }

    const val RUN_TIMEOUT_MS = 4L * 60 * 1000
}

class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        // Another wake may replace this one while it runs: that only cancels this worker.
        Sync.runAndWait(applicationContext, checkin = false, timeoutMs = SyncWork.RUN_TIMEOUT_MS)
        return Result.success()
    }
}

class CheckinWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val report = Sync.runAndWait(applicationContext, checkin = true, timeoutMs = SyncWork.RUN_TIMEOUT_MS)
        return if (report == null || (report.connected && report.checkinFailed)) Result.retry() else Result.success()
    }
}
