package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.UserManager
import android.provider.Settings
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.ChromeConfig
import family.brooker.belay.core.Lock
import family.brooker.belay.core.PlayAccounts
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireAppDecision
import family.brooker.belay.core.WireAppState
import family.brooker.belay.core.WireChangeKind
import family.brooker.belay.core.WireChromePolicy
import family.brooker.belay.core.WireEvent
import family.brooker.belay.core.WireNewApps
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequest
import family.brooker.belay.enforce.Enforcer
import family.brooker.belay.enforce.PhoneFacts
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.HealthReader
import family.brooker.belay.store.AgentStore
import family.brooker.belay.sync.Http
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 2 enforcement on the phone, as device owner (skipped otherwise), with a policy set
 * in place of the server's (DebugTools.policyOverride, debug builds only), so the long-poll
 * can't change it mid-test. Each test puts the phone back as it found it: the override is
 * cleared and a step re-applies the real policy, and the fixture app is removed.
 *
 * Only safe things: suspending and hiding the made-up fixture app, DISALLOW_SAFE_BOOT, and Play's
 * allowed accounts (made-up ones, on images without Play). Never DISALLOW_FACTORY_RESET,
 * DISALLOW_DEBUGGING_FEATURES or reset protection (CLAUDE.md, "Ask before"); debug builds refuse
 * them anyway.
 *
 * The fixture test needs the fixture APK on the device, like FixtureEventsInstrumentedTest.
 */
