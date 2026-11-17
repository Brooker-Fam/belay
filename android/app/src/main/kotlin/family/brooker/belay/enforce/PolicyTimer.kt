package family.brooker.belay.enforce

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
 * Wakes the agent when the plan changes by the clock alone: a pause or repair time ends.
 * Exact alarms need no permission for an app on the battery allowlist, where provision.sh
 * puts Belay (AOSP 17 `AlarmManagerService.isExemptFromExactAlarmPermissionNoLock`);
 * without it the alarm is inexact and may come late, and the hourly check and every other
 * step catch up.
 */
object PolicyTimer {
    @Volatile
    private var scheduledAt: Long? = null

    // No SCHEDULE_EXACT_ALARM: the battery allowlist exempts Belay, and canScheduleExactAlarms()
    // says whether it holds (lint only knows the permission).
    @SuppressLint("MissingPermission")
    fun schedule(context: Context, at: Long?) {
        if (at == scheduledAt) return
        val app = context.applicationContext
        val am = app.getSystemService(AlarmManager::class.java) ?: return
        val intent = PendingIntent.getBroadcast(
            app,
            0,
            Intent(app, PolicyTimerReceiver::class.java),
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
            Log.w(Agent.TAG, "policy timer not set", e)
        }
    }

    /** The alarm went off: the step that follows sets the next one, even for the same time. */
    fun fired() {
        scheduledAt = null
    }
}

/** Not exported: only Belay's own alarm reaches it. */
class PolicyTimerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        PolicyTimer.fired()
        val pending = goAsync()
        Agent.handle(context, Trigger.POLICY_TIMER) { pending.finish() }
    }
}
