package family.brooker.belay.core.screentime

import kotlinx.serialization.Serializable
import kotlin.math.abs

/**
 * The usage events Belay reads, with UsageEvents.Event's constants (AOSP android-17.0.0_r1,
 * core/java/android/app/usage/UsageEvents.java). Ask queryEvents(UsageEventsQuery) for [CODES]
 * only, and map each event with [of]; anything else is ignored.
 */
enum class UsageEventType(val code: Int) {
    ACTIVITY_RESUMED(1),
    ACTIVITY_PAUSED(2),
    SCREEN_INTERACTIVE(15),
    SCREEN_NON_INTERACTIVE(16),
    KEYGUARD_SHOWN(17),
    KEYGUARD_HIDDEN(18),
    ACTIVITY_STOPPED(23),
    DEVICE_SHUTDOWN(26),
    DEVICE_STARTUP(27),
    ;

    companion object {
        val CODES: IntArray = entries.map { it.code }.toIntArray()

        fun of(code: Int): UsageEventType? = entries.firstOrNull { it.code == code }
    }
}

/** One event from UsageStatsManager.queryEvents, as plain data. */
data class UsageEvent(
    /** getTimeStamp(): epoch millis. */
    val time: Long,
    val type: UsageEventType,
    /** The app, for activity events. */
    val packageName: String? = null,
    /** The activity, for activity events. */
    val className: String? = null,
)

/** One read of the usage events. */
data class UsageReading(
    /** System.currentTimeMillis(): the events were asked for up to (not including) this time. */
    val wall: Long,
    /** SystemClock.elapsedRealtime() at the same moment, to tell a clock change from time passing. */
    val elapsed: Long,
    /** Settings.Global.BOOT_COUNT; null when unknown (then a clock change can't be told from a restart). */
    val bootCount: Int?,
    /**
     * Usage access was on both before and after the query. Without it the query comes back empty,
     * not with an error (platform notes U4), so empty can't be read as "not used".
     */
    val usageAccess: Boolean,
)

/** An activity on the screen (resumed, or paused but visible) since [since]. */
@Serializable
data class OpenActivity(val packageName: String, val className: String, val since: Long)

/** What the events say about the phone at the ledger's cursor. Null: not known yet. */
@Serializable
data class DeviceState(
    val screenOn: Boolean? = null,
    val keyguardShown: Boolean? = null,
    /** After a DEVICE_SHUTDOWN, until DEVICE_STARTUP. */
    val offSince: Long? = null,
    /** Oldest first. */
    val open: List<OpenActivity> = emptyList(),
)

/** The wall clock against the time since boot, to notice when the clock changes. */
@Serializable
data class ClockRef(val bootCount: Int, val offset: Long, val elapsed: Long)

/**
 * Belay's own record of screen time, which the agent stores (Room) and hands back at each read.
 * Everything before [cursor] is counted into [log], and [device] is where the events left the
 * phone. It replaces keeping raw events: Android keeps them about 10 days (platform notes U1), so
 * a lost ledger is rebuilt by starting one 7 days back and reading once.
 */
@Serializable
data class UsageLedger(
    val log: UsageLog,
    val device: DeviceState = DeviceState(),
    val clock: ClockRef? = null,
    /** The last read had no usage access. */
    val accessOff: Boolean = false,
) {
    /** Events before this are counted. Read from ScreenTime.queryFrom, which allows for clock changes. */
    val cursor: Long get() = log.asOf
}

/** The result of one read. */
data class UsageUpdate(
    /** Store this, and pass it to the next advance. */
    val ledger: UsageLedger,
    /** Usage up to the read, for the rules, the kid's screen and the reports. */
    val usage: UsageLog,
    /** The apps on the screen now, the most recent first; empty while the screen is off or locked. */
    val foreground: List<String>,
    /** Usage access was on: everything up to the read is counted. */
    val measured: Boolean,
    /**
     * How far the clock moved since the last read (0: it didn't). Android moved its usage history
     * by as much, and so did the ledger, so days already sent may have changed: send them again.
     */
    val clockShift: Long,
) {
    /** The app in front now. */
    val current: String? get() = foreground.firstOrNull()
}

