package family.brooker.belay.core

import kotlinx.serialization.Serializable

/**
 * What Belay notes about the phone's SIM, to notice a change (DISALLOW_SIM_GLOBALLY only
 * stops eSIM downloads; a physical card can still be swapped). Opaque ids that need no
 * permission: never the phone number, the card's serial (ICCID) or the subscriber id.
 */
@Serializable
data class SimSeen(
    val present: Boolean,
    /** SubscriptionManager.getDefaultSubscriptionId(): Android gives each new card its own. */
    val subscriptionId: Int,
    /** TelephonyManager.getSimCarrierId(): the carrier, as Android numbers carriers. */
    val carrierId: Int,
)

/** What Belay saw last, and when it last saw a change. */
@Serializable
data class SimWatch(val seen: SimSeen? = null, val changedAt: Long? = null)

object SimRules {
    /** A change stays in the problem list this long after Belay noticed it. */
    const val REPORT_MS = 7L * 24 * 60 * 60 * 1000

    const val CHANGED_PROBLEM =
        "The SIM card in this phone changed (a card was put in, taken out or swapped). Belay noticed it in the last 7 days."

    /**
     * [now] is null while the SIM's state is in between (starting up, locked by its PIN):
     * nothing changes then. The first sight is only noted.
     */
    fun next(watch: SimWatch, now: SimSeen?, at: Long): SimWatch = when {
        now == null -> watch
        watch.seen == null -> watch.copy(seen = now)
        now != watch.seen -> SimWatch(seen = now, changedAt = at)
        else -> watch
    }

    fun problem(watch: SimWatch, at: Long): String? {
        val changedAt = watch.changedAt ?: return null
        return CHANGED_PROBLEM.takeIf { at - changedAt in 0 until REPORT_MS }
    }
}
