package family.brooker.belay.core.calls

import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.WireScheduleKind
import family.brooker.belay.core.screentime.WireScreenTime
import java.time.ZoneId

/**
 * Quiet time for calls (`calls.quiet`): while one of Phase 3's bedtime or school schedules is on,
 * only always-allowed numbers and parents ring. Whether one is on comes from screen time's own rules
 * (Rules.evaluate, the same function that pauses the apps), so calls and apps never disagree about
 * when bedtime is. A custom schedule doesn't count.
 */
object QuietTimes {
    val KINDS: Set<WireScheduleKind> = setOf(WireScheduleKind.BEDTIME, WireScheduleKind.SCHOOL)

    /** The bedtime or school schedules on at [now], by id; empty without screen time. */
    fun on(screenTime: WireScreenTime?, now: Long, phoneZone: ZoneId): List<String> {
        if (screenTime == null) return emptyList()
        val decision = Rules.evaluate(
            Rules.Input(
                policy = screenTime,
                now = now,
                phoneZone = phoneZone,
                usage = null,
                // Schedules don't need counting; nothing here is enforced.
                measured = true,
                apps = emptySet(),
                neverBlocked = emptySet(),
            ),
        )
        return decision.schedules.filter { it.kind in KINDS }.map { it.id }
    }

    fun quiet(screenTime: WireScreenTime?, now: Long, phoneZone: ZoneId): Boolean = on(screenTime, now, phoneZone).isNotEmpty()
}
