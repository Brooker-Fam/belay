package family.brooker.belay

import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireChangeKind
import family.brooker.belay.core.WireEvent
import family.brooker.belay.store.AgentStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Installs the :fixture app, updates it and removes it, and checks that each change reached
 * the outbox as an event (whether or not it has been sent since). Needs the two fixture APKs
 * on the device (skipped otherwise):
 *
 *     ./gradlew :fixture:assembleV1Debug :fixture:assembleV2Debug
 *     adb push fixture/build/outputs/apk/v1/debug/fixture-v1-debug.apk /data/local/tmp/belay-fixture-v1.apk
 *     adb push fixture/build/outputs/apk/v2/debug/fixture-v2-debug.apk /data/local/tmp/belay-fixture-v2.apk
 *
 * Works with or without device owner: the test runs in Belay's own process, whose package
 * receiver (PackageWatcher) and agent are live.
 */
@RunWith(AndroidJUnit4::class)
class FixtureEventsInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val store = AgentStore.get(context)

    /** As the shell user; its standard output. */
    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    @Before
    fun fixturesArePushed() {
        val listed = shell("ls $V1 $V2")
        assumeTrue("fixture APKs not in /data/local/tmp (see the class comment)", V1 in listed && V2 in listed)
    }

    @Test
    fun installUpdateAndRemoveReachTheOutbox() {
        // Left over from an earlier run, if any. pm returns once it's gone, so the next step's
        // getChangedPackages sees it: after that step the baseline no longer has the fixture,
        // and nothing from the cleanup can show up after `start`.
        shell("pm uninstall $FIXTURE")
        agentStep()
        assertTrue(FIXTURE !in store.loadBaseline().inventory)
        val start = System.currentTimeMillis()

        assertTrue(shell("pm install -r -t $V1").contains("Success"))
        val installed = awaitEvent(WireChangeKind.INSTALLED, start)
        assertEquals(1L, installed.to?.code)
        assertNotNull("an installed event carries the package", installed.app)
        assertEquals(FIXTURE, installed.app?.packageName)
        assertTrue(installed.app?.source in setOf("adb", "unknown"))

        assertTrue(shell("pm install -r -t $V2").contains("Success"))
        val updated = awaitEvent(WireChangeKind.UPDATED, start)
        assertEquals(1L, updated.from?.code)
        assertEquals(2L, updated.to?.code)
        assertEquals(2L, updated.app?.versionCode)

        assertTrue(shell("pm uninstall $FIXTURE").contains("Success"))
        val removed = awaitEvent(WireChangeKind.REMOVED, start)
        assertEquals(2L, removed.from?.code)
        assertNull("a removal carries no package", removed.app)
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    /** The first [kind] event for the fixture made since [since], waiting up to 30 s for it. */
    private fun awaitEvent(kind: WireChangeKind, since: Long): WireEvent {
        val deadline = System.currentTimeMillis() + 30_000
        while (true) {
            val event = store.eventsFor(FIXTURE)
                .filter { it.createdAt >= since }
                .map { Wire.json.decodeFromString(WireEvent.serializer(), it.payload) }
                .firstOrNull { it.kind == kind }
            if (event != null) return event
            check(System.currentTimeMillis() < deadline) { "no $kind event for $FIXTURE in the outbox after 30 s" }
            Thread.sleep(250)
        }
    }

    private companion object {
        const val FIXTURE = "family.brooker.belay.fixture"
        const val V1 = "/data/local/tmp/belay-fixture-v1.apk"
        const val V2 = "/data/local/tmp/belay-fixture-v2.apk"
    }
}
