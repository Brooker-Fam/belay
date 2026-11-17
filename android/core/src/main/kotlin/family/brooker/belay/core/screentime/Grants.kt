package family.brooker.belay.core.screentime

import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WireRequest
import family.brooker.belay.core.WireRequestKind
import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.ZoneId

enum class GrantSource {
    /** A parent's extra time, in the policy (`screen_time.extra`). */
    PARENT,

    /** Minutes the kid took without asking, under the policy's `self_serve` rule. */
    SELF_SERVE,
}

/**
 * Extra minutes for one local [day]. [limitId] is a limit's id, or "*" for every limit; with
 * [packageName] only that app may use them ("15 more minutes of this game"), otherwise any app
 * the limit covers. They're used up as the apps are used past the limit's own minutes, and they
 * end with the day: the next day counts from its own minutes again.
 */
data class Grant(
    val id: String,
    val limitId: String,
    val packageName: String?,
    val minutes: Int,
    val day: LocalDate,
    val source: GrantSource,
) {
    fun appliesTo(limit: String): Boolean = limitId == limit || limitId == WireExtra.EVERY_LIMIT
}

/** Self-serve minutes the kid took, as the phone records them (Room); reported in `enforcement.screen_time`. */
@Serializable
data class SelfServeTake(
    /** Made on the phone. */
    val id: String,
    /** A limit's id, or "*" for every limit. */
    val limitId: String = WireExtra.EVERY_LIMIT,
    /** Only this app may use them; null: any app the limit covers. */
    val packageName: String? = null,
    val minutes: Int,
    /** "YYYY-MM-DD": the day they're for, as the policy counts days. */
    val day: String,
    val at: Long,
) {
    fun toWire() = WireSelfServeTake(limitId = limitId, packageName = packageName, minutes = minutes, at = at)
}

object Grants {
    /**
     * Every grant: the parents' extras and the kid's takes. An extra the phone can't read is left
     * out, with a problem; one sent twice counts once.
     */
    fun of(policy: WireScreenTime, takes: List<SelfServeTake>, problems: MutableList<String> = mutableListOf()): List<Grant> {
        val out = mutableListOf<Grant>()
        val seen = HashSet<String>()
        for (extra in policy.extra) {
            if (!seen.add(extra.id) || extra.minutes == 0) continue
            val day = LocalTimes.date(extra.day)
            when {
                day == null -> problems += "Extra time ${extra.id}: \"${extra.day.take(20)}\" isn't a date, so it's ignored."
                extra.minutes !in 1..ScreenTimeWireLimits.MAX_DAY_MINUTES ->
                    problems += "Extra time ${extra.id}: ${extra.minutes} minutes isn't 1 to 1440, so it's ignored."
                else -> out += Grant(extra.id, extra.limitId, extra.packageName, extra.minutes, day, GrantSource.PARENT)
            }
        }
        for (take in takes) {
            if (!seen.add(take.id) || take.minutes <= 0) continue
            val day = LocalTimes.date(take.day) ?: continue
            out += Grant(take.id, take.limitId, take.packageName, take.minutes, day, GrantSource.SELF_SERVE)
        }
        return out
    }
}

/** The self-serve rule today: [minutes] a time, [times] a day, [taken] so far. */
data class SelfServeStatus(val minutes: Int, val times: Int, val taken: Int) {
    val timesLeft: Int get() = (times - taken).coerceAtLeast(0)

    /** The offer, while times are left today. */
    val kidText: KidText? get() = if (timesLeft > 0) kid(KidMessage.SELF_SERVE, KidArg.Count(minutes), KidArg.Count(timesLeft)) else null
}

/** Extra minutes the kid may take without asking: a rule a parent set (`self_serve`). */
object SelfServe {
    /** Null when the policy has no self-serve rule (or no limit it could apply to). */
    fun status(policy: WireScreenTime, takes: List<SelfServeTake>, day: LocalDate): SelfServeStatus? {
        val rule = policy.selfServe ?: return null
        if (rule.minutes !in 1..ScreenTimeWireLimits.MAX_DAY_MINUTES || rule.times <= 0 || policy.limits.isEmpty()) return null
        val taken = takes.filter { it.day == day.toString() }.distinctBy { it.id }.size
        return SelfServeStatus(rule.minutes, rule.times, taken)
    }

    /**
     * The kid takes self-serve minutes now: for [limitId] ("*": every limit), and only for
     * [packageName] when given (the app they were in: one take is "more minutes for this app",
     * whichever of its limits ran out). Null when the rule doesn't allow it now. Taking again with
     * the same [id] returns the first take, so a double tap takes once. The phone stores the take;
     * it lasts the day even if the rule changes later that day.
     */
    fun take(
        policy: WireScreenTime,
        takes: List<SelfServeTake>,
        now: Long,
        phoneZone: ZoneId,
        id: String,
        limitId: String = WireExtra.EVERY_LIMIT,
        packageName: String? = null,
    ): SelfServeTake? {
        takes.firstOrNull { it.id == id }?.let { return it }
        val day = Rules.dayClock(policy, phoneZone).dayAt(now)
        val status = status(policy, takes, day) ?: return null
        if (status.timesLeft <= 0) return null
        if (limitId != WireExtra.EVERY_LIMIT && policy.limits.none { it.id == limitId }) return null
        return SelfServeTake(id, limitId, packageName, status.minutes, day.toString(), now)
    }
}

/** "Ask for more time": the kid's request, which a parent answers on the parent page. */
object MoreTime {
    /** A `more_time` request: [minutes] kept to 5 to 240, the kid's [reason] to 500 characters. */
    fun request(
        id: String,
        limitId: String,
        minutes: Int,
        askedAt: Long,
        packageName: String? = null,
        reason: String? = null,
    ): WireRequest = WireRequest(
        id = id,
        kind = WireRequestKind.MORE_TIME,
        limitId = limitId,
        minutes = minutes.coerceIn(ScreenTimeWireLimits.MIN_MORE_TIME_MINUTES, ScreenTimeWireLimits.MAX_MORE_TIME_MINUTES),
        askedAt = askedAt,
        packageName = packageName,
        reason = reason?.trim()?.take(WireLimits.MAX_REASON)?.takeIf { it.isNotEmpty() },
    )


    /** The limit to ask about for [packageName]: the first that pauses it, else the one with the least time left. */
    fun limitFor(decision: Decision, packageName: String): String? {
        decision.suspend[packageName]?.reasons?.filterIsInstance<Reason.Limit>()?.firstOrNull()?.let { return it.limitId }
        return decision.limits.filter { packageName in it.packages }.minByOrNull { it.leftMillis }?.id
    }
}

/** The kid's answer to the family agreement, which a parent sees on the parent page. */
object AgreementAnswer {
    /** An `agreement` request: agree, or "let's talk"; the kid's [reason] kept to 500 characters. */
    fun request(id: String, version: Int, answer: WireAgreementAnswer, askedAt: Long, reason: String? = null): WireRequest =
        WireRequest(
            id = id,
            kind = WireRequestKind.AGREEMENT,
            version = version,
            answer = answer,
            askedAt = askedAt,
            reason = reason?.trim()?.take(WireLimits.MAX_REASON)?.takeIf { it.isNotEmpty() },
        )
}
