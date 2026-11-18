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
     * The lock_now commands that waited for a call at the last step (core's ScreenLocks): one that
     * expires before it runs is reported with `waited_for_call`, since a call was on until then.
     */
    val waitingForCall: List<String> = emptyList(),
) {
    val doneIds: Set<String> get() = done.toSet()

    /** With [new] (in the order they ran) added: their ids are done, and they're the newest results. */
    fun record(new: List<WireCommandResult>): CommandLog {
        if (new.isEmpty()) return this
        val ids = new.map { it.id }
        return CommandLog(
            done = ((done - ids.toSet()) + ids).takeLast(MAX_DONE),
            results = (new.asReversed() + results.filter { it.id !in ids }).take(WireLimits.MAX_COMMAND_RESULTS),
            waitingForCall = waitingForCall - ids.toSet(),
        )
    }

    /** With [ids] the lock_now commands that wait for a call after this step (none: no lock waits). */
    fun waiting(ids: List<String>): CommandLog = copy(waitingForCall = ids.distinct().take(MAX_DONE))

    companion object {
        /** Far more than the policy ever lists at once; an id older than these is long gone from it. */
        const val MAX_DONE = 200

        const val UNKNOWN_PROBLEM = "Belay doesn't know this command yet. Updating Belay may help."

        /**
         * The results for what [plan] doesn't run: expired commands, and kinds this Belay doesn't
         * know. A lock_now in [waitedForCall] (it waited for a call at the last step) expired while
         * the call was on: its result says so (`waited_for_call`).
         */
        fun notRun(plan: CommandPlan, now: Long, waitedForCall: Collection<String> = emptyList()): List<WireCommandResult> =
            plan.expired.map { command ->
                val waited = command.kind == WireCommand.LOCK_NOW && command.id in waitedForCall
                WireCommandResult(command.id, WireCommandOutcome.EXPIRED, now, waitedForCall = true.takeIf { waited })
            } + plan.unknown.map { WireCommandResult(it.id, WireCommandOutcome.FAILED, now, UNKNOWN_PROBLEM) }

        fun done(command: WireCommand, now: Long) = WireCommandResult(command.id, WireCommandOutcome.DONE, now)

        fun failed(command: WireCommand, now: Long, problem: String) =
            WireCommandResult(command.id, WireCommandOutcome.FAILED, now, problem.take(WireLimits.MAX_PROBLEM))
    }
}
