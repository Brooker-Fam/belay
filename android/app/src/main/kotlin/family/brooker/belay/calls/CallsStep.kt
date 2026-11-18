package family.brooker.belay.calls

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.annotation.VisibleForTesting
import family.brooker.belay.Agent
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.calls.AfterRestart
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.calls.CallEntry
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallRules
import family.brooker.belay.core.calls.CallsNow
import family.brooker.belay.core.calls.CallsPlan
import family.brooker.belay.core.calls.CallsState
import family.brooker.belay.core.calls.CallsWireLimits
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.QuietTimes
import family.brooker.belay.core.calls.WireCallsStatus
import family.brooker.belay.store.AgentStore
import java.time.ZoneId
import java.util.UUID

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
 * - after a restart (the fourth review's N1): the first step records it (core's AfterRestart), and,
 *   with calls on through it, takes the calls Android logged while the phone was locked, which
 *   Belay couldn't decide, into its recent calls and records (core's CallRecords.whileLocked), in
 *   the same transaction; for a day, the report says how long the phone stayed locked, when that
 *   was 10 minutes or more.
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
        // The callback window: Belay's own record, the time kept before the first unlock after a
        // restart, and Android's call log for a call its dialer didn't see.
        val beforeUnlock = LockedCalls.emergencyContactAt(app)
        // The last restart, and the calls Android logged while the phone was locked after it, read
        // before the window below forgets the times they're decided by. Those times are kept with
        // the restart until its last read (the fifth review's F1), so a second read, after the
        // window is forgotten here, decides by the same window.
        val known = listOfNotNull(before?.lastEmergencyContactAt, beforeUnlock)
        val restart = CallsPlan.afterRestart(
            before?.afterRestart, bootCount(), bootAt = System.currentTimeMillis() - SystemClock.elapsedRealtime(),
            unlockedAt = CallFlow.firstCallAt?.let { minOf(now, it - 1) } ?: now, callsWasOn = before?.on == true && calls != null,
        )
        val (spell, whileLocked) = lockedCalls(CallsPlan.keepEmergencies(restart, known), policy, known, android)
        state = state.copy(afterRestart = spell)
        val fromLog = if (calls != null) CallRecords.lastEmergencyContact(AndroidCalls.log(app, now - CallsWireLimits.EMERGENCY_CALLBACK_MS, limit = 50), android, now) else null
        val seen = listOfNotNull(fromLog, beforeUnlock.takeIf { calls != null }).maxOrNull()
        state = state.copy(lastEmergencyContactAt = CallsPlan.emergencyContact(state.lastEmergencyContactAt, seen, now))
        val window = CallRules.callbackWindow(state.lastEmergencyContactAt, null, now)
        // Kept in the store from now on: the copy before the unlock goes once its window is over.
        if (beforeUnlock != null && (calls == null || !CallRules.callbackWindow(beforeUnlock, null, now))) LockedCalls.forget(app)

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
        state = state.copy(on = true, report = CallsPlan.report(on = true, isDialer = isDialer, note = CallsPlan.lockedNote(state.afterRestart, now)))
        // While the window holds Belay's blocks off, the timer brings them back when it ends.
        val nextAt = CallRules.callbackWindowEnds(state.lastEmergencyContactAt, now)?.takeIf { window && policy.blockedNumbers.isNotEmpty() }
        val private = CallContacts.private(policy)
        val records = if (calls.log) whileLocked.mapNotNull { CallRecords.toWire(it, private, android) } else emptyList()
        val write = AgentStore.CallsWrite(state, dropUnsent = !calls.log, entries = whileLocked, records = records)
        return Done(write, state.report, problems, giveBackTo = null, disable = false, nextAt, state)
    }

    /**
     * The calls Android logged between the restart and the unlock that Belay didn't decide (core's
     * CallRecords.whileLocked), when they're due to be read (CallsPlan.readLockedCalls): [spell] as
     * read, and the entries to keep. [emergencyAt]: the kid's last emergency contact as Belay knows
     * it now, and the time kept before the unlock (LockedCalls), with those [spell] kept from the
     * first read; the log is read from 2 hours before the restart for calls to 911 or 988.
     */
    @VisibleForTesting
    internal fun lockedCalls(spell: AfterRestart, policy: WirePolicy, emergencyAt: List<Long>, android: EmergencyNumbers): Pair<AfterRestart, List<CallEntry>> {
        val calls = policy.calls ?: return spell to emptyList()
        val elsewhere by lazy { InCall.elsewhere(app) }
        if (!CallsPlan.readLockedCalls(spell, callsOn = true) { elsewhere } || !AndroidCalls.canReadLog(app)) return spell to emptyList()
        val log = AndroidCalls.log(app, since = CallRecords.spellReadFrom(spell.bootAt), limit = CallRecords.MAX_KEPT, until = spell.unlockedAt)
        val zone = ZoneId.systemDefault()
        val rules = CallsNow(calls = calls, contacts = CallContacts.of(policy), blocked = CallContacts.blocked(policy, android), now = spell.unlockedAt)
        val quietAt = { at: Long ->
            try {
                QuietTimes.quiet(policy.screenTime, at, zone)
            } catch (e: RuntimeException) {
                false
            }
        }
        val taken = CallRecords.whileLocked(
            log, spell.bootAt, spell.unlockedAt, spell.seen, store.calls(), rules, quietAt, spell.emergencyAt + emergencyAt, CallContacts.private(policy), android,
        ) { UUID.randomUUID().toString() }
        // No count and no times: what was taken would say whether the kid had calls then.
        Log.i(Agent.TAG, "calls: read Android's call log for the time before the unlock")
        return CallsPlan.afterRead(spell, taken) { elsewhere } to taken.entries
    }

    private fun bootCount(): Int? = Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 }

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
        // The last restart's calls aren't read any more, and the emergency times kept for them go.
        val next = if (undone) {
            null
        } else {
            state.copy(
                on = false, report = null, lastEmergencyContactAt = null, callPhoneRequesters = emptySet(), requestersReadFrom = null,
                afterRestart = state.afterRestart?.let(CallsPlan::noMoreReads),
            )
        }
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
        // No counts: all of them coming off, then going back on 2 hours later, would show the callback window.
        Log.i(Agent.TAG, "calls: block list updated (Belay's own entries only)")
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
