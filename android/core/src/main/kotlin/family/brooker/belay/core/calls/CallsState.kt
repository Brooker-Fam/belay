package family.brooker.belay.core.calls

import kotlinx.serialization.Serializable

/**
 * What Belay keeps between steps about calls (one row, written by the agent thread), so it only
 * ever undoes its own work: the dialer it took the role from, the numbers it put on Android's block
 * list, and the apps it denied CALL_PHONE. [lastEmergencyContactAt] is only for the callback window
 * on this phone: it's never sent, never in the debug state, and forgotten once the window is over.
 */
@Serializable
data class CallsState(
    /** Belay turned calls on: its dialer is enabled and it asked to be the default dialer. */
    val on: Boolean = false,
    /** The default dialer before Belay took the role; null: there was none. Valid once [dialerBeforeRecorded]. */
    val dialerBefore: String? = null,
    val dialerBeforeRecorded: Boolean = false,
    /** Numbers Belay added to Android's block list (never the kid's own entries). */
    val blockedByBelay: Set<String> = emptySet(),
    /** Packages Belay denied CALL_PHONE by policy, to hand back when calls goes off. */
    val callPhoneDenied: Set<String> = emptySet(),
    /** The packages that asked for CALL_PHONE, as last read, and the inventory they were read from. */
    val callPhoneRequesters: Set<String> = emptySet(),
    val requestersReadFrom: Long? = null,
    /** When the kid last called an emergency number or 988, or texted 988 through Belay. */
    val lastEmergencyContactAt: Long? = null,
    /** When Android last refused to make Belay the dialer, and its words, so Belay doesn't ask every minute. */
    val dialerRefusedAt: Long? = null,
    val dialerProblem: String? = null,
    /** When Belay last compared Android's block list with its own record. */
    val blockListCheckedAt: Long? = null,
    /** `enforcement.calls` as the last step saw it; null while calls is off. */
    val report: WireCallsStatus? = null,
)

/** The block list's changes: add [add], remove [remove]; [mine] is Belay's record afterwards if both work. */
data class BlockListChanges(val add: Set<String>, val remove: Set<String>, val mine: Set<String>) {
    val none: Boolean get() = add.isEmpty() && remove.isEmpty()
}

/** CALL_PHONE's changes: deny [deny], hand back [restore] (grant state default); [denied] afterwards. */
data class CallPhoneChanges(val deny: Set<String>, val restore: Set<String>, val denied: Set<String>)

/**
 * The calls part of an agent step, in pure pieces (the phone applies them: calls/CallsStep.kt):
 * - Calls on: enable Belay's dialer, record the default dialer it takes over from, ask Android to
 *   make Belay the default dialer (setDefaultDialerApplication), keep Android's block list in step
 *   with `blocked_numbers` (only Belay's own entries; lifted during the callback window), and deny
 *   CALL_PHONE to every app but Belay and the apps it never blocks (the preloaded dialer, the phone
 *   service, emergency apps...).
 * - Calls off: take Belay's entries off the block list, hand CALL_PHONE back, give the role back to
 *   the dialer from before, and disable Belay's dialer, so Android drops Belay from the role even
 *   when there was no other dialer to give it to.
 */
object CallsPlan {
    /** After Android refuses to make Belay the dialer, Belay asks again after this long (or at a new policy). */
    const val DIALER_RETRY_MS = 15L * 60 * 1000

    /** Belay compares Android's block list with its own record at least this often. */
    const val BLOCK_LIST_CHECK_MS = 15L * 60 * 1000

    /** `enforcement.calls.problem` while Belay isn't the dialer and calls is on (protocol). */
    const val NOT_THE_DIALER = "Calls are going through the phone's own app"

    /** The numbers that should be on Android's block list for Belay: none during the callback window. */
    fun wantedBlocked(blocked: Set<String>, callbackWindow: Boolean): Set<String> = if (callbackWindow) emptySet() else blocked

    /**
     * From [present] (Android's block list now) to [wanted], touching only Belay's own entries
     * ([mine]): a wanted number the kid already blocked stays theirs, and one Belay added that's no
     * longer wanted comes off. One Belay added that's gone (the kid unblocked it) goes back on.
     */
    fun blockList(wanted: Set<String>, present: Set<String>, mine: Set<String>): BlockListChanges {
        val add = wanted - present
        val remove = (mine - wanted).intersect(present)
        // A number Belay added that's no longer on the list (and not wanted) is simply forgotten.
        val kept = mine.intersect(wanted).intersect(present)
        return BlockListChanges(add = add, remove = remove, mine = kept + add)
    }

    /**
     * Who loses CALL_PHONE: every app that asks for it ([requesters]) but Belay and the [protected]
     * ones (core's NeverBlocked: the preloaded and default dialers, the phone and telecom services,
     * emergency apps, the texting app, Android's own packages), so no emergency path loses it. With
     * calls off ([on] false), every app Belay denied gets it back, and so does one that's protected now.
     */
    fun callPhone(on: Boolean, requesters: Set<String>, protected: Set<String>, installed: Set<String>, self: String, denied: Set<String>): CallPhoneChanges {
        val wanted = if (on) requesters.filterTo(HashSet()) { it != self && it !in protected && it in installed } else emptySet()
        val restore = (denied - wanted).filterTo(HashSet()) { it in installed }
        return CallPhoneChanges(deny = wanted - denied, restore = restore, denied = wanted)
    }

    /**
     * Whom to give the dialer role back to when calls goes off: the dialer from before, if Belay
     * recorded one, it's installed and it isn't Belay. Null: nobody (Belay disables its dialer and
     * Android drops it from the role by itself; platform notes T1).
     */
    fun giveBackTo(state: CallsState, installed: Set<String>, self: String): String? =
        state.dialerBefore?.takeIf { state.dialerBeforeRecorded && it != self && it in installed }

    /** Whether to ask Android to make Belay the dialer now: not after a refusal, until [DIALER_RETRY_MS] passes or the policy changed. */
    fun askForDialer(isDialer: Boolean, state: CallsState, now: Long, newPolicy: Boolean): Boolean {
        if (isDialer) return false
        val refused = state.dialerRefusedAt ?: return true
        return newPolicy || now - refused >= DIALER_RETRY_MS || now < refused
    }

    /** `enforcement.calls`: null while calls is off; the problem while Belay isn't the dialer. */
    fun report(on: Boolean, isDialer: Boolean): WireCallsStatus? = when {
        !on -> null
        isDialer -> WireCallsStatus(dialer = true)
        else -> WireCallsStatus(dialer = false, problem = NOT_THE_DIALER)
    }

    /**
     * The last emergency contact to keep: the newest of what Belay knows, forgotten once the
     * callback window is over (and a time far ahead of the clock, from a clock that moved, is too).
     */
    fun emergencyContact(known: Long?, seen: Long?, now: Long): Long? =
        listOfNotNull(known, seen).filter { CallRules.callbackWindow(it, null, now) }.maxOrNull()
}
