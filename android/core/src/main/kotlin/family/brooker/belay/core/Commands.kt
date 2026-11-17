package family.brooker.belay.core

/** What to do with the policy's one-shot commands now (docs/protocol.md, "Commands"). */
data class CommandPlan(
    /** Commands to run now, once each, in the policy's order. */
    val run: List<WireCommand>,
    /** Not run before they expired: report them as expired. */
    val expired: List<WireCommand>,
    /** Kinds this Belay can't run: report them as failed. */
    val unknown: List<WireCommand>,
) {
    /** lock_now commands to run now (DevicePolicyManager.lockNow). */
    val lockNow: List<WireCommand> get() = run.filter { it.kind == WireCommand.LOCK_NOW }
}

object Commands {
    /**
     * [done] holds the ids already run or reported; the phone adds each id once it has. [runs] is
     * the kinds this build of Belay carries out: anything else is reported, never guessed at.
     */
    fun plan(commands: List<WireCommand>, done: Set<String>, now: Long, runs: Set<String>): CommandPlan {
        val waiting = commands.filter { it.id !in done }.distinctBy { it.id }
        val (live, expired) = waiting.partition { command -> command.expiresAt.let { it == null || now < it } }
        val (run, unknown) = live.partition { it.kind in runs }
        return CommandPlan(run = run, expired = expired, unknown = unknown)
    }
}
