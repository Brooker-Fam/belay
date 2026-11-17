package family.brooker.belay.calls

import family.brooker.belay.core.calls.CallEntry
import family.brooker.belay.core.calls.WireCalls
import family.brooker.belay.core.calls.WireContact

/** What Belay's dialer shows, from the agent's last step; null while the policy has no calls. */
data class CallsView(
    val calls: WireCalls,
    /** The approved contacts, tidied (core's CallContacts.of): names for the recent calls too. */
    val contacts: List<WireContact>,
    /** Belay's own recent calls, the newest first (never one with 911, 988 or a private number). */
    val recents: List<CallEntry>,
    /** Belay is the default dialer right now. */
    val isDialer: Boolean,
)
