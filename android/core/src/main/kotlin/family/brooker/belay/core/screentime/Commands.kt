package family.brooker.belay.core.screentime

/** What to do with the policy's one-shot commands (`commands`) now. */
data class CommandPlan(
    /** lock_now commands to run now (DevicePolicyManager.lockNow), once each. */
    val lockNow: List<WireCommand>,
    /** Not run before they expired: report them as expired. */
    val expired: List<WireCommand>,
    /** Kinds this version of Belay can't run: report them as failed. */
    val unknown: List<WireCommand>,
)

object Commands {
    val KNOWN: Set<String> = setOf(WireCommand.LOCK_NOW)

    /** [done] holds the ids already run or reported; the phone adds each id once it has. */
    fun plan(commands: List<WireCommand>, done: Set<String>, now: Long): CommandPlan {
        val waiting = commands.filter { it.id !in done }.distinctBy { it.id }
        val (live, expired) = waiting.partition { now < it.expiresAt }
        return CommandPlan(
            lockNow = live.filter { it.kind == WireCommand.LOCK_NOW },
            expired = expired,
            unknown = live.filter { it.kind !in KNOWN },
        )
    }
}
