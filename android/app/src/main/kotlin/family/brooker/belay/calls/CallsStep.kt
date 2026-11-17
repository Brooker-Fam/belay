package family.brooker.belay.calls

import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallRules
import family.brooker.belay.core.calls.CallsPlan
import family.brooker.belay.core.calls.CallsState
import family.brooker.belay.core.calls.CallsWireLimits
import family.brooker.belay.core.calls.WireCallsStatus
import family.brooker.belay.store.AgentStore

/**
 * Calls' part of an agent step (Phase 5), on the agent thread, with core's CallsPlan:
 * - calls on: Belay's dialer enabled, the dialer it takes over from recorded, Belay made the default
 *   dialer (asking again after a refusal only every 15 minutes or at a new policy), Android's block
 *   list in step with `blocked_numbers` (Belay's entries only; lifted during the 2-hour callback
 *   window), CALL_PHONE denied to the other apps that ask for it, and `enforcement.calls`;
 * - calls off: Belay's entries taken off the block list and CALL_PHONE handed back now; after the
 *   step is stored ([after]), the role given back to the dialer from before and Belay's dialer
 *   disabled, then the call permissions denied by policy (the agent step's last act: Android then
 *   restarts Belay, platform notes L7). Each is done again at the next step if it didn't happen.
 * Idempotent: what's already so isn't done again.
 */
class CallsStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext

    class Done(
        /** Null: nothing to store (calls was never on). */
        val write: AgentStore.CallsWrite?,
        val report: WireCallsStatus?,
        val problems: List<String>,
        /** After the step is stored: whom to give the dialer role back to (calls went off). */
        val giveBackTo: String?,
        /** After the step is stored: disable Belay's dialer (calls went off). */
        val disable: Boolean,
        /** When Belay's blocks go back on (the callback window ends), for the policy timer. */
        val nextAt: Long?,
        val state: CallsState?,
    )

    /**
     * [protected]: every package Belay never blocks (core's NeverBlocked); [inventory]: everything
     * installed; [newPolicy]: the policy changed since the last step.
     */
    fun run(policy: WirePolicy, owner: Boolean, protected: Set<String>, inventory: Map<String, PackageRecord>, newPolicy: Boolean, now: Long): Done {
        val before = store.callsState()
        var state = before ?: CallsState()
        val calls = policy.calls
        val self = app.packageName
        val android = AndroidCalls.emergencyNumbers(app)
        // The callback window: Belay's own record, and Android's call log for a call its dialer didn't see.
        val seen = if (calls != null) CallRecords.lastEmergencyContact(AndroidCalls.log(app, now - CallsWireLimits.EMERGENCY_CALLBACK_MS, limit = 50), android, now) else null
        state = state.copy(lastEmergencyContactAt = CallsPlan.emergencyContact(state.lastEmergencyContactAt, seen, now))
        val window = CallRules.callbackWindow(state.lastEmergencyContactAt, null, now)

        if (calls == null) return off(before, state, owner, protected, inventory, now)

        val problems = mutableListOf<String>()
        var isDialer = Dialer.isDialer(app)
        if (owner) {
            if (!Dialer.componentsEnabled(app)) Dialer.setComponents(app, true)
            if (!state.dialerBeforeRecorded) {
                val current = Dialer.defaultDialer(app)
                state = state.copy(dialerBefore = current?.takeIf { it != self }, dialerBeforeRecorded = true)
                Log.i(Agent.TAG, "calls: the default dialer before Belay: ${current ?: "none"}")
            }
            if (CallsPlan.askForDialer(isDialer, state, now, newPolicy)) {
                val problem = Dialer.makeDefault(app, self)
                isDialer = problem == null
                state = state.copy(dialerRefusedAt = if (problem == null) null else now, dialerProblem = problem)
            }
            if (isDialer) {
                state = state.copy(dialerRefusedAt = null, dialerProblem = null)
                state = syncBlockList(state, CallsPlan.wantedBlocked(CallContacts.blocked(policy, android), window), now)
            }
            state = syncCallPhone(state, on = true, protected, inventory)
        } else {
            problems += "Belay isn't the device owner, so it can't be the phone's calling app."
        }
        if (!isDialer) state.dialerProblem?.let { problems += it }
        state = state.copy(on = true, report = CallsPlan.report(on = true, isDialer = isDialer))
        // While the window holds Belay's blocks off, the timer brings them back when it ends.
        val nextAt = CallRules.callbackWindowEnds(state.lastEmergencyContactAt, now)?.takeIf { window && policy.blockedNumbers.isNotEmpty() }
        return Done(AgentStore.CallsWrite(state, dropUnsent = !calls.log), state.report, problems, giveBackTo = null, disable = false, nextAt, state)
    }

    /** Calls is off: undo what Belay did, if anything is left; nothing is stored once it's all undone. */
    private fun off(before: CallsState?, start: CallsState, owner: Boolean, protected: Set<String>, inventory: Map<String, PackageRecord>, now: Long): Done {
        val enabled = Dialer.componentsEnabled(app)
        val isDialer = Dialer.isDialer(app)
        if (before == null && !enabled && !isDialer) return Done(null, null, emptyList(), null, false, null, null)
        var state = start
        if (owner) {
            if (state.blockedByBelay.isNotEmpty()) {
                // Only the dialer may write the block list: after the role is gone, Belay can't take them off.
                val removed = if (isDialer) state.blockedByBelay.filter { BlockList.remove(app, it) }.toSet() else emptySet()
                if (removed.size < state.blockedByBelay.size) {
                    Log.w(Agent.TAG, "calls: ${state.blockedByBelay.size - removed.size} numbers Belay blocked couldn't be taken off the block list")
                }
                state = state.copy(blockedByBelay = emptySet())
            }
            state = syncCallPhone(state, on = false, protected, inventory)
        }
        val installed = inventory.keys
        val giveBack = if (owner && isDialer) CallsPlan.giveBackTo(state, installed, app.packageName) else null
        // Done once Belay's dialer is off and it no longer holds the role, and nothing is denied.
        val undone = !enabled && !isDialer && state.callPhoneDenied.isEmpty()
        val next = if (undone) null else state.copy(on = false, report = null, lastEmergencyContactAt = null, callPhoneRequesters = emptySet(), requestersReadFrom = null)
        if (before?.on == true) Log.i(Agent.TAG, "calls: off; giving the dialer back to ${giveBack ?: "Android's choice"}")
        return Done(AgentStore.CallsWrite(next, dropUnsent = true, clearRecents = true), null, emptyList(), giveBack, disable = enabled, nextAt = null, next)
    }

    private fun syncBlockList(state: CallsState, wanted: Set<String>, now: Long): CallsState {
        val checked = state.blockListCheckedAt
        val due = wanted != state.blockedByBelay || checked == null || now - checked >= CallsPlan.BLOCK_LIST_CHECK_MS || now < checked
        if (!due) return state
        val present = BlockList.read(app) ?: return state
        val changes = CallsPlan.blockList(wanted, present, state.blockedByBelay)
        if (changes.none) return state.copy(blockedByBelay = changes.mine, blockListCheckedAt = now)
        val added = changes.add.filterTo(HashSet()) { BlockList.add(app, it) }
        val removed = changes.remove.filterTo(HashSet()) { BlockList.remove(app, it) }
        Log.i(Agent.TAG, "calls: block list: ${added.size} added, ${removed.size} taken off (Belay's own entries only)")
        val mine = changes.mine - (changes.add - added) + (changes.remove - removed)
        return state.copy(blockedByBelay = mine, blockListCheckedAt = now)
    }

    private fun syncCallPhone(state: CallsState, on: Boolean, protected: Set<String>, inventory: Map<String, PackageRecord>): CallsState {
        val signature = signature(inventory)
        val requesters = when {
            !on -> emptySet()
            state.requestersReadFrom == signature -> state.callPhoneRequesters
            else -> CallPhoneGuard.requesters(app)
        }
        val changes = CallsPlan.callPhone(on, requesters, protected, inventory.keys, app.packageName, state.callPhoneDenied)
        val denied = changes.deny.filterTo(HashSet()) { CallPhoneGuard.deny(app, it) }
        val restored = changes.restore.filterTo(HashSet()) { CallPhoneGuard.restore(app, it) }
        if (changes.deny.isNotEmpty() || changes.restore.isNotEmpty()) {
            Log.i(Agent.TAG, "calls: CALL_PHONE denied to ${denied.sorted()}, handed back to ${restored.sorted()}")
        }
        return state.copy(
            callPhoneDenied = changes.denied - (changes.deny - denied) + (changes.restore - restored),
            callPhoneRequesters = requesters,
            requestersReadFrom = if (on) signature else null,
        )
    }

    /** Changes when an app is installed, updated or removed: then the CALL_PHONE requesters are read again. */
    private fun signature(inventory: Map<String, PackageRecord>): Long =
        inventory.values.sortedBy { it.packageName }.fold(inventory.size.toLong()) { acc, r -> acc * 31 + r.packageName.hashCode() * 17L + r.lastUpdateTime }

    companion object {
        /**
         * After the step is stored (calls went off): give the role back, then disable Belay's dialer,
         * which makes Android drop Belay from the role when there was nobody to give it to.
         */
        fun after(context: Context, done: Done) {
            val app = context.applicationContext
            done.giveBackTo?.let { previous ->
                Dialer.makeDefault(app, previous)?.let { Log.w(Agent.TAG, "calls: couldn't give the dialer back to $previous: $it") }
            }
            if (done.disable) Dialer.setComponents(app, false)
        }
    }
}
