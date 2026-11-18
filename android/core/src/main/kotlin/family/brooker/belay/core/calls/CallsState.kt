package family.brooker.belay.core.calls

import family.brooker.belay.core.Boots
import kotlinx.serialization.Serializable

/**
 * What Belay keeps between steps about calls (one row, written by the agent thread), so it only
 * ever undoes its own work: the dialer it took the role from, the numbers it put on Android's block
 * list, and the apps it denied CALL_PHONE. [lastEmergencyContactAt] is only for the callback window
 * on this phone: it's never sent, never in the debug state, and forgotten once the window is over
 * (after a restart, AfterRestart.emergencyAt keeps the times around it until the last read of
 * Android's call log for the calls before the unlock).
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
    /** The phone's last restart, as the first step after it saw it (the fourth review's N1). */
    val afterRestart: AfterRestart? = null,
)

/**
 * The phone's last restart, as the first agent step after it saw it. Before the first unlock after
 * a restart Belay decides no calls: only its outgoing-call receiver is direct-boot aware, so
 * Telecom gives every call to the phone's own app (platform notes T19), and Android logs them in
 * its call log's direct-boot copy, which it moves into the call log at the unlock (T22). Belay then
 * takes the ones it didn't decide from there (CallRecords.whileLocked), and, when the phone stayed
 * locked long enough, says so in `enforcement.calls.problem` for a day (CallsPlan.lockedNote). Only
 * times: no number.
 */
