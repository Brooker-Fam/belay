package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.network.NetworkDay
import family.brooker.belay.core.network.NetworkDigest
import family.brooker.belay.core.network.NetworkKey
import family.brooker.belay.core.screentime.WireNetworkLog
import family.brooker.belay.enforce.EnforcementReport
import family.brooker.belay.inventory.Collectors
import family.brooker.belay.store.AgentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.UnknownHostException
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 3's network logging on the emulator, as device owner, with a policy set in place of the
 * server's (DebugTools.policyOverride): a step turns Android's network logging on (and reports it);
 * `dpm force-network-logs` hands Belay a batch, which it takes (Belay's own lookup in it is never
 * kept: Belay is never blocked); a step with logging off turns Android's off and deletes what Belay
 * counted. A website the family makes private leaves the days Belay kept at the next step, and
 * "What your parent can see" says other websites are never noted, without naming one. The test
 * puts the phone back as it was: the override cleared, and a step.
 */
@RunWith(AndroidJUnit4::class)
class NetworkLogInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val dpm = context.getSystemService(DevicePolicyManager::class.java)
    private val admin = DeviceOwnerSetup.admin(context)
    private val store = AgentStore.get(context)

    @Before
    fun emulatorAndDeviceOwner() {
        assumeTrue("emulators only", shell("getprop ro.kernel.qemu").trim() == "1" || shell("getprop ro.boot.qemu").trim() == "1")
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
    }

    @After
    fun putBack() {
        DebugTools.policyOverride = null
        agentStep()
    }

    @Test
    fun loggingFollowsThePolicyAndABatchIsTakenOnce() {
        val real = store.policy() ?: WirePolicy(version = 0)
        val on = real.copy(version = real.version + VERSION_OFFSET, networkLog = WireNetworkLog(enabled = true))
        DebugTools.policyOverride = on
        agentStep()
        assertTrue("Android's network logging isn't on", dpm.isNetworkLoggingEnabled(admin))
        val report = EnforcementReport.of(store)?.networkLog
        assertNotNull("no network_log in the report", report)
        assertTrue(report!!.enabled)
        assertEquals("paused, with no other user or profile", shell("pm list users").lines().count { it.contains("UserInfo{") } > 1, report.paused)
        val enabledAt = store.networkState()?.enabledAt
        assertNotNull("no network state", enabledAt)

        // A lookup by Belay itself (this test runs in Belay's process), then a batch now. Android
        // hears of a lookup after answering it, and finishes a batch only with events in it: a few tries.
        var taken = false
        for (attempt in 1..3) {
            try {
                InetAddress.getAllByName("belay-test-$attempt.example.com")
            } catch (e: UnknownHostException) {
                // Looked up all the same: Android logs the lookup, answer or not.
            }
            Thread.sleep(2_000)
            val forced = shell("dpm force-network-logs")
            assertTrue("dpm force-network-logs: $forced", forced.contains("Success"))
            taken = waitFor(10) { (store.networkState()?.lastToken ?: 0) > 0 }
            if (taken) break
        }
        assertTrue("Belay didn't take a batch (state: ${store.networkState()})", taken)
        val state = store.networkState()!!
        assertTrue("no lookups in the batch", state.lastBatchLookups > 0)
        // Belay never keeps its own lookups (it's never blocked).
        assertTrue(store.networkDays(store.networkDaySizes().map { it.first.day }).values.flatMap { it.counts.keys }.none { it.packageName == context.packageName })

        // The same step again changes nothing: logging stays on, the batch isn't taken twice.
        agentStep()
        assertEquals(state.lastToken, store.networkState()?.lastToken)
        assertEquals(enabledAt, store.networkState()?.enabledAt)

        DebugTools.policyOverride = on.copy(version = on.version + 1, networkLog = WireNetworkLog(enabled = false))
        agentStep()
        assertFalse("Android's network logging is still on", dpm.isNetworkLoggingEnabled(admin))
        assertNull(store.networkState())
        assertTrue(store.networkDaySizes().isEmpty())
        assertEquals(0, store.pendingNetworkCount())
        assertNull(EnforcementReport.of(store)?.networkLog)
    }

    @Test
    fun aWebsiteMadePrivateLeavesTheDaysKeptAndIsNeverNamedToTheKid() {
        val real = store.policy() ?: WirePolicy(version = 0)
        val on = real.copy(version = real.version + VERSION_OFFSET, networkLog = WireNetworkLog(enabled = true))
        DebugTools.policyOverride = on
        agentStep()
        val state = store.networkState()
        assertNotNull("no network state", state)
        assertNull("a private websites' digest with none listed", state!!.privateDigest)
        // A day Belay counted before the family made example.org private: made-up apps and names.
        val zone = ZoneId.systemDefault()
        val now = System.currentTimeMillis()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().toString()
        val day = NetworkDay(today, zone.id, now, mapOf(NetworkKey(CHAT, "example.org") to 3, NetworkKey(CHAT, "chat.example.org") to 1, NetworkKey(CHAT, "example.com") to 2))
        store.commitNetwork(listOf(day), listOf(NetworkDigest.wire(day)), state, NetworkDigest.keepFrom(zone, now), now)
        assertTrue(Collectors.categories(on).single { it.id == DataCategories.NETWORK_ID }.details.none { "private" in it })

        val private = on.copy(version = on.version + 1, networkLog = WireNetworkLog(enabled = true, privateDomains = listOf("example.org")))
        DebugTools.policyOverride = private
        agentStep()
        assertEquals(mapOf(NetworkKey(CHAT, "example.com") to 2), store.networkDays(listOf(today)).getValue(today).counts)
        val digest = store.networkState()?.privateDigest
        assertNotNull("the step didn't note the private websites it cleared", digest)
        // The same step again changes nothing.
        agentStep()
        assertEquals(digest, store.networkState()?.privateDigest)
        assertEquals(mapOf(NetworkKey(CHAT, "example.com") to 2), store.networkDays(listOf(today)).getValue(today).counts)
        // What your parent can see says other websites are never noted, and never which.
        val shown = Collectors.categories(private).single { it.id == DataCategories.NETWORK_ID }.details
        assertTrue(shown.joinToString("\n"), shown.any { "made private" in it })
        assertTrue(shown.none { "example.org" in it })
    }

    private fun waitFor(seconds: Int, check: () -> Boolean): Boolean {
        repeat(seconds * 2) {
            if (check()) return true
            Thread.sleep(500)
        }
        return check()
    }

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

        /** A made-up app, for days the test counts itself. */
        const val CHAT = "com.example.chat"
    }
}