/**
 * Turns usage events into time per app, counted from a cursor so reading the same events again, or
 * windows that overlap, never counts a minute twice. Pure: the agent reads, this counts.
 *
 * How it counts (docs/design/phase3-screen-time.md, "Measuring"):
 * - An app counts from ACTIVITY_RESUMED until ACTIVITY_STOPPED, so a picture-in-picture window and
 *   both apps in split screen count, while the screen is on and unlocked. Screen time is the time
 *   the screen is on and unlocked, so split screen isn't counted twice.
 * - Activities are told apart by package and class: their instance id is a system API.
 * - ACTIVITY_PAUSED for an activity that isn't open opens it, as Android's own app time limits
 *   count it (UsageStatsService.reportEvent: "transitioned from Stopped/Destroyed to Paused"),
 *   except while the screen is off, when that's only an app on its way out.
 * - Screen off closes every activity. Android stops them anyway; this keeps a lost stop event
 *   from counting an app while another is in front for longer than the screen stays on.
 * - DEVICE_SHUTDOWN ends everything, and activities opened before DEVICE_STARTUP are ignored, as
 *   UsageEvents documents. Android adds both at each boot; the shutdown is stamped with its last
 *   save, which can be older than this ledger's cursor after a crash or a flat battery. So a startup
 *   without a shutdown stops the count where it was. Either way the time off is a gap (phone_off).
 *   Events Android queued before the user unlocked are stamped at or after the startup
 *   (UserUsageStatsService.convertToSystemTimeLocked clamps them), so they never land before it.
 * - When the wall clock changes by more than 2 seconds, Android moves all its stored events by the
 *   change (UserUsageStatsService.checkAndGetTimeLocked, UsageStatsDatabase.onTimeChanged); the
 *   ledger moves its record and cursor the same way, so nothing is read twice or missed.
 * - Android can add an event a moment after its timestamp: the last [SETTLE_MS] are counted for
 *   [UsageUpdate.usage] but read again next time, so a late event still counts.
 * - Without usage access the cursor waits, and the time is a gap only in [UsageUpdate.usage]:
 *   Android keeps recording, so when access is back the ledger catches up and the gap goes.
 */
object ScreenTime {
    const val SETTLE_MS = 10_000L

    /** Android's own threshold for a clock change (UsageStatsService.TIME_CHANGE_THRESHOLD_MILLIS). */
    const val CLOCK_CHANGE_MS = 2_000L

    /** Android keeps about 10 days of events; a ledger further behind skips ahead, with a gap. */
    const val MAX_CATCH_UP_MS = 7L * 24 * 60 * 60 * 1000

    /** What each read keeps; ScreenTime.prune keeps less, once the agent has sent the days. */
    const val KEEP_MS = 8L * 24 * 60 * 60 * 1000

    /**
     * A new ledger counting from [at]. Pass what the phone knows now (PowerManager.isInteractive,
     * KeyguardManager.isKeyguardLocked) when starting from now, or nothing when starting in the past.
     */
    fun start(at: Long, screenOn: Boolean? = null, keyguardShown: Boolean? = null): UsageLedger =
        UsageLedger(UsageLog(from = at, asOf = at), DeviceState(screenOn = screenOn, keyguardShown = keyguardShown))

    /** Where to start the next query: the cursor, moved if the clock changed. Up to [UsageReading.wall]. */
    fun queryFrom(ledger: UsageLedger, reading: UsageReading): Long = prepare(ledger, reading).ledger.cursor

    /**
     * Counts [events] read up to [reading]. Events before the ledger's cursor (after any clock change)
     * are already counted and skipped, and so are events at or after the reading, which wait for the
     * next one: the agent may pass a query that overlaps the last. Order doesn't matter.
     */
    fun advance(ledger: UsageLedger, events: List<UsageEvent>, reading: UsageReading): UsageUpdate {
        val prepared = prepare(ledger, reading)
        val start = prepared.ledger
        val until = maxOf(start.cursor, reading.wall)
        if (!reading.usageAccess) {
            val settled = start.copy(accessOff = true)
            val usage = settled.log.withGap(settled.cursor, until, WireGapReason.NO_USAGE_ACCESS)
            return UsageUpdate(settled, usage, emptyList(), measured = false, clockShift = prepared.shift)
        }
        val fresh = events.filter { it.time >= start.cursor && it.time < until }.sortedBy { it.time }
        val settleAt = maxOf(start.cursor, until - SETTLE_MS)
        val counter = Counter(start)
        fresh.filter { it.time < settleAt }.forEach(counter::apply)
        counter.countTo(settleAt)
        val settled = counter.ledger(start.clock, accessOff = false).let { it.copy(log = it.log.pruned(until - KEEP_MS)) }
        val live = Counter(settled)
        fresh.filter { it.time >= settleAt }.forEach(live::apply)
        live.countTo(until)
        return UsageUpdate(settled, live.log(), live.foreground(), measured = true, clockShift = prepared.shift)
    }

    /** Without what ended before [before], once the agent has sent those days as complete. */
    fun prune(ledger: UsageLedger, before: Long): UsageLedger = ledger.copy(log = ledger.log.pruned(before))

    private class Prepared(val ledger: UsageLedger, val shift: Long)

    private fun prepare(ledger: UsageLedger, reading: UsageReading): Prepared {
        val offset = reading.wall - reading.elapsed
        val ref = ledger.clock
        val boot = reading.bootCount
        var shift = 0L
        var clock: ClockRef? = null
        if (boot != null) {
            clock = ClockRef(boot, offset, reading.elapsed)
            if (ref != null && ref.bootCount == boot && reading.elapsed >= ref.elapsed) {
                val change = offset - ref.offset
                // Below Android's threshold, keep the old reference, as Android does, so small steps add up.
                if (abs(change) > CLOCK_CHANGE_MS) shift = change else clock = ref.copy(elapsed = reading.elapsed)
            }
        }
        var next = (if (shift != 0L) ledger.shifted(shift) else ledger).copy(clock = clock)
        val oldest = reading.wall - MAX_CATCH_UP_MS
        if (next.cursor < oldest) next = next.skippedTo(oldest)
        return Prepared(next, shift)
    }

