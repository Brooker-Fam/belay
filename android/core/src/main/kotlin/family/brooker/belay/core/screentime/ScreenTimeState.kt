package family.brooker.belay.core.screentime

import kotlinx.serialization.Serializable
import java.time.ZoneId

/** How the usage uploads stand (`POST /api/v1/usage`): see [UsageUploads]. */
@Serializable
data class UploadState(
    /** Measuring started then, so nothing before it is sent. Null while the policy doesn't measure. */
    val since: Long? = null,
    /** When usage was last queued while the phone was used. */
    val lastAt: Long? = null,
    /** The days already queued as complete, as "YYYY-MM-DD zone", newest last. */
    val complete: List<String> = emptyList(),
)

/**
 * What the phone keeps for screen time between steps, next to the ledger (one Room row): the
 * self-serve minutes the kid took, the notices already shown, the screen locks done and how the
 * uploads stand. Everything here is for the agent itself; only the takes are reported.
 */
@Serializable
data class ScreenTimeState(
    /** Self-serve minutes the kid took (SelfServe.take), the last few days. */
    val takes: List<SelfServeTake> = emptyList(),
    /** Notices shown, by key, with when: each warning, time's up and schedule start shows once. */
    val shown: Map<String, Long> = emptyMap(),
    /** The notification tags Belay has up and may take back (NoticeSlot.tag). */
    val showing: Set<String> = emptySet(),
    /** Since when Belay couldn't count (usage access off); null while it can. */
    val unmeasuredSince: Long? = null,
    /** Screen locks done for a schedule's start (LockNow.key), with when: each once. */
    val locked: Map<String, Long> = emptyMap(),
    /** What Android said the last time locking the screen failed; null once it worked. */
    val lockProblem: String? = null,
    val uploads: UploadState = UploadState(),
)

/** The parts of keeping screen time that aren't counting, deciding, notices or uploads. */
object Upkeep {
    /** How long takes, shown notices and locks are remembered. */
    const val KEEP_MS = 3L * 24 * 60 * 60 * 1000

    /**
     * A new ledger for [policy], counting from the start of today as the policy counts days: today's
     * limits then count today's use, also when screen time was only just turned on. Android keeps
     * about 10 days of events (platform notes U1), so the first read catches up on today.
     */
    fun newLedger(policy: WireScreenTime, now: Long, phoneZone: ZoneId): UsageLedger {
        val days = Rules.dayClock(policy, phoneZone)
        return ScreenTime.start(days.startOf(days.dayAt(now)))
    }

    /**
     * Where the ledger may be pruned (ScreenTime.prune): the start of yesterday, as [days] counts
     * them. Today counts toward the limits, and yesterday is the oldest day sent again after a
     * clock change (UsageUploads); every day before it has been queued as complete.
     */
    fun keepFrom(days: DayClock, now: Long): Long = days.startOf(days.dayAt(now).minusDays(1))

    /** The screen locks due now ([Decision.lockNow]) that weren't done yet, and the state with them done. */
    fun locks(decision: Decision, state: ScreenTimeState, now: Long): Pair<List<LockNow>, ScreenTimeState> {
        val locked = state.locked.filterValues { recent(it, now) }
        val due = decision.lockNow.filter { it.key !in locked }
        return due to state.copy(locked = locked + due.associate { it.key to now })
    }

    /**
     * The kid takes self-serve minutes now for [limitId], only for [packageName] when given
     * (SelfServe.take): the state with the take, or null when the rule doesn't allow it now.
     * Tapping twice with the same [id] takes once.
     */
    fun take(
        policy: WireScreenTime,
        state: ScreenTimeState,
        now: Long,
        phoneZone: ZoneId,
        id: String,
        limitId: String,
        packageName: String?,
    ): Pair<SelfServeTake, ScreenTimeState>? {
        val take = SelfServe.take(policy, state.takes, now, phoneZone, id, limitId, packageName) ?: return null
        val takes = if (state.takes.any { it.id == take.id }) state.takes else state.takes + take
        return take to state.copy(takes = takes)
    }

    /** Without the takes, notices and locks older than [KEEP_MS]. */
    fun pruned(state: ScreenTimeState, now: Long): ScreenTimeState = state.copy(
        takes = state.takes.filter { recent(it.at, now) },
        shown = state.shown.filterValues { recent(it, now) },
        locked = state.locked.filterValues { recent(it, now) },
    )

    /** Within [KEEP_MS] of [now], either way: a clock that went back keeps them too. */
    internal fun recent(at: Long, now: Long): Boolean = at in (now - KEEP_MS)..(now + KEEP_MS)
}
