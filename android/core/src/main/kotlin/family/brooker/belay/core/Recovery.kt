package family.brooker.belay.core

import kotlinx.serialization.Serializable

/**
 * Phase 6: the recovery key on the phone (docs/protocol.md, "The recovery key"), kept across
 * restarts. Typing the key opens the same repair access as maintenance mode for 24 hours,
 * offline: the debugging and factory_reset locks are lifted. Release builds still contain
 * nothing that switches Belay off; this only opens adb and Settings' reset for a while.
 */
@Serializable
data class RecoveryState(
    /** Wrong tries since the last right one. */
    val wrongTries: Int = 0,
    /** The last wrong try: the wall clock, and the boot and time since it, which nobody can set. */
    val lastWrongAt: Long? = null,
    val lastWrongBoot: Int? = null,
    val lastWrongElapsed: Long? = null,
    /** Key versions used on this phone: they never work here again, even if a policy still has one. */
    val usedVersions: List<Int> = emptyList(),
    /** The last use, reported in enforcement.recovery. */
    val lastUse: WireRecoveryUse? = null,
)

/** The phone's clocks at a try: [now] (wall clock), and [boot] (BOOT_COUNT, if known) with [elapsed] since it. */
data class RecoveryClock(val now: Long, val boot: Int?, val elapsed: Long)

/** What a try of the recovery key did. */
sealed interface RecoveryOutcome {
    /** The key: repair access is open until [use].until. */
    data class Opened(val use: WireRecoveryUse) : RecoveryOutcome

    /** Not the key. [freeLeft]: wrong tries left before the waits start; [waitMs]: the wait before the next try. */
    data class Wrong(val freeLeft: Int, val waitMs: Long) : RecoveryOutcome

    /** Too many wrong tries: nothing is checked for [ms] more. */
    data class Wait(val ms: Long) : RecoveryOutcome

    /** Can't be a key (not 26 letters and numbers): not counted as a try. */
    data object NotAKey : RecoveryOutcome

    /** The policy has no recovery key for this phone. */
    data object NoKey : RecoveryOutcome

    /** This key was used on this phone already. */
    data object Used : RecoveryOutcome
}

object RecoveryRules {
    /** Wrong tries without a wait. */
    const val FREE_TRIES = 3
    const val FIRST_WAIT_MS = 60_000L
    const val MAX_WAIT_MS = 24L * 60 * 60 * 1000

    /** How long one use of the key opens repair access. */
    const val OPEN_MS = 24L * 60 * 60 * 1000
    const val MAX_USED_VERSIONS = 50

    /** The wait after [wrongTries] wrong tries: none for the first three, then a minute, doubling with each one after. */
    fun waitAfter(wrongTries: Int): Long {
        if (wrongTries < FREE_TRIES) return 0
        val doublings = (wrongTries - FREE_TRIES).coerceAtMost(20)
        return (FIRST_WAIT_MS shl doublings).coerceAtMost(MAX_WAIT_MS)
    }

    /**
     * How long until the next try may be checked (0: now). Within one boot it counts the time
     * since the boot, which nobody can set; after a restart, the wall clock. A clock that went
     * back past the last wrong try doesn't hold a parent off for as long as it went back: the
     * 130 random bits of the key are what keep guessers out, the wait only slows them.
     */
    fun remainingWait(state: RecoveryState, clock: RecoveryClock): Long {
        val wait = waitAfter(state.wrongTries)
        if (wait == 0L) return 0
        val sameBoot = clock.boot != null && clock.boot == state.lastWrongBoot && state.lastWrongElapsed != null &&
            clock.elapsed >= state.lastWrongElapsed
        val passed = if (sameBoot) {
            clock.elapsed - state.lastWrongElapsed
        } else {
            val at = state.lastWrongAt ?: return 0
            (clock.now - at).takeIf { it >= 0 } ?: return 0
        }
        return (wait - passed).coerceIn(0, wait)
    }

    /**
     * One try of [typed] against [check], the policy's recovery check (null: no key). The used
     * versions and the wait come first, so nothing is compared while either holds. A right key
     * opens repair access for [OPEN_MS] and its version is used up; a wrong one is counted.
     */
    fun attempt(state: RecoveryState, check: WireRecovery?, typed: String, clock: RecoveryClock): Pair<RecoveryState, RecoveryOutcome> {
        if (check == null) return state to RecoveryOutcome.NoKey
        if (check.version in state.usedVersions) return state to RecoveryOutcome.Used
        val remaining = remainingWait(state, clock)
        if (remaining > 0) return state to RecoveryOutcome.Wait(remaining)
        if (RecoveryKey.normalize(typed) == null) return state to RecoveryOutcome.NotAKey
        if (RecoveryKey.matches(check, typed)) {
            val use = WireRecoveryUse(version = check.version, usedAt = clock.now, until = clock.now + OPEN_MS)
            val used = (state.usedVersions + check.version).distinct().takeLast(MAX_USED_VERSIONS)
            return RecoveryState(usedVersions = used, lastUse = use) to RecoveryOutcome.Opened(use)
        }
        val tries = state.wrongTries + 1
        val next = state.copy(wrongTries = tries, lastWrongAt = clock.now, lastWrongBoot = clock.boot, lastWrongElapsed = clock.elapsed)
        return next to RecoveryOutcome.Wrong(freeLeft = (FREE_TRIES - tries).coerceAtLeast(0), waitMs = waitAfter(tries))
    }

    /**
     * Until when repair access is open, or null. Only between the use and its end on the
     * wall clock: a clock set back before the use, or past the end, closes it.
     */
    fun openUntil(state: RecoveryState, now: Long): Long? = state.lastUse?.takeIf { now >= it.usedAt && now < it.until }?.until
}