    private fun UsageLedger.shifted(by: Long) = copy(
        log = log.shifted(by),
        device = device.copy(
            offSince = device.offSince?.plus(by),
            open = device.open.map { it.copy(since = it.since + by) },
        ),
    )

    /** Too far behind to catch up: a gap up to [to], and nothing known about the phone there. */
    private fun UsageLedger.skippedTo(to: Long): UsageLedger {
        val reason = when {
            device.offSince != null -> WireGapReason.PHONE_OFF
            accessOff -> WireGapReason.NO_USAGE_ACCESS
            else -> WireGapReason.UNKNOWN
        }
        return copy(log = log.withGap(cursor, to, reason), device = DeviceState())
    }
}

/** Applies events, in time order, to a copy of a ledger. Lives for one pass. */
private class Counter(ledger: UsageLedger) {
    private val from = ledger.log.from
    private var at = ledger.log.asOf
    private var screenOn = ledger.device.screenOn
    private var keyguardShown = ledger.device.keyguardShown
    private var offSince = ledger.device.offSince

    /** Package and class to when it opened; the most recently resumed last. */
    private val open = LinkedHashMap<Pair<String, String>, Long>().apply {
        ledger.device.open.forEach { put(it.packageName to it.className, it.since) }
    }
    private val apps = HashMap<String, MutableList<Span>>().apply {
        ledger.log.apps.forEach { (name, spans) -> put(name, spans.toMutableList()) }
    }
    private val screen = ledger.log.screen.toMutableList()
    private val gaps = ledger.log.gaps.toMutableList()

    private val inUse: Boolean get() = offSince == null && screenOn == true && keyguardShown != true

    fun countTo(time: Long) {
        if (time <= at) return
        if (inUse) {
            Spans.extend(screen, at, time)
            for (name in open.keys.mapTo(LinkedHashSet()) { it.first }) {
                Spans.extend(apps.getOrPut(name) { mutableListOf() }, at, time)
            }
        }
        at = time
    }

    fun apply(event: UsageEvent) {
        if (event.time < at) return
        if (event.type == UsageEventType.DEVICE_STARTUP) {
            startup(event.time)
            return
        }
        countTo(event.time)
        val key = event.packageName?.let { it to event.className.orEmpty() }
        when (event.type) {
            UsageEventType.ACTIVITY_RESUMED -> if (key != null && offSince == null) {
                // An activity in front means the screen is on, if nothing said so yet.
                if (screenOn == null) screenOn = true
                open[key] = open.remove(key) ?: event.time
            }
            UsageEventType.ACTIVITY_PAUSED ->
                if (key != null && offSince == null && screenOn != false && key !in open) open[key] = event.time
            UsageEventType.ACTIVITY_STOPPED -> if (key != null) open.remove(key)
            UsageEventType.SCREEN_INTERACTIVE -> screenOn = true
            UsageEventType.SCREEN_NON_INTERACTIVE -> {
                screenOn = false
                open.clear()
            }
            UsageEventType.KEYGUARD_SHOWN -> keyguardShown = true
            UsageEventType.KEYGUARD_HIDDEN -> {
                keyguardShown = false
                if (screenOn == null) screenOn = true
            }
            UsageEventType.DEVICE_SHUTDOWN -> if (offSince == null) {
                open.clear()
                offSince = event.time
                screenOn = null
                keyguardShown = null
            }
            UsageEventType.DEVICE_STARTUP -> Unit
        }
    }

    /**
     * Nothing counts between a shutdown and the startup. Without a shutdown the phone stopped at an
     * unknown time after the count got to [at] (a crash, a flat battery): the count stops there.
     */
    private fun startup(time: Long) {
        Spans.addGap(gaps, offSince ?: at, time, WireGapReason.PHONE_OFF)
        at = maxOf(at, time)
        open.clear()
        offSince = null
        screenOn = null
        keyguardShown = null
    }

    fun foreground(): List<String> =
        if (inUse) open.keys.toList().asReversed().map { it.first }.distinct() else emptyList()

    fun log(): UsageLog = UsageLog(
        from = from,
        asOf = at,
        apps = apps.filterValues { it.isNotEmpty() }.mapValues { it.value.toList() }.toSortedMap(),
        screen = screen.toList(),
        gaps = gaps.toList(),
    )

    fun ledger(clock: ClockRef?, accessOff: Boolean) = UsageLedger(
        log = log(),
        device = DeviceState(
            screenOn = screenOn,
            keyguardShown = keyguardShown,
            offSince = offSince,
            open = open.map { (key, since) -> OpenActivity(key.first, key.second, since) },
        ),
        clock = clock,
        accessOff = accessOff,
    )
}
