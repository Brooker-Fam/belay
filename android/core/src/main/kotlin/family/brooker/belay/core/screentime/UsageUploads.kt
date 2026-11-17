package family.brooker.belay.core.screentime

/**
 * When the phone sends its usage (`POST /api/v1/usage`, through the outbox), and which days: only
 * while the policy's `measure` is on (collection is a parent's decision), and only what was
 * counted since then (UsageLog.since).
 * - Today, every [EVERY_MS] or so while the phone is used: at a step at least that long after
 *   the last, when the screen was on and unlocked since.
 * - Each day once more when it's complete, with everything counted to its end.
 * - After the clock moved (UsageUpdate.clockShift), today and yesterday again: Android moved its
 *   usage history, and so did the ledger, so days already sent may have changed. (A day sent
 *   again replaces the server's when its `as_of` is the same or newer: docs/protocol.md.)
 * Each upload replaces the day on the server, so sending one again is always safe.
 */
object UsageUploads {
    const val EVERY_MS = 15L * 60 * 1000

    /** How many complete days are remembered as sent. */
    private const val KEEP_COMPLETE = 14

    data class Plan(
        /** To queue, oldest first. */
        val days: List<WireUsageDay>,
        val state: UploadState,
    )

    /**
     * [usage] is the read's usage (UsageUpdate.usage), [days] the policy's day clock, [unlisted]
     * Phase 2's never-blocked packages (UsageReport.wire leaves them out of the apps). [force]:
     * send today now (a debug build's test hook).
     */
    fun plan(
        measure: Boolean,
        usage: UsageLog,
        days: DayClock,
        now: Long,
        state: UploadState,
        clockShift: Long,
        unlisted: Set<String>,
        force: Boolean = false,
    ): Plan {
        if (!measure) return Plan(emptyList(), UploadState())
        val since = state.since ?: now
        val counted = usage.since(since)
        val complete = state.complete.toMutableList()
        var lastAt = state.lastAt
        val again = if (clockShift != 0L) Upkeep.keepFrom(days, now) else Long.MAX_VALUE
        val out = mutableListOf<WireUsageDay>()
        for (day in days.daysIn(counted.from, counted.asOf)) {
            val report = UsageReport.day(counted, days, day)
            val key = "$day ${days.zone.id}"
            val send = when {
                report.to > again -> true
                report.complete -> key !in complete
                else -> force || due(counted, lastAt, since, now)
            }
            if (!send) continue
            out += UsageReport.wire(report, unlisted)
            if (report.complete) {
                if (key !in complete) complete += key
            } else {
                lastAt = now
            }
        }
        return Plan(out, UploadState(since = since, lastAt = lastAt, complete = complete.takeLast(KEEP_COMPLETE)))
    }

    /**
     * Today's report is due: [EVERY_MS] since the last, and the phone was used since. Before the
     * first one, or when the clock went back past the last, "since" is when measuring started.
     */
    private fun due(usage: UsageLog, lastAt: Long?, since: Long, now: Long): Boolean {
        val from = when {
            lastAt == null || now < lastAt -> since
            now - lastAt < EVERY_MS -> return false
            else -> lastAt
        }
        return usage.screenMillis(from, now) > 0
    }
}
