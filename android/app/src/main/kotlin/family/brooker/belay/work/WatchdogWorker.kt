package family.brooker.belay.work

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The backstop: every hour (when Doze allows), restart the service if it stopped and
 * reconcile the inventory. Each run leaves a heartbeat, so the main screen shows how
 * often the agent really got to run, overnight included.
 */
class WatchdogWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val finished = CountDownLatch(1)
        Agent.handle(applicationContext, Trigger.WATCHDOG) { finished.countDown() }
        finished.await(2, TimeUnit.MINUTES)
        return Result.success()
    }

    companion object {
        private const val NAME = "watchdog"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<WatchdogWorker>(1, TimeUnit.HOURS).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
