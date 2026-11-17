package family.brooker.belay

import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.telecom.TelecomManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.screentime.LocalTimes
import family.brooker.belay.core.screentime.UsageEventType
import family.brooker.belay.core.screentime.WireDay
import family.brooker.belay.core.screentime.WireLimit
import family.brooker.belay.core.screentime.WireSchedule
import family.brooker.belay.core.screentime.WireScheduleKind
import family.brooker.belay.core.screentime.WireScreenTime
import family.brooker.belay.screentime.UsageReader
import family.brooker.belay.store.AgentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 3 screen time on the phone, as device owner with usage access (skipped otherwise), with
 * a policy set in place of the server's (DebugTools.policyOverride, debug builds only). Each
 * test puts the phone back: the override is cleared and a step lets go of what it suspended,
 * the fixture app is removed, and the screen is woken and unlocked (a swipe lock screen only:
 * the emulators have no PIN).
 *
 * Only made-up apps are limited (the fixture). A schedule pauses every app but the never-blocked
 * ones for a few seconds. lock_now turns the screen off. Needs the fixture APK on the device,
 * like FixtureEventsInstrumentedTest; it has a launcher activity from Phase 3.
 */
@RunWith(AndroidJUnit4::class)
class ScreenTimeInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val pm = context.packageManager
    private val store = AgentStore.get(context)

    @Before
    fun deviceOwnerWithUsageAccess() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        assumeTrue("no usage access (provision.sh grants it)", UsageReader(context).usageAccess())
        wake()
    }

    @After
    fun putBack() {
        DebugTools.policyOverride = null
        agentStep()
        shell("pm uninstall $FIXTURE")
        agentStep()
        wake()
    }

    @Test
    fun belayAsksAndroidForExactlyTheEventTypesCoreCounts() {
        assertEquals(UsageEventType.CODES.toSet(), UsageReader.TYPES)
    }

    @Test
    fun openingTheFixtureAppShowsUpInTheLedger() {
        installFixture()
        DebugTools.policyOverride = withScreenTime(WireScreenTime(), 1)
        agentStep()
        assertTrue("no screen time row", store.hasScreenTime())

        shell("am start -W -n $FIXTURE/.FixtureActivity")
        Thread.sleep(3_000)
        shell("input keyevent KEYCODE_HOME")
        // Events in the last 10 seconds are read again at the next step (core's SETTLE_MS).
        awaitTrue("the fixture's time isn't in the ledger") {
            agentStep()
            store.screenTime()?.ledger?.log?.apps?.get(FIXTURE).orEmpty().sumOf { it.millis } >= 1_000
        }
        val usage = Agent.view.value?.kid?.screenTime?.usage
        assertTrue("the Today screen's count has the fixture", (usage?.apps?.get(FIXTURE).orEmpty().sumOf { it.millis }) >= 1_000)
    }

    @Test
    fun aLimitOfZeroMinutesSuspendsTheFixtureAppAndRemovingItLetsItRun() {
        installFixture()
        val zero = WireLimit("t-zero", "Test limit", listOf(FIXTURE), 0)
        DebugTools.policyOverride = withScreenTime(WireScreenTime(limits = listOf(zero)), 1)
        agentStep()
        assertTrue("a 0-minute limit didn't suspend the fixture", isSuspended(FIXTURE))
        assertEquals(listOf("app_limit"), store.applied().reasons[FIXTURE])

        DebugTools.policyOverride = withScreenTime(WireScreenTime(), 2)
        agentStep()
        assertFalse("the limit is gone, but the fixture is still suspended", isSuspended(FIXTURE))
    }

    @Test
    fun aScheduleOnNowSuspendsTheFixtureAppButNeitherBelayNorTheDialer() {
        installFixture()
        val zone = ZoneId.systemDefault()
        val now = System.currentTimeMillis()
        fun clock(at: Long) = LocalTimes.clockText(Instant.ofEpochMilli(at).atZone(zone).toLocalTime())
        // Every day, so a start just before midnight still covers now.
        val schedule = WireSchedule(
            "t-now", WireScheduleKind.CUSTOM, "Test schedule", WireDay.entries.toList(),
            start = clock(now - 60_000), end = clock(now + 30 * 60_000),
        )
        DebugTools.policyOverride = withScreenTime(WireScreenTime(schedules = listOf(schedule)), 1)
        agentStep()
        assertTrue("the schedule didn't suspend the fixture", isSuspended(FIXTURE))
        assertEquals(listOf("schedule"), store.applied().reasons[FIXTURE])
        assertFalse("Belay suspended itself", isSuspended(context.packageName))
        dialers().forEach { assertFalse("the dialer $it is suspended", isSuspended(it)) }

        DebugTools.policyOverride = withScreenTime(WireScreenTime(), 2)
        agentStep()
        assertFalse("the schedule is gone, but the fixture is still suspended", isSuspended(FIXTURE))
    }

    @Test
    fun lockNowLocksTheScreenOnceAndIsReportedDone() {
        val power = context.getSystemService(PowerManager::class.java)
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        assertTrue("the screen should be on to start with", power.isInteractive)
        val command = WireCommand("test-lock-${UUID.randomUUID()}", WireCommand.LOCK_NOW, System.currentTimeMillis())
        DebugTools.policyOverride = (store.policy() ?: WirePolicy(version = 0)).let { it.copy(version = it.version + VERSION_OFFSET, commands = listOf(command)) }
        agentStep()
        awaitTrue("the screen didn't turn off or lock") { !power.isInteractive || keyguard.isKeyguardLocked }
        assertEquals(WireCommandOutcome.DONE, store.commandLog().results.first { it.id == command.id }.result)

        // A command runs once per id, even while the policy still lists it.
        wake()
        agentStep()
        Thread.sleep(1_000)
        assertTrue("lock_now ran twice", power.isInteractive)
    }

    @Test
    fun turningUsageAccessOffIsNoticedAndBackOnToo() {
        DebugTools.policyOverride = withScreenTime(WireScreenTime(limits = listOf(WireLimit("t-limit", "Test limit", listOf(FIXTURE), 60))), 1)
        agentStep()
        try {
            shell("appops set ${context.packageName} GET_USAGE_STATS ignore")
            // The app-op watcher runs a step by itself (ScreenWatcher).
            awaitTrue("usage access off wasn't noticed") { Agent.view.value?.kid?.screenTime?.decision?.measured == false }
        } finally {
            shell("appops set ${context.packageName} GET_USAGE_STATS allow")
        }
        awaitTrue("usage access back on wasn't noticed") { Agent.view.value?.kid?.screenTime?.decision?.measured == true }
    }

    /** The real policy (or none) with [screenTime], under a version of its own. */
    private fun withScreenTime(screenTime: WireScreenTime, step: Int): WirePolicy {
        val real = store.policy() ?: WirePolicy(version = 0)
        return real.copy(version = real.version + VERSION_OFFSET + step, screenTime = screenTime)
    }

    private fun installFixture() {
        assumeTrue("fixture APK not in /data/local/tmp", V1 in shell("ls $V1"))
        assertTrue(shell("pm install -r -t $V1").contains("Success"))
        // The inventory sees it (and that it has a launcher icon) at the next step.
        awaitTrue("Belay's inventory doesn't have the fixture as launchable") {
            agentStep()
            store.loadBaseline().inventory[FIXTURE]?.launchable == true
        }
    }

    private fun dialers(): Set<String> {
        val telecom = context.getSystemService(TelecomManager::class.java)
        return setOfNotNull(telecom?.defaultDialerPackage, telecom?.systemDialerPackage).filter { installed(it) }.toSet()
    }

    private fun installed(name: String): Boolean = try {
        pm.getPackageInfo(name, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun isSuspended(name: String): Boolean = try {
        pm.isPackageSuspended(name)
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    /** The screen on and the swipe lock screen out of the way, so the fixture counts. */
    private fun wake() {
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
        Thread.sleep(500)
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    private fun awaitTrue(what: String, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 30_000
        while (!check()) {
            check(System.currentTimeMillis() < deadline) { "$what (after 30 s)" }
            Thread.sleep(500)
        }
    }

    /** As the shell user; its standard output. */
    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private companion object {
        const val FIXTURE = "family.brooker.belay.fixture"
        const val V1 = "/data/local/tmp/belay-fixture-v1.apk"

        /** Test policies get versions of their own, well past the server's. */
        const val VERSION_OFFSET = 2_000_000
    }
}
