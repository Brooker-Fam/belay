package family.brooker.belay.core

import kotlinx.serialization.Serializable

/**
 * Which one-shot commands the phone has run or reported, and their last results
 * (docs/protocol.md, "Commands"), kept across restarts. Commands.plan decides what to run;
 * this keeps each id from running twice, even while the policy still lists it (the server
 * only drops a command once it has the result).
 */
@Serializable
data class CommandLog(
    /** Ids run or reported, oldest first, at most [MAX_DONE]. */
    val done: List<String> = emptyList(),
    /** Newest first, at most WireLimits.MAX_COMMAND_RESULTS: enforcement.commands. */
    val results: List<WireCommandResult> = emptyList(),
    /**
     * A lock_now's lock that waits for a call to end (core's ScreenLocks.lockNow): its commands
     * were reported done when the phone had them, and the screen locks at the first step with no
     * call on. Null when none is due.
     */
    val lockDue: LockDue? = null,
) {
    val doneIds: Set<String> get() = done.toSet()

    /** With [new] (in the order they ran) added: their ids are done, and they're the newest results. */
    fun record(new: List<WireCommandResult>): CommandLog {
        if (new.isEmpty()) return this
        val ids = new.map { it.id }
        return copy(
            done = ((done - ids.toSet()) + ids).takeLast(MAX_DONE),
            results = (new.asReversed() + results.filter { it.id !in ids }).take(WireLimits.MAX_COMMAND_RESULTS),
        )
    }

    /** With [lock] the lock_now lock due after this step (null: none). */
    fun due(lock: LockDue?): CommandLog = if (lock == lockDue) this else copy(lockDue = lock)

    companion object {
        /** Far more than the policy ever lists at once; an id older than these is long gone from it. */
        const val MAX_DONE = 200

        const val UNKNOWN_PROBLEM = "Belay doesn't know this command yet. Updating Belay may help."

        /**
         * The results for what [plan] doesn't run: expired commands (the phone got them too late;
         * a lock_now never expires for a call, since it's reported when the phone has it), and kinds
         * this Belay doesn't know.
         */
        fun notRun(plan: CommandPlan, now: Long): List<WireCommandResult> =
            plan.expired.map { WireCommandResult(it.id, WireCommandOutcome.EXPIRED, now) } +
                plan.unknown.map { WireCommandResult(it.id, WireCommandOutcome.FAILED, now, UNKNOWN_PROBLEM) }

        fun done(command: WireCommand, now: Long) = WireCommandResult(command.id, WireCommandOutcome.DONE, now)

        fun failed(command: WireCommand, now: Long, problem: String) =
            WireCommandResult(command.id, WireCommandOutcome.FAILED, now, problem.take(WireLimits.MAX_PROBLEM))
    }
}
