package family.brooker.belay.location

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.Trigger

/**
 * Phase 4: wakes the agent when the next fix is due by the clock (periodic mode within its hours,
 * sooner near a place's edge, or lost mode's every 5 minutes; core's LocationWork.nextAt). One
 * exact alarm of its own, like PolicyTimer's: the battery allowlist exempts Belay from the
 * exact-alarm permission, and USE_EXACT_ALARM is the backup (docs/platform-notes.md S6). Without
 * either the alarm is inexact and may come late; the hourly check catches up.
 */
object LocationTimer {
    @Volatile
    private var scheduledAt: Long? = null

    @SuppressLint("MissingPermission")
    fun schedule(context: Context, at: Long?) {
        if (at == scheduledAt) return
        val app = context.applicationContext
        val am = app.getSystemService(AlarmManager::class.java) ?: return
        val intent = PendingIntent.getBroadcast(
            app,
            REQUEST_CODE,
            Intent(app, LocationTimerReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        try {
            when {
                at == null -> am.cancel(intent)
                am.canScheduleExactAlarms() -> am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
                else -> am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            }
            scheduledAt = at
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "location timer not set", e)
        }
    }

    fun fired() {
        scheduledAt = null
    }

    private const val REQUEST_CODE = 4
}

/** Not exported: only Belay's own alarm reaches it. */
class LocationTimerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        LocationTimer.fired()
        val pending = goAsync()
        Agent.handle(context, Trigger.LOCATION_DUE) { pending.finish() }
    }
}
