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
) {
    val doneIds: Set<String> get() = done.toSet()

    /** With [new] (in the order they ran) added: their ids are done, and they're the newest results. */
    fun record(new: List<WireCommandResult>): CommandLog {
        if (new.isEmpty()) return this
        val ids = new.map { it.id }
        return CommandLog(
            done = ((done - ids.toSet()) + ids).takeLast(MAX_DONE),
            results = (new.asReversed() + results.filter { it.id !in ids }).take(WireLimits.MAX_COMMAND_RESULTS),
        )
    }

    companion object {
        /** Far more than the policy ever lists at once; an id older than these is long gone from it. */
        const val MAX_DONE = 200

        const val UNKNOWN_PROBLEM = "Belay doesn't know this command yet. Updating Belay may help."

        /** The results for what [plan] doesn't run: expired commands, and kinds this Belay doesn't know. */
        fun notRun(plan: CommandPlan, now: Long): List<WireCommandResult> =
            plan.expired.map { WireCommandResult(it.id, WireCommandOutcome.EXPIRED, now) } +
                plan.unknown.map { WireCommandResult(it.id, WireCommandOutcome.FAILED, now, UNKNOWN_PROBLEM) }

        fun done(command: WireCommand, now: Long) = WireCommandResult(command.id, WireCommandOutcome.DONE, now)

        fun failed(command: WireCommand, now: Long, problem: String) =
            WireCommandResult(command.id, WireCommandOutcome.FAILED, now, problem.take(WireLimits.MAX_PROBLEM))
    }
}
