package family.brooker.belay.screentime

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageEventsQuery
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.screentime.ScreenTime
import family.brooker.belay.core.screentime.UsageEvent
import family.brooker.belay.core.screentime.UsageEventType
import family.brooker.belay.core.screentime.UsageLedger
import family.brooker.belay.core.screentime.UsageReading
import family.brooker.belay.core.screentime.UsageUpdate

/**
 * Reads Android's usage events for screen time (Phase 3), with the usage access provision.sh
 * granted, and hands them to core's ScreenTime to count (docs/platform-notes.md U1, U4, U5, U8):
 * - `queryEvents(UsageEventsQuery)` (API 35) for core's event types only; the older
 *   `queryEvents(long, long)`, deprecated behind a flag in Android 17, only below 35.
 * - Without usage access the query comes back empty, not with an error, so access is checked
 *   before and after the query: only a read with access on both sides counts as measured.
 * - The reading pairs the wall clock with the time since boot and Settings.Global.BOOT_COUNT,
 *   so core can tell a clock change from time passing.
 * Data category: core's DataCategories.SCREEN_TIME (or SCREEN_TIME_LIMITS while not measuring).
 */
class UsageReader(context: Context) {
    private val app = context.applicationContext
    private val usage = app.getSystemService(UsageStatsManager::class.java)
    private val ops = app.getSystemService(AppOpsManager::class.java)

    /**
     * Usage access for Belay is on (the app-op allowed, as provision.sh sets it). AOSP 17
     * deprecates unsafeCheckOpNoThrow for a checkOpNoThrow(String…) that is new and flagged in
     * Android 17, so Belay (minSdk 31) keeps the call HealthReader also uses.
     */
    @Suppress("DEPRECATION")
    fun usageAccess(): Boolean = try {
        ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), app.packageName) == AppOpsManager.MODE_ALLOWED
    } catch (e: RuntimeException) {
        false
    }

    /** What the phone's clocks say now, with usage access as it is now. */
    fun reading(): UsageReading = UsageReading(
        wall = System.currentTimeMillis(),
        elapsed = SystemClock.elapsedRealtime(),
        bootCount = Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 },
        usageAccess = usageAccess(),
    )

    /** One read: the events after [ledger]'s cursor up to now, counted. [reading] is when it was read. */
    fun read(ledger: UsageLedger): Pair<UsageReading, UsageUpdate> {
        val before = reading()
        val events = if (before.usageAccess) events(ScreenTime.queryFrom(ledger, before), before.wall) else emptyList()
        val reading = before.copy(usageAccess = before.usageAccess && events != null && usageAccess())
        return reading to ScreenTime.advance(ledger, events.orEmpty(), reading)
    }

    /**
     * The events from [from] (included) to [to] (not included) of the types core counts; null
     * when Android refused. The query's builder refuses a period that ends before it starts.
     */
    fun events(from: Long, to: Long): List<UsageEvent>? {
        if (to <= from) return emptyList()
        val found = try {
            if (Build.VERSION.SDK_INT >= 35) {
                // core's UsageEventType.CODES, as Android's own constants (the same numbers; TYPES).
                val query = UsageEventsQuery.Builder(from, to).setEventTypes(
                    UsageEvents.Event.ACTIVITY_RESUMED,
                    UsageEvents.Event.ACTIVITY_PAUSED,
                    UsageEvents.Event.SCREEN_INTERACTIVE,
                    UsageEvents.Event.SCREEN_NON_INTERACTIVE,
                    UsageEvents.Event.KEYGUARD_SHOWN,
                    UsageEvents.Event.KEYGUARD_HIDDEN,
                    UsageEvents.Event.ACTIVITY_STOPPED,
                    UsageEvents.Event.DEVICE_SHUTDOWN,
                    UsageEvents.Event.DEVICE_STARTUP,
                )
                usage.queryEvents(query.build())
            } else {
                queryAll(from, to)
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "screen time: Android didn't give the usage events", e)
            return null
        } ?: return emptyList()
        val out = ArrayList<UsageEvent>()
        val event = UsageEvents.Event()
        while (found.hasNextEvent()) {
            if (!found.getNextEvent(event)) break
            val type = UsageEventType.of(event.eventType) ?: continue
            val activity = type == UsageEventType.ACTIVITY_RESUMED || type == UsageEventType.ACTIVITY_PAUSED ||
                type == UsageEventType.ACTIVITY_STOPPED
            out += UsageEvent(
                time = event.timeStamp,
                type = type,
                packageName = if (activity) event.packageName else null,
                className = if (activity) event.className else null,
            )
        }
        return out
    }

    /** Below API 35 there's only the query for every type; core ignores the others. */
    @Suppress("DEPRECATION")
    private fun queryAll(from: Long, to: Long): UsageEvents? = usage.queryEvents(from, to)

    companion object {
        /** The types [events] asks for, for the instrumented test to compare with core's UsageEventType.CODES. */
        val TYPES: Set<Int> = setOf(
            UsageEvents.Event.ACTIVITY_RESUMED,
            UsageEvents.Event.ACTIVITY_PAUSED,
            UsageEvents.Event.SCREEN_INTERACTIVE,
            UsageEvents.Event.SCREEN_NON_INTERACTIVE,
            UsageEvents.Event.KEYGUARD_SHOWN,
            UsageEvents.Event.KEYGUARD_HIDDEN,
            UsageEvents.Event.ACTIVITY_STOPPED,
            UsageEvents.Event.DEVICE_SHUTDOWN,
            UsageEvents.Event.DEVICE_STARTUP,
        )
    }
}
