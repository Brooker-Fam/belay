package family.brooker.belay.screentime

import android.app.AppOpsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * What wakes screen time between other steps (Phase 3), registered once per process (BelayApp),
 * like PackageWatcher, so it works whatever keeps the process alive:
 * - Screen on, screen off and the phone unlocked: these reach registered receivers only
 *   (Intent.ACTION_SCREEN_ON's documentation; platform notes U6). Each runs a step, so the count
 *   is read at screen off and the rules looked at again on screen on.
 * - While the screen is on and the policy has screen time ([want]), a step every 60 seconds, so
 *   a limit runs out on time even without the alarm. Nothing while the screen is off.
 * - Usage access turned off or on (AppOpsManager.startWatchingMode, Belay's own package): a
 *   step at once (platform notes U7), so the family's "can't count" rule applies.
 * Each goes through Agent.handle, so steps stay on the agent thread, one at a time.
 */
object ScreenWatcher {
    const val TICK_SECONDS = 60L

    private val registered = AtomicBoolean(false)
    private val ticker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "belay-screen-time") }

    @Volatile
    private var tick: ScheduledFuture<*>? = null

    @Volatile
    private var wanted = false

    @Volatile
    private var screenOn = false

    /** A tick's step hasn't finished yet: the next tick waits, so they never pile up. */
    private val ticking = AtomicBoolean(false)

    fun register(context: Context) {
        if (!registered.compareAndSet(false, true)) return
        val app = context.applicationContext
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // Not exported: only the system sends these (protected broadcasts).
        ContextCompat.registerReceiver(app, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
            app.getSystemService(AppOpsManager::class.java)
                .startWatchingMode(AppOpsManager.OPSTR_GET_USAGE_STATS, app.packageName, usageAccess(app))
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "screen time: can't watch usage access", e)
        }
        screenOn = app.getSystemService(PowerManager::class.java)?.isInteractive ?: false
        update(app)
    }

    /** After every step: whether the policy has screen time, so the 60-second tick is wanted. */
    fun want(context: Context, on: Boolean) {
        if (wanted == on) return
        wanted = on
        update(context.applicationContext)
    }

    @Synchronized
    private fun update(app: Context) {
        val run = wanted && screenOn
        if (run && tick == null) {
            tick = ticker.scheduleWithFixedDelay({ fire(app) }, TICK_SECONDS, TICK_SECONDS, TimeUnit.SECONDS)
        } else if (!run && tick != null) {
            tick?.cancel(false)
            tick = null
        }
    }

    private fun fire(app: Context) {
        if (!ticking.compareAndSet(false, true)) return
        Agent.handle(app, Trigger.SCREEN_TIME_TICK) { ticking.set(false) }
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val trigger = when (intent.action) {
                Intent.ACTION_SCREEN_ON -> Trigger.SCREEN_ON.also { screenOn = true }
                Intent.ACTION_SCREEN_OFF -> Trigger.SCREEN_OFF.also { screenOn = false }
                Intent.ACTION_USER_PRESENT -> Trigger.USER_PRESENT
                else -> return
            }
            update(context.applicationContext)
            val pending = goAsync()
            Agent.handle(context, trigger) { pending.finish() }
        }
    }

    private fun usageAccess(app: Context) = AppOpsManager.OnOpChangedListener { op, packageName ->
        if (op == AppOpsManager.OPSTR_GET_USAGE_STATS && packageName == app.packageName) {
            Agent.handle(app, Trigger.USAGE_ACCESS_CHANGED)
        }
    }
}

/**
 * The clock or the time zone changed (TIME_SET and TIMEZONE_CHANGED, which still reach manifest
 * receivers: the implicit broadcast exceptions, platform notes U6). Screen time's days and
 * schedules are looked at again. Not exported: only the system sends them.
 */
class ClockChangedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_TIME_CHANGED && intent.action != Intent.ACTION_TIMEZONE_CHANGED) return
        val pending = goAsync()
        Agent.handle(context, Trigger.CLOCK_CHANGED) { pending.finish() }
    }
}