@Serializable
data class AfterRestart(
    /** Settings.Global.BOOT_COUNT, when Android has it: which restart this was. */
    val bootCount: Int? = null,
    /** When the phone started: the clock less the time since boot. */
    val bootAt: Long,
    /**
     * About when it was unlocked: the first agent step after the restart, or the first call Belay's
     * own in-call service saw since, if that was sooner. Belay runs only once the phone is
     * unlocked, so it was locked until about then.
     */
    val unlockedAt: Long,
    /** Calls was on before the restart and still was then: Belay takes the calls it didn't decide. */
    val callsOn: Boolean = false,
    /** Android's call log has been read for them. */
    val read: Boolean = false,
    /**
     * A call Belay didn't have was still on when it read (one answered on the lock screen, say):
     * Android logs a call when it ends, so Belay reads once more after it.
     */
    val again: Boolean = false,
    /** The times (CallLog.Calls.DATE) of the call log's entries already read, so none is taken twice. */
    val seen: List<Long> = emptyList(),
    /**
     * When the kid called 911, an emergency number or 988 around the restart, as the first read
     * knew it (the fifth review's F1): Belay's record from before it, the time kept before the
     * unlock, and such a call in Android's call log from 2 hours before it. Kept only while a read
     * is still due (CallsPlan.keepEmergencies), so a later read decides which calls rang only
     * because of the callback window by the same window, after the steps in between have
     * forgotten Belay's own record. Never sent, never in the debug state, gone after the last read.
     */
    val emergencyAt: List<Long> = emptyList(),
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

    /**
     * `enforcement.calls`: null while calls is off; the problem while Belay isn't the dialer, else
     * [note] (the phone stayed locked a while after a restart: [lockedNote]).
     */
    fun report(on: Boolean, isDialer: Boolean, note: String? = null): WireCallsStatus? = when {
        !on -> null
        isDialer -> WireCallsStatus(dialer = true, problem = note)
        else -> WireCallsStatus(dialer = false, problem = NOT_THE_DIALER)
    }

    /** Two records of a restart whose boot times are this close are the same one, without a boot count. */
    const val SAME_BOOT_MS = Boots.SAME_BOOT_MS

    /** After a restart the phone stayed locked this long or more: the report says so (a quick restart doesn't). */
    const val LOCKED_NOTE_FROM_MS = 10L * 60 * 1000

    /** For this long after the unlock: the daily summary has it. */
    const val LOCKED_NOTE_FOR_MS = 24L * 60 * 60 * 1000

    /**
     * Belay's record of the last restart after this step: [previous] while it's the same restart,
     * else a new one, unlocked at [unlockedAt] (this step, or Belay's first call since, if sooner).
     * Its calls are read only when calls was on before the restart ([callsWasOn]: the stored state
     * said so) and there was a record before: never at the first step with calls just on, or with
     * this Belay just installed, when the calls since the restart weren't under the rules.
     */
    fun afterRestart(previous: AfterRestart?, bootCount: Int?, bootAt: Long, unlockedAt: Long, callsWasOn: Boolean): AfterRestart {
        if (previous != null && sameBoot(previous, bootCount, bootAt)) return previous
        val callsOn = previous != null && callsWasOn
        return AfterRestart(bootCount, bootAt, maxOf(unlockedAt, bootAt), callsOn = callsOn, read = !callsOn)
    }

    /** Whether [spell] is the restart that [bootCount] and [bootAt] say the phone had last. */
    fun sameBoot(spell: AfterRestart, bootCount: Int?, bootAt: Long): Boolean = Boots.same(spell.bootCount, spell.bootAt, bootCount, bootAt)

    /**
     * Whether to read Android's call log for [spell]'s calls now: once, then once more if a call
     * Belay didn't have was on then, after it ended ([callElsewhere]: Telecom has a call Belay's
     * own in-call service doesn't; asked only then), and only with calls on.
     */
    fun readLockedCalls(spell: AfterRestart, callsOn: Boolean, callElsewhere: () -> Boolean): Boolean = when {
        !callsOn || !spell.callsOn -> false
        !spell.read -> true
        else -> spell.again && !callElsewhere()
    }

    /**
     * At most this many emergency times from the spell itself are kept for its reads (a few calls to
     * 911 from the lock screen, at most), and the newest one from the 2 hours before the restart.
     */
    const val MAX_SPELL_EMERGENCIES = 20

    /**
     * [spell] with the emergency times its reads decide callbacks by (the fifth review's F1):
     * [known] (Belay's record of the kid's last emergency contact, every time kept before the unlock,
     * or the calls to 911, an emergency number or 988 a read found in the log) added to those kept,
     * at every step while a read is due, and only those whose 2-hour window can reach into the
     * spell: from 2 hours before the restart to the unlock. The steps between two reads forget
     * Belay's own record once its 2 hours are over, so without these a call that rang in the
     * phone's own app only because of the window, still on at the unlock, would be sent with its
     * number at the second read. Of the times before the restart only the newest is kept: every
     * call in the spell comes after it, so its window reaches as far into the spell as any older
     * one's. Each time from the spell may be the only one whose window covers a callback (two calls
     * to 911 from the lock screen hours apart: the sixth review's G1), so the newest
     * [MAX_SPELL_EMERGENCIES] of those are. Once no read is due, none are kept: like Belay's own
     * record, they're only for the window.
     */
    fun keepEmergencies(spell: AfterRestart, known: Collection<Long>): AfterRestart {
        val due = spell.callsOn && (!spell.read || spell.again)
        val reach = spell.bootAt - CallsWireLimits.EMERGENCY_CALLBACK_MS..spell.unlockedAt
        val inReach = if (due) (spell.emergencyAt + known).filter { it in reach }.distinct().sorted() else emptyList()
        val kept = inReach.filter { it < spell.bootAt }.takeLast(1) + inReach.filter { it >= spell.bootAt }.takeLast(MAX_SPELL_EMERGENCIES)
        return if (kept == spell.emergencyAt) spell else spell.copy(emergencyAt = kept)
    }

    /** At most this many times are kept before the first unlock after a restart (LockedCalls): a few calls to 911, at most. */
    const val MAX_LOCKED_EMERGENCIES = 20

    /**
     * The times kept before the first unlock after a restart (calls/LockedCalls.kt), with the kid's
     * call to 911 from the lock screen at [at] added: every one, not only the newest (the sixth
     * review's G1), since each call that rang in the phone's own app then is decided after the unlock
     * by the window of the call before it, and a dispatcher's callback to the first of two 911 calls
     * hours apart is a callback too. The newest [MAX_LOCKED_EMERGENCIES]. None goes for its window
     * here: no agent step runs before the unlock, and the first one after it needs them all for the
     * restart's reads ([keepEmergencies]); then [lockedOpen] keeps only those whose window is open.
     */
    fun lockedRecord(kept: List<Long>, at: Long): List<Long> = (kept + at).distinct().sorted().takeLast(MAX_LOCKED_EMERGENCIES)

    /**
     * The times kept before the unlock that stay once an agent step has them ([keepEmergencies]
     * keeps them with the restart for its reads): those whose 2-hour window is still open at [now],
     * for the window itself. None: nothing is kept there any more.
     */
    fun lockedOpen(kept: List<Long>, now: Long): List<Long> = kept.filter { CallRules.callbackWindow(it, null, now) }

    /**
     * [spell] once Android's call log was read for it ([taken]): read, once more only after the
     * first read and while a call Belay didn't have is on ([callElsewhere]), and with the emergency
     * times the read decided by kept for that second read (none after it).
     */
    fun afterRead(spell: AfterRestart, taken: CallRecords.Taken, callElsewhere: () -> Boolean): AfterRestart =
        keepEmergencies(spell.copy(read = true, again = !spell.read && callElsewhere(), seen = taken.seen), taken.emergencyAt)

    /** Calls went off: [spell]'s calls are never read, and its emergency times go. */
    fun noMoreReads(spell: AfterRestart): AfterRestart = spell.copy(read = true, again = false, emergencyAt = emptyList())

    /**
     * `enforcement.calls.problem` for [LOCKED_NOTE_FOR_MS] after the unlock, when the phone stayed
     * locked [LOCKED_NOTE_FROM_MS] or more after a restart with calls on: until then Belay decided
     * no calls. Only how long, never when (the server words times in the family's zone) or a call.
     */
    fun lockedNote(spell: AfterRestart?, now: Long): String? {
        val restart = spell?.takeIf { it.callsOn } ?: return null
        val locked = restart.unlockedAt - restart.bootAt
        if (locked < LOCKED_NOTE_FROM_MS || now - restart.unlockedAt !in 0 until LOCKED_NOTE_FOR_MS) return null
        return "The phone restarted and stayed locked for ${lockedFor(locked)}. Until it's unlocked after a restart, " +
            "Belay can't decide calls: they ring in the phone's own app, whatever the rules."
    }

    private fun lockedFor(ms: Long): String {
        val minutes = ms / 60_000
        return when {
            minutes < 60 -> "$minutes minutes"
            minutes < 90 -> "about an hour"
            minutes < 48 * 60 -> "about ${(minutes + 30) / 60} hours"
            else -> "about ${(minutes + 12 * 60) / (24 * 60)} days"
        }
    }

    /**
     * The last emergency contact to keep: the newest of what Belay knows, forgotten once the
     * callback window is over (and a time far ahead of the clock, from a clock that moved, is too).
     */
    fun emergencyContact(known: Long?, seen: Long?, now: Long): Long? =
        listOfNotNull(known, seen).filter { CallRules.callbackWindow(it, null, now) }.maxOrNull()
}
