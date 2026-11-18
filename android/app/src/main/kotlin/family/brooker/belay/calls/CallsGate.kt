package family.brooker.belay.calls

import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallRules
import family.brooker.belay.core.calls.CallsNow
import family.brooker.belay.core.calls.CallsState
import family.brooker.belay.core.calls.CallsWireLimits
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.IncomingCall
import family.brooker.belay.core.calls.IncomingDecision
import family.brooker.belay.core.calls.OutgoingDecision
import family.brooker.belay.core.calls.QuietTimes
import family.brooker.belay.core.calls.Ring
import family.brooker.belay.core.calls.RingBecause
import family.brooker.belay.store.AgentStore
import java.time.ZoneId

/**
 * What Belay's call screening and in-call services decide from, in this process: the policy and
 * Belay's calls state as the last agent step published them (or read from the store once, after a
 * restart), plus what only the moment knows: whether a bedtime or school schedule is on (screen
 * time's own rules) and whether the kid called 911 or 988 in the last 2 hours (Belay's record, this
 * process's memory, the newest time kept before the first unlock after a restart (LockedCalls), and
 * Android's call log). Never on the main thread (the store and the call log are read here).
 * Anything that goes wrong decides "ring": calls fail open (docs/protocol.md).
 */
object CallsGate {
    private data class Snapshot(val policy: WirePolicy?, val state: CallsState?)

    @Volatile
    private var snapshot: Snapshot? = null

    /** The last emergency contact this process saw, before the agent thread stores it. */
    @Volatile
    private var emergencyAt: Long? = null

    /** After each agent step: what calls are decided from until the next one. */
    fun publish(policy: WirePolicy?, state: CallsState?) {
        snapshot = Snapshot(policy, state)
    }

    private fun snapshot(context: Context): Snapshot = snapshot ?: run {
        val store = AgentStore.get(context)
        Snapshot(DebugTools.policyOverride ?: store.policy(), store.callsState()).also { snapshot = it }
    }

    fun policy(context: Context): WirePolicy? = snapshot(context).policy

    /** The rules' view of the phone at [at]. [readLog]: also look in Android's call log for a recent call to 911 or 988. */
    fun now(context: Context, at: Long, android: EmergencyNumbers, readLog: Boolean = true): CallsNow {
        val snap = snapshot(context)
        val policy = snap.policy
        val calls = policy?.calls
        val quiet = calls?.quiet == true && try {
            QuietTimes.quiet(policy?.screenTime, at, ZoneId.systemDefault())
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "calls: quiet time couldn't be worked out", e)
            false
        }
        val fromLog = if (readLog && calls != null) {
            CallRecords.lastEmergencyContact(AndroidCalls.log(context, at - CallsWireLimits.EMERGENCY_CALLBACK_MS, limit = 50), android, at)
        } else {
            null
        }
        if (fromLog != null && fromLog > (emergencyAt ?: 0L)) emergencyAt = fromLog
        val beforeUnlock = if (calls != null) LockedCalls.emergencyContactAt(context) else null
        return CallsNow(
            calls = calls,
            contacts = CallContacts.of(policy),
            blocked = CallContacts.blocked(policy, android),
            quietSchedule = quiet,
            lastEmergencyContactAt = listOfNotNull(snap.state?.lastEmergencyContactAt, emergencyAt, beforeUnlock).maxOrNull(),
            now = at,
        )
    }

    /** An incoming call's decision; "ring" if anything goes wrong. */
    fun incoming(context: Context, call: IncomingCall, at: Long): IncomingDecision = try {
        val android = AndroidCalls.emergencyNumbers(context)
        CallRules.incoming(call, now(context, at, android), android)
    } catch (e: RuntimeException) {
        Log.e(Agent.TAG, "calls: couldn't decide an incoming call, so it rings", e)
        IncomingDecision(Ring.RING, because = RingBecause.CALLS_OFF)
    }

    /** An outgoing call's decision; allowed if anything goes wrong. */
    fun outgoing(context: Context, number: String?, at: Long): OutgoingDecision = try {
        val android = AndroidCalls.emergencyNumbers(context)
        CallRules.outgoing(number, now(context, at, android, readLog = false), android)
    } catch (e: RuntimeException) {
        Log.e(Agent.TAG, "calls: couldn't decide an outgoing call, so it goes", e)
        OutgoingDecision(true)
    }

    /**
     * The kid called (or texted, through Belay) 911, an emergency number or 988 at [at]: for 2 hours
     * every caller rings. Remembered here at once and stored by the agent thread; never sent.
     */
    fun emergencyContact(context: Context, at: Long) {
        if (at > (emergencyAt ?: 0L)) emergencyAt = at
        Agent.emergencyContact(context, at)
    }
}
