package family.brooker.belay.enforce

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.UserHandle
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.CommandLog
import family.brooker.belay.core.CommandPlan
import family.brooker.belay.core.OtherUsers
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.service.ParentNotice

/**
 * Runs the one-shot commands core's Commands.plan says to run now, on the agent thread, and
 * reports the rest (expired, or a kind this Belay doesn't know). Each id runs once: the step
 * records it in the same transaction as what Belay applied (core's CommandLog).
 *
 * Phase 10, remove_other_users: every user or profile DevicePolicyManager.getSecondaryUsers
 * lists (all but the system user and managed profiles, a supervising profile included) goes,
 * with removeUser, as device owner. AOSP 17 removes it "even when disallowed", unless someone
 * other than the device owner set DISALLOW_REMOVE_USER (removeUser then returns false), and
 * marks it partial at once, so a second getSecondaryUsers no longer lists it
 * (docs/platform-notes.md V2). The kid is told first, and only when there is someone to remove.
 */
class CommandRunner(context: Context) {
    private val app = context.applicationContext

    /** The results, in the order the commands were handled. */
    fun run(plan: CommandPlan, owner: Boolean, now: Long): List<WireCommandResult> {
        val ran = plan.run.map { command ->
            val result = when (command.kind) {
                WireCommand.REMOVE_OTHER_USERS -> removeOtherUsers(command, owner)
                // Never: Commands.plan only runs the kinds in RUNS.
                else -> CommandLog.failed(command, now, CommandLog.UNKNOWN_PROBLEM)
            }
            Log.i(Agent.TAG, "command ${command.id} (${command.kind}): ${result.result}" + (result.problem?.let { ": $it" } ?: ""))
            result
        }
        val reported = CommandLog.notRun(plan, now)
        reported.forEach { Log.i(Agent.TAG, "command ${it.id}: ${it.result}, not run") }
        return ran + reported
    }

    private fun removeOtherUsers(command: WireCommand, owner: Boolean): WireCommandResult {
        if (!owner) return CommandLog.failed(command, System.currentTimeMillis(), "Belay isn't the device owner, so it can't remove other users or profiles.")
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(app)
        val users: List<UserHandle> = try {
            dpm.getSecondaryUsers(admin)
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "couldn't list other users", e)
            return CommandLog.failed(command, System.currentTimeMillis(), "Android didn't list the other users or profiles: ${e.javaClass.simpleName}.")
        }
        if (users.isEmpty()) return CommandLog.done(command, System.currentTimeMillis())
        ParentNotice.removingOtherUsers(app)
        var refused = 0
        var error: String? = null
        for (user in users) {
            try {
                if (!dpm.removeUser(admin, user)) refused++
            } catch (e: RuntimeException) {
                // SecurityException, or UnsafeStateException where removing users isn't safe now.
                Log.w(Agent.TAG, "removeUser failed", e)
                error = "${e.javaClass.simpleName}${e.message?.let { ": $it" } ?: ""}"
            }
        }
        val left = try {
            dpm.getSecondaryUsers(admin).size
        } catch (e: RuntimeException) {
            users.size
        }
        Log.i(Agent.TAG, "removed ${users.size - left} of ${users.size} other users or profiles")
        val problem = OtherUsers.removalProblem(users.size, left, refused, error)
        val at = System.currentTimeMillis()
        return if (problem == null) CommandLog.done(command, at) else CommandLog.failed(command, at, problem)
    }

    companion object {
        /** The kinds this build of Belay runs. lock_now comes with Phase 3's app wiring. */
        val RUNS: Set<String> = setOf(WireCommand.REMOVE_OTHER_USERS)
    }
}
