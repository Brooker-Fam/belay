package family.brooker.belay

import android.os.ParcelFileDescriptor
import android.os.UserManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.HealthReader
import family.brooker.belay.store.AgentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 10 on the emulator only (a test must never add a user to a real phone), as device
 * owner: a user made with `pm create-user` from the shell is counted in health.other_users,
 * and a remove_other_users command (in a policy set in place of the server's,
 * DebugTools.policyOverride) removes it, once. The test puts the phone back: the user is
 * gone, the override cleared, and the command log as it was.
 */
@RunWith(AndroidJUnit4::class)
class OtherUsersInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val um = context.getSystemService(UserManager::class.java)
    private val store = AgentStore.get(context)
    private var made: Int? = null
    private var logBefore = store.commandLog()

    @Before
    fun emulatorAndDeviceOwner() {
        assumeTrue("emulators only", shell("getprop ro.kernel.qemu").trim() == "1" || shell("getprop ro.boot.qemu").trim() == "1")
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        logBefore = store.commandLog()
    }

    @After
    fun putBack() {
        made?.let { shell("pm remove-user $it") }
        DebugTools.policyOverride = null
        store.commitEnforcement(null, emptyList(), System.currentTimeMillis(), logBefore)
        agentStep()
    }

    @Test
    fun anotherUserIsCountedAndRemoveOtherUsersRemovesIt() {
        // Adding users unlocked (Belay locks it when the real policy says so).
        val real = store.policy() ?: WirePolicy(version = 0)
        val base = real.copy(version = real.version + VERSION_OFFSET, restrictions = real.restrictions.copy(addUser = false), commands = emptyList())
        DebugTools.policyOverride = base
        agentStep()
        assumeFalse("adding users is locked by something other than Belay", um.hasUserRestriction(UserManager.DISALLOW_ADD_USER))
        val before = otherUsers()
        assertNotNull("other_users is null for a device owner", before)

        val out = shell("pm create-user belay-test-user")
        made = Regex("created user id (\\d+)").find(out)?.groupValues?.get(1)?.toInt()
        assertNotNull("pm create-user: $out", made)
        agentStep()
        assertEquals(before!! + 1, otherUsers())

        val command = WireCommand("test-remove-other-users-${UUID.randomUUID()}", WireCommand.REMOVE_OTHER_USERS, issuedAt = System.currentTimeMillis())
        DebugTools.policyOverride = base.copy(version = base.version + 1, commands = listOf(command))
        agentStep()
        val result = store.commandLog().results.firstOrNull { it.id == command.id }
        assertNotNull("no result for the command", result)
        assertEquals("problem: ${result!!.problem}", WireCommandOutcome.DONE, result.result)
        assertEquals(0, otherUsers())
        assertTrue("the user is still listed", made.toString() !in userIds())
        made = null

        // Once per id: the policy still lists it, and nothing runs again.
        agentStep()
        assertEquals(1, store.commandLog().results.count { it.id == command.id })
        assertEquals(result, store.commandLog().results.first { it.id == command.id })
    }

    private fun otherUsers(): Int? = DeviceStatus.read(context, HealthReader(context).read()).health.otherUsers

    /** The ids `cmd user list` shows, like "10" from "UserInfo{10:belay-test-user:400}". */
    private fun userIds(): List<String> = Regex("UserInfo\\{(\\d+):").findAll(shell("cmd user list")).map { it.groupValues[1] }.toList()

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    /** As the shell user; its standard output. */
    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private companion object {
        /** Test policies get versions of their own, well past the server's. */
        const val VERSION_OFFSET = 2_000_000
    }
}
