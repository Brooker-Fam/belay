package family.brooker.belay.core.network

import family.brooker.belay.core.screentime.WireNetworkLogStatus
import kotlinx.serialization.Serializable

/**
 * What the phone keeps about network logging between steps (Room's network_state row, as JSON),
 * apart from the days themselves: where Android's batches stand, and the report as the last step
 * made it. Deleted with the days when the policy turns logging off.
 */
@Serializable
data class NetworkLogState(
    /** When Belay last turned Android's network logging on; null while it's off. */
    val enabledAt: Long? = null,
    /**
     * The boot [lastToken] counts in. Android numbers its batches from 1 again at every boot, and
     * every time logging is turned on (devicepolicy/NetworkLoggingHandler, AOSP 17).
     */
    val bootCount: Int? = null,
    /** The newest batch Belay has taken (0: none yet). */
    val lastToken: Long = 0,
    /**
     * When Android last refused to hand over a batch (`SecurityException`: another user or profile
     * is on the phone, platform notes W1 and V2); null once a batch came through again.
     */
    val refusedAt: Long? = null,
    /** When Belay last took a batch, and how many DNS lookups were in it (kept or not). */
    val lastBatchAt: Long? = null,
    val lastBatchLookups: Int = 0,
    /** `enforcement.network_log` as the last step made it; null when there's nothing to say. */
    val report: WireNetworkLogStatus? = null,
)

/**
 * Network logging's rules on the phone (Phase 3), pure: which of Android's batches to take, and
 * what to report. A device owner turns logging on with `DevicePolicyManager.setNetworkLoggingEnabled`;
 * Android then finishes a batch at 1200 events or after 90 minutes, tells Belay
 * (`DeviceAdminReceiver.onNetworkLogsAvailable`, with the batch's token), keeps the last 5, and
 * discards a batch 5 minutes after it's taken. While another user or profile is on the phone it
 * keeps logging but tells Belay nothing, and refuses to hand a batch over (platform notes W1, V2).
 */
object NetworkLog {
    /** Batches Android keeps (NetworkLoggingHandler.MAX_BATCHES). */
    const val ANDROID_KEEPS = 5

    /** Belay just turned logging on at [at]: Android counts batches from 1 again. */
    fun turnedOn(at: Long, bootCount: Int?): NetworkLogState = NetworkLogState(enabledAt = at, bootCount = bootCount)

    /**
     * The batches to take, oldest first, when Android says batch [token] is ready: every one since
     * the last Belay took, in case a notice was missed (or held back while logging was paused), as
     * far back as Android keeps them. After a new boot, or when Android counted from 1 again (its
     * logging restarted), the count starts over. None for a batch already taken.
     */
    fun tokens(state: NetworkLogState, token: Long, bootCount: Int?): List<Long> {
        if (token <= 0) return emptyList()
        val sameBoot = bootCount == null || state.bootCount == null || bootCount == state.bootCount
        val last = if (sameBoot) state.lastToken else 0
        val from = when {
            token > last -> maxOf(last + 1, token - (ANDROID_KEEPS - 1))
            token < last -> maxOf(1, token - (ANDROID_KEEPS - 1))
            else -> return emptyList()
        }
        return (from..token).toList()
    }

    /** Batch [token] was taken at [at], with [lookups] DNS lookups in it. */
    fun took(state: NetworkLogState, token: Long, bootCount: Int?, at: Long, lookups: Int): NetworkLogState =
        state.copy(bootCount = bootCount ?: state.bootCount, lastToken = token, refusedAt = null, lastBatchAt = at, lastBatchLookups = lookups)

    /** Android refused to hand a batch over at [at]. */
    fun refused(state: NetworkLogState, at: Long): NetworkLogState = state.copy(refusedAt = at)

    /**
     * `enforcement.network_log`: null while the policy has logging off and Android's is off too;
     * otherwise whether Android logs ([androidOn]), and whether it paused: another user or profile
     * is on the phone ([otherUsers], getSecondaryUsers), or Android refused the last batch.
     */
    fun report(policyOn: Boolean, androidOn: Boolean, otherUsers: Int, state: NetworkLogState?): WireNetworkLogStatus? {
        if (!policyOn && !androidOn) return null
        return WireNetworkLogStatus(enabled = androidOn, paused = androidOn && (otherUsers > 0 || state?.refusedAt != null))
    }
}