@RunWith(AndroidJUnit4::class)
class EnforcementInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val pm = context.packageManager
    private val dpm = context.getSystemService(DevicePolicyManager::class.java)
    private val um = context.getSystemService(UserManager::class.java)
    private val admin = DeviceOwnerSetup.admin(context)
    private val store = AgentStore.get(context)

    @Before
    fun deviceOwner() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
    }

    @After
    fun putBack() {
        DebugTools.policyOverride = null
        agentStep()
    }

    @Test
    fun askSuspendsANewAppAndAParentsDecisionLetsItRunOrHidesIt() {
        assumeTrue("fixture APK not in /data/local/tmp", V1 in shell("ls $V1"))
        shell("pm uninstall $FIXTURE")
        agentStep()
        val base = basePolicy()
        try {
            DebugTools.policyOverride = asking(base, 1)
            agentStep()
            // Every app already here is allowed, so turning on "ask" holds nothing back.
            assertEquals(emptyList<String>(), Agent.view.value?.kid?.plan?.waiting)

            val installedAt = System.currentTimeMillis()
            assertTrue(shell("pm install -r -t $V1").contains("Success"))
            awaitTrue("the new app wasn't suspended on install") { isSuspended(FIXTURE) }
            awaitTrue("Belay didn't ask for the new app") { store.requestsQueuedFor(FIXTURE).any { it.createdAt >= installedAt } }
            val asked = Wire.json.decodeFromString(WireRequest.serializer(), store.requestsQueuedFor(FIXTURE).last().payload)
            assertEquals("Belay asks by itself, without a reason", null, asked.reason)

            // A parent approves it: it runs.
            DebugTools.policyOverride = asking(base, 2, WireAppState.ALLOWED)
            agentStep()
            assertFalse("approved, but still suspended", isSuspended(FIXTURE))
            assertFalse(FIXTURE in store.applied().suspended)

            // A parent blocks it: hidden and suspended, and still in the inventory (not "removed").
            DebugTools.policyOverride = asking(base, 3, WireAppState.BLOCKED)
            agentStep()
            assertTrue("blocked, but not hidden", dpm.isApplicationHidden(admin, FIXTURE))
            assertTrue("blocked, but not suspended", isSuspended(FIXTURE))
            Thread.sleep(2_000) // hiding sends PACKAGE_REMOVED: let its step run
            agentStep()
            assertTrue("a hidden app left the inventory", FIXTURE in store.loadBaseline().inventory)
            assertFalse("hiding read as a removal", events(installedAt).any { it.kind == WireChangeKind.REMOVED })

            // The block lifted: shown again and running.
            DebugTools.policyOverride = asking(base, 4, WireAppState.ALLOWED)
            agentStep()
            assertFalse(dpm.isApplicationHidden(admin, FIXTURE))
            assertFalse(isSuspended(FIXTURE))
        } finally {
            DebugTools.policyOverride = null
            agentStep()
            shell("pm uninstall $FIXTURE")
            agentStep()
        }
        val applied = store.applied()
        assertFalse("Belay still holds the removed app", FIXTURE in applied.suspended || FIXTURE in applied.hidden)
    }

    @Test
    fun aSafeRestrictionIsSetAndCleared() {
        val before = um.hasUserRestriction(UserManager.DISALLOW_SAFE_BOOT)
        assumeTrue("safe boot is locked by something other than Belay", !before || Lock.SAFE_BOOT in store.applied().locks)
        val base = basePolicy()
        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET, restrictions = base.restrictions.copy(safeBoot = !before))
        agentStep()
        assertEquals(!before, um.hasUserRestriction(UserManager.DISALLOW_SAFE_BOOT))
        assertEquals(!before, Lock.SAFE_BOOT in store.applied().locks)

        DebugTools.policyOverride = null
        agentStep()
        assertEquals(before, um.hasUserRestriction(UserManager.DISALLOW_SAFE_BOOT))
    }

    /**
     * Play's allowed accounts (platform notes A4). The CI images have no Play Store: Android keeps a
     * package's managed configuration whether or not it's installed, so this runs there too.
     */
    @Test
    fun playsAllowedAccountsAreSetInItsManagedConfigurationAndTakenBack() {
        val before = dpm.getApplicationRestrictions(admin, PlayAccounts.PLAY_STORE)
        assumeTrue("Play's configuration holds something Belay didn't set", before.isEmpty || store.applied().playAccounts != null)
        val base = basePolicy()
        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET, playAccounts = listOf("Parent@Example.org", "co.parent@example.org"))
        agentStep()
        assertEquals("parent@example.org,co.parent@example.org", dpm.getApplicationRestrictions(admin, PlayAccounts.PLAY_STORE).getString(PlayAccounts.KEY))
        assertEquals(listOf("parent@example.org", "co.parent@example.org"), store.applied().playAccounts)

        // None in the policy: Belay takes the key back, and with it the configuration it set.
        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET + 1, playAccounts = emptyList())
        agentStep()
        assertFalse(dpm.getApplicationRestrictions(admin, PlayAccounts.PLAY_STORE).containsKey(PlayAccounts.KEY))
        assertNull(store.applied().playAccounts)
    }

    /**
     * Chrome's managed configuration tells Chrome to ignore the phone's proxies (platform notes H2),
     * with Secure DNS off. The CI images have no Chrome: Android keeps the configuration anyway.
     */
    @Test
    fun chromesConfigurationTurnsProxiesAndSecureDnsOff() {
        val before = dpm.getApplicationRestrictions(admin, Enforcer.CHROME)
        assumeTrue("Chrome's configuration holds something Belay didn't set", before.isEmpty || store.applied().chrome != null)
        val base = basePolicy()
        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET, web = base.web.copy(chrome = WireChromePolicy()))
        agentStep()
        val config = dpm.getApplicationRestrictions(admin, Enforcer.CHROME)
        assertEquals("""{"ProxyMode":"direct"}""", config.getString("ProxySettings"))
        assertEquals("off", config.getString("DnsOverHttpsMode"))
        assertEquals(ChromeConfig.PROXY_DIRECT, store.applied().chrome?.proxySettings)
    }

    /**
     * The date and time lock keeps the time zone automatic too (platform notes H8), and hands it
     * back with the lock. Only where both are automatic already (the emulators' default), so the
     * test changes nothing a later step relies on.
     */
    @Test
    fun aLockedClockKeepsTheTimeZoneAutomatic() {
        val automatic = { name: String -> Settings.Global.getInt(context.contentResolver, name, 0) == 1 }
        assumeTrue("the clock or its zone isn't automatic here", automatic(Settings.Global.AUTO_TIME) && automatic(Settings.Global.AUTO_TIME_ZONE))
        assumeTrue("the date and time are locked by something other than Belay", !um.hasUserRestriction(UserManager.DISALLOW_CONFIG_DATE_TIME) || Lock.CONFIG_DATE_TIME in store.applied().locks)
        val base = basePolicy()
        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET, restrictions = base.restrictions.copy(configDateTime = true))
        agentStep()
        assertTrue(um.hasUserRestriction(UserManager.DISALLOW_CONFIG_DATE_TIME))
        assertTrue(store.applied().autoTimeZone)
        assertTrue(automatic(Settings.Global.AUTO_TIME_ZONE))
        if (Build.VERSION.SDK_INT >= 36) assertEquals(DevicePolicyManager.AUTO_TIME_ZONE_ENABLED, dpm.autoTimeZonePolicy)

        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET + 1)
        agentStep()
        assertFalse(store.applied().autoTimeZone)
        if (Build.VERSION.SDK_INT >= 36) assertEquals(DevicePolicyManager.AUTO_TIME_ZONE_NOT_CONTROLLED_BY_POLICY, dpm.autoTimeZonePolicy)
    }

    /**
     * Belay sees a proxy on the network (platform notes H2). A global one, the way adb sets it, for
     * a few seconds: it's the one the emulator can have without a Wi-Fi network to edit.
     */
    @Test
    fun aProxyIsSeenAndGoneAgain() {
        // Belay's own connection never goes through one, so a proxy can't hold its reports back.
        assertEquals(Proxy.NO_PROXY, Http.client.proxy)
        assumeTrue("this phone already has a proxy", !PhoneFacts.proxy(context))
        try {
            shell("settings put global http_proxy 127.0.0.1:9")
            awaitTrue("Belay didn't see the proxy") { PhoneFacts.proxy(context) }
        } finally {
            // ":0" is how a global proxy set this way is cleared. ConnectivityService reads the
            // setting only when it handles the change, and an empty one changes nothing (AOSP 17
            // ProxyTracker.loadDeprecatedGlobalHttpProxy), so the setting goes only once the proxy
            // has: deleted sooner, before the change is handled, it can leave the proxy on for good.
            shell("settings put global http_proxy :0")
            try {
                awaitTrue("Belay still sees a proxy") { !PhoneFacts.proxy(context) }
            } finally {
                shell("settings delete global http_proxy")
            }
        }
    }

    @Test
    fun theEnforcementReportGoesWithTheDeviceStatus() {
        val base = basePolicy()
        DebugTools.policyOverride = base.copy(version = base.version + VERSION_OFFSET)
        agentStep()
        val device = DeviceStatus.read(context, HealthReader(context).read())
        assertEquals(base.version + VERSION_OFFSET, device.enforcement?.policyVersion)
        assertTrue((device.enforcement?.problems ?: emptyList()).all { it.length <= 200 })
    }

    /**
     * The real policy (or none), changed so that it changes nothing for the apps already on
     * the phone: each user app without a decision is allowed, as the server records when a
     * parent first turns on "ask". The fixture never has a decision here.
     */
    private fun basePolicy(): WirePolicy {
        val real = store.policy() ?: WirePolicy(version = 0)
        val decided = real.apps.decisions.mapTo(HashSet()) { it.packageName }
        val allowed = store.loadBaseline().inventory.values
            .filter { !it.system && it.packageName != FIXTURE && it.packageName !in decided }
            .map { WireAppDecision(it.packageName, WireAppState.ALLOWED) }
        return real.copy(apps = real.apps.copy(decisions = real.apps.decisions.filter { it.packageName != FIXTURE } + allowed))
    }

    private fun asking(base: WirePolicy, step: Int, fixture: WireAppState? = null) = base.copy(
        version = base.version + VERSION_OFFSET + step,
        apps = base.apps.copy(
            newApps = WireNewApps.ASK,
            decisions = base.apps.decisions + listOfNotNull(fixture?.let { WireAppDecision(FIXTURE, it) }),
        ),
    )

    private fun isSuspended(name: String): Boolean = try {
        pm.isPackageSuspended(name)
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun events(since: Long): List<WireEvent> = store.eventsFor(FIXTURE)
        .filter { it.createdAt >= since }
        .map { Wire.json.decodeFromString(WireEvent.serializer(), it.payload) }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    private fun awaitTrue(what: String, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 30_000
        while (!check()) {
            check(System.currentTimeMillis() < deadline) { "$what (after 30 s)" }
            Thread.sleep(250)
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
        const val VERSION_OFFSET = 1_000_000
    }
}
