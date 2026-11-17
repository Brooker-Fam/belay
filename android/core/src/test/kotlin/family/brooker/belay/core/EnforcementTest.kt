package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.inventory
import family.brooker.belay.core.screentime.WireScreenTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up apps; the system package names are AOSP's own. */
class EnforcementTest {
    private val belay = app("family.example.belay", label = "Belay")
    private val dialer = app("com.example.dialer", label = "Phone", system = true)
    private val messages = app("com.example.messages", label = "Messages", system = true)
    private val launcher = app("com.example.launcher", label = "Home", system = true)
    private val settings = app("com.android.settings", label = "Settings", system = true)
    private val safety = app("com.example.safety", label = "Safety", system = true)
    private val keyboard = app("com.example.keyboard", label = "Keyboard", system = true)
    private val clock = app("com.example.clock", label = "Clock", system = true)
    private val browser = app("com.example.browser", label = "Browser", system = true)
    private val camera = app("com.example.camera", label = "Camera", system = true)
    private val systemUi = app("com.android.systemui", label = "System UI", system = true).copy(launchable = false)
    private val phoneService = app("com.android.phone", label = "Phone Services", system = true).copy(launchable = false)
    private val webView = app("com.example.webview", label = "WebView", system = true).copy(launchable = false)
    private val framework = app("android", label = "Android System", system = true).copy(launchable = false)
    private val game = app("com.example.game", label = "Block Builder")
    private val chat = app("com.example.chat", label = "Chatter Box")
    private val notes = app("com.example.notes", label = "Notes")
    private val widget = app("com.example.widgetonly", label = "Widget").copy(launchable = false)

    private val apps = inventory(
        belay, dialer, messages, launcher, settings, safety, keyboard, clock, browser, camera, systemUi,
        phoneService, webView, framework, game, chat, notes, widget,
    )

    private val roles = PhoneRoles(
        self = belay.packageName,
        dialers = setOf(dialer.packageName),
        texting = setOf(messages.packageName),
        emergency = setOf(safety.packageName),
        home = setOf(launcher.packageName),
        settings = setOf(settings.packageName),
        keyboards = setOf(keyboard.packageName),
        browsers = setOf(browser.packageName),
        pauseExempt = setOf(clock.packageName, keyboard.packageName),
    )

    /** Everything a parent can't block: the protocol's list. */
    private val neverBlocked = setOf(
        belay, dialer, messages, launcher, settings, safety, keyboard, systemUi, phoneService, webView, framework,
    ).map { it.packageName }

    private fun policy(
        version: Int = 1,
        newApps: WireNewApps = WireNewApps.ALLOW,
        decisions: Map<PackageRecord, WireAppState> = emptyMap(),
        pause: WirePause? = null,
        restrictions: WireRestrictions = WireRestrictions(),
        web: WireWebPolicy = WireWebPolicy(),
        maintenanceUntil: Long? = null,
        frpAccounts: List<String> = emptyList(),
        playAccounts: List<String> = emptyList(),
    ) = WirePolicy(
        version = version,
        apps = WireAppPolicy(newApps, decisions.map { (app, state) -> WireAppDecision(app.packageName, state) }),
        pause = pause,
        restrictions = restrictions,
        web = web,
        maintenanceUntil = maintenanceUntil,
        frpAccounts = frpAccounts,
        playAccounts = playAccounts,
    )

    private fun plan(
        policy: WirePolicy,
        applied: Applied = Applied(),
        debugBuild: Boolean = false,
        sdkFull: Int = Enforcement.sdkFull(37),
        now: Long = T0,
        installed: Map<String, PackageRecord> = apps,
        phoneRoles: PhoneRoles = roles,
    ) = Enforcement.plan(Enforcement.Input(policy, installed, phoneRoles, applied, debugBuild, sdkFull, now))

    /** Plans and applies with nothing failing, returning what Belay then holds. */
    private fun apply(plan: EnforcementPlan, applied: Applied = Applied(), now: Long = T0): Applied =
        Enforcement.after(applied, plan, Enforcement.changes(plan, applied), ApplyOutcome(), now)

    // Never blocked, whatever the policy says: 911 and 988 always work.

    @Test
    fun `never-blocked packages are never suspended or hidden, and naming one is a problem`() {
        val everything = apps.values.associateWith { WireAppState.BLOCKED }
        val plan = plan(policy(decisions = everything, web = WireWebPolicy(hideBrowsers = true)))
        for (name in neverBlocked) {
            assertFalse(name in plan.suspend, "$name is suspended")
            assertFalse(name in plan.hide, "$name is hidden")
            assertTrue(plan.problems.any { it.startsWith("$name can't be blocked") }, "no problem for $name")
        }
        assertTrue(plan.problems.any { it == "${dialer.packageName} can't be blocked: it places phone calls, and 911 and 988 always work." })
        assertTrue(plan.problems.any { it == "${messages.packageName} can't be blocked: it's the texting app, and texting 988 always works." })
        // Everything else that was named is blocked.
        assertEquals(
            setOf(game, chat, notes, widget, clock, browser, camera).map { it.packageName }.sorted(),
            plan.blocked,
        )
    }

    @Test
    fun `the phone app and Android's telephony and telecom are protected by name too`() {
        val telecom = app("com.android.server.telecom", system = true).copy(launchable = false)
        val plan = plan(
            policy(decisions = mapOf(telecom to WireAppState.BLOCKED, phoneService to WireAppState.BLOCKED)),
            installed = apps + inventory(telecom),
            phoneRoles = roles.copy(dialers = emptySet()),
        )
        assertTrue(plan.hide.isEmpty())
        assertEquals(2, plan.problems.count { "911 and 988 always work" in it })
    }

    @Test
    fun `a pause never suspends what keeps 911 and 988 working`() {
        val plan = plan(policy(pause = WirePause(until = T0 + HOUR)))
        for (name in neverBlocked) assertFalse(name in plan.suspend, "$name is paused")
        assertTrue(plan.problems.isEmpty())
    }

    // New apps, decisions and blocks.

    @Test
    fun `with ask, a new user app without a decision waits, suspended`() {
        val plan = plan(policy(newApps = WireNewApps.ASK, decisions = mapOf(game to WireAppState.ALLOWED)))
        assertEquals(listOf(chat, notes, widget).map { it.packageName }.sorted(), plan.waiting)
        assertTrue(chat.packageName in plan.suspend)
        assertFalse(chat.packageName in plan.hide, "waiting apps are suspended, not hidden")
        assertFalse(game.packageName in plan.suspend, "an allowed app runs")
        assertFalse(belay.packageName in plan.waiting, "Belay never waits")
    }

    @Test
    fun `system apps never wait, and are only affected when blocked or hidden as browsers`() {
        val plan = plan(policy(newApps = WireNewApps.ASK, decisions = (apps.values - setOf(chat)).associateWith { WireAppState.ALLOWED }))
        assertEquals(listOf(chat.packageName), plan.waiting)
        assertEquals(setOf(chat.packageName), plan.suspend)

        val blockedCamera = plan(policy(decisions = mapOf(camera to WireAppState.BLOCKED)))
        assertEquals(setOf(camera.packageName), blockedCamera.hide)
        assertEquals(setOf(camera.packageName), blockedCamera.suspend)

        val noBrowsers = plan(policy(web = WireWebPolicy(hideBrowsers = true)))
        assertEquals(listOf(browser.packageName), noBrowsers.hiddenBrowsers)
        assertEquals(setOf(browser.packageName), noBrowsers.hide)
        assertEquals(setOf(browser.packageName), noBrowsers.suspend)
    }

    @Test
    fun `with allow, nothing waits and only blocked apps are held`() {
        val plan = plan(policy(decisions = mapOf(game to WireAppState.BLOCKED, chat to WireAppState.ALLOWED)))
        assertTrue(plan.waiting.isEmpty())
        assertEquals(listOf(game.packageName), plan.blocked)
        assertEquals(setOf(game.packageName), plan.hide)
        assertEquals(setOf(game.packageName), plan.suspend)
    }

    @Test
    fun `a blocked app is hidden and suspended, and the last decision for a package counts`() {
        val policy = WirePolicy(
            version = 2,
            apps = WireAppPolicy(
                WireNewApps.ALLOW,
                listOf(WireAppDecision(game.packageName, WireAppState.ALLOWED), WireAppDecision(game.packageName, WireAppState.BLOCKED)),
            ),
        )
        val plan = plan(policy)
        assertEquals(setOf(game.packageName), plan.hide)
        assertEquals(setOf(game.packageName), plan.suspend)
    }

    @Test
    fun `a decision for an app that isn't installed does nothing and isn't a problem`() {
        val elsewhere = app("com.example.notinstalled")
        val plan = plan(policy(decisions = mapOf(elsewhere to WireAppState.BLOCKED)))
        assertTrue(plan.hide.isEmpty())
        assertTrue(plan.problems.isEmpty())
    }

    @Test
    fun `an app Belay hid stays blockable even though a hidden app has no launcher icon`() {
        // Hidden, a launchable system app can read as having no launcher activity.
        val hiddenCamera = camera.copy(launchable = false)
        val applied = Applied(policyVersion = 1, suspended = setOf(camera.packageName), hidden = setOf(camera.packageName))
        val plan = plan(
            policy(decisions = mapOf(camera to WireAppState.BLOCKED)),
            applied = applied,
            installed = apps + inventory(hiddenCamera),
        )
        assertEquals(setOf(camera.packageName), plan.hide)
        assertTrue(plan.problems.isEmpty())
    }

    @Test
    fun `a browser Belay hid stays hidden though it no longer answers as a browser`() {
        val first = plan(policy(web = WireWebPolicy(hideBrowsers = true)))
        val applied = apply(first)
        assertEquals(setOf(browser.packageName), applied.browsers)
        val again = plan(policy(web = WireWebPolicy(hideBrowsers = true)), applied = applied, phoneRoles = roles.copy(browsers = emptySet()))
        assertEquals(setOf(browser.packageName), again.hide)
        assertTrue(Enforcement.changes(again, applied).none)
    }

    // Pause.

    @Test
    fun `a pause suspends every launchable app but the protected ones, until it ends`() {
        val until = T0 + 2 * HOUR
        val plan = plan(policy(newApps = WireNewApps.ASK, decisions = apps.values.associateWith { WireAppState.ALLOWED }, pause = WirePause(until, "Dinner")))
        assertEquals(setOf(game, chat, notes, browser, camera).map { it.packageName }.toSet(), plan.suspend)
        assertFalse(widget.packageName in plan.suspend, "no launcher icon: nothing to pause")
        assertFalse(clock.packageName in plan.suspend, "the clock keeps ringing alarms")
        assertTrue(plan.hide.isEmpty(), "a pause hides nothing")
        assertEquals("Dinner", plan.pause?.note)
        assertEquals(until, plan.nextChangeAt)

        val over = plan(policy(pause = WirePause(until, "Dinner")), now = until)
        assertTrue(over.suspend.isEmpty())
        assertNull(over.pause)
        assertNull(over.nextChangeAt)
    }

    @Test
    fun `a pause without an end lasts until a parent resumes`() {
        val plan = plan(policy(pause = WirePause(until = null)), now = T0 + 1000 * HOUR)
        assertTrue(game.packageName in plan.suspend)
        assertNull(plan.nextChangeAt)
    }

    @Test
    fun `a pause leaves alone the apps screen time exempts`() {
        val exempting = policy(pause = WirePause(T0 + HOUR)).copy(screenTime = WireScreenTime(exempt = listOf(notes.packageName)))
        val plan = plan(exempting)
        assertFalse(notes.packageName in plan.suspend, "exempt apps are never paused")
        assertTrue(game.packageName in plan.suspend)
    }

    @Test
    fun `the plan says why it holds each app, and Belay keeps that for what it holds`() {
        val plan = plan(
            policy(
                newApps = WireNewApps.ASK,
                decisions = mapOf(game to WireAppState.BLOCKED, chat to WireAppState.ALLOWED, browser to WireAppState.ALLOWED),
                pause = WirePause(T0 + HOUR),
                web = WireWebPolicy(hideBrowsers = true),
            ),
        )
        assertEquals(listOf(HoldReason.BLOCKED, HoldReason.PAUSED), plan.reasons[game.packageName])
        assertEquals(listOf(HoldReason.NO_BROWSERS, HoldReason.PAUSED), plan.reasons[browser.packageName])
        assertEquals(listOf(HoldReason.WAITING, HoldReason.PAUSED), plan.reasons[notes.packageName])
        assertEquals(listOf(HoldReason.PAUSED), plan.reasons[chat.packageName])
        assertEquals(plan.suspend, plan.reasons.keys)
        assertEquals(plan.reasons, apply(plan).reasons)
    }

    @Test
    fun `when a pause ends, only what the pause suspended is let go`() {
        val paused = plan(policy(newApps = WireNewApps.ASK, pause = WirePause(T0 + HOUR)))
        val applied = apply(paused)
        val after = plan(policy(newApps = WireNewApps.ASK, pause = WirePause(T0 + HOUR)), applied = applied, now = T0 + HOUR)
        val changes = Enforcement.changes(after, applied)
        assertEquals(setOf(browser, camera).map { it.packageName }.toSet(), changes.unsuspend)
        assertTrue(changes.suspend.isEmpty())
        assertEquals(setOf(game, chat, notes, widget).map { it.packageName }.toSet(), after.suspend, "waiting apps stay suspended")
    }

    // Restrictions.

    @Test
    fun `factory reset and debugging are never locked on a debug build`() {
        val all = WireRestrictions(factoryReset = true, debugging = true, safeBoot = true)
        val debug = plan(policy(restrictions = all), debugBuild = true)
        assertEquals(setOf(Lock.SAFE_BOOT), debug.locks)
        assertTrue(debug.problems.any { "test build" in it })

        val release = plan(policy(restrictions = all))
        assertEquals(setOf(Lock.SAFE_BOOT, Lock.FACTORY_RESET, Lock.DEBUGGING), release.locks)
        assertTrue(release.problems.isEmpty())
    }

    @Test
    fun `nothing locks factory reset or debugging unless the policy turns them on`() {
        val plan = plan(policy(restrictions = WireRestrictions(safeBoot = true, addUser = true, unknownSources = true, configVpn = true)))
        assertFalse(Lock.FACTORY_RESET in plan.locks)
        assertFalse(Lock.DEBUGGING in plan.locks)
    }

    @Test
    fun `maintenance lifts debugging until it ends`() {
        val until = T0 + 3 * HOUR
        val during = plan(policy(restrictions = WireRestrictions(debugging = true, factoryReset = true), maintenanceUntil = until))
        assertEquals(setOf(Lock.FACTORY_RESET), during.locks)
        assertEquals(until, during.maintenanceUntil)
        assertEquals(until, during.nextChangeAt)

        val after = plan(policy(restrictions = WireRestrictions(debugging = true), maintenanceUntil = until), now = until)
        assertEquals(setOf(Lock.DEBUGGING), after.locks)
        assertNull(after.maintenanceUntil)
    }

    @Test
    fun `restrictions map to Android's, with the companions they need`() {
        val plan = plan(
            policy(
                restrictions = WireRestrictions(
                    safeBoot = true, addUser = true, unknownSources = true, configVpn = true, configPrivateDns = true,
                    configDateTime = true, configDefaultApps = true, modifyAccounts = true, sim = true,
                ),
            ),
        )
        assertEquals(
            setOf(
                Lock.SAFE_BOOT, Lock.ADD_USER, Lock.USER_SWITCH, Lock.UNKNOWN_SOURCES, Lock.CONFIG_VPN, Lock.CONFIG_PRIVATE_DNS,
                Lock.CONFIG_DATE_TIME, Lock.CONFIG_DEFAULT_APPS, Lock.MODIFY_ACCOUNTS, Lock.SIM,
            ),
            plan.locks,
        )
        assertTrue(plan.autoTime, "a locked clock is set automatically")
        assertTrue(plan.problems.isEmpty())
    }

    @Test
    fun `from 37_2 unknown sources also covers registered app stores`() {
        val restrictions = WireRestrictions(unknownSources = true)
        assertEquals(setOf(Lock.UNKNOWN_SOURCES), plan(policy(restrictions = restrictions), sdkFull = Enforcement.sdkFull(37, 1)).locks)
        assertEquals(
            setOf(Lock.UNKNOWN_SOURCES, Lock.UNKNOWN_SOURCES_REGISTERED_STORES),
            plan(policy(restrictions = restrictions), sdkFull = Enforcement.sdkFull(37, 2)).locks,
        )
    }

    @Test
    fun `a restriction this Android version doesn't have is a problem, not a crash`() {
        val plan = plan(policy(restrictions = WireRestrictions(configDefaultApps = true, sim = true)), sdkFull = Enforcement.sdkFull(33))
        assertTrue(plan.locks.isEmpty())
        assertEquals(2, plan.problems.size)
    }

    // The web.

    @Test
    fun `Private DNS takes a host name, and anything else is a problem`() {
        assertEquals("family-filter-dns.cleanbrowsing.org", plan(policy(web = WireWebPolicy(privateDns = " Family-Filter-DNS.cleanbrowsing.org "))).privateDns)
        for (bad in listOf("not a host", "https://dns.example.org", "192.168.1.1", "-bad.example.org", "example")) {
            val plan = plan(policy(web = WireWebPolicy(privateDns = bad)))
            assertNull(plan.privateDns, bad)
            assertEquals(1, plan.problems.size, bad)
        }
        assertNull(plan(policy()).privateDns)
    }

    @Test
    fun `Chrome's settings become the policy values Chrome reads`() {
        val config = ChromeConfig.of(WireChromePolicy())
        assertEquals(1, config.incognitoModeAvailability)
        assertTrue(config.forceGoogleSafeSearch)
        assertEquals(2, config.forceYouTubeRestrict)
        assertEquals(1, config.safeSitesFilterBehavior)
        assertEquals(3, config.downloadRestrictions)
        assertEquals(emptyList(), config.urlBlocklist)
        assertNull(config.urlAllowlist)
        assertEquals("off", config.dnsOverHttpsMode)

        val open = ChromeConfig.of(WireChromePolicy(incognito = true, youtubeRestrict = "moderate", safeSites = false, allowDownloads = true))
        assertEquals(0, open.incognitoModeAvailability)
        assertEquals(1, open.forceYouTubeRestrict)
        assertEquals(0, open.safeSitesFilterBehavior)
        assertEquals(0, open.downloadRestrictions)
        assertEquals(0, ChromeConfig.of(WireChromePolicy(youtubeRestrict = "off")).forceYouTubeRestrict)
    }

    @Test
    fun `an allowlist blocks everything else`() {
        val config = ChromeConfig.of(WireChromePolicy(urlAllowlist = listOf("school.example.org"), urlBlocklist = listOf("school.example.org/games")))
        assertEquals(listOf("*", "school.example.org/games"), config.urlBlocklist)
        assertEquals(listOf("school.example.org"), config.urlAllowlist)
    }

    @Test
    fun `Chrome's configuration is set, changed and taken back`() {
        val withChrome = policy(web = WireWebPolicy(chrome = WireChromePolicy()))
        val first = plan(withChrome)
        val changes = Enforcement.changes(first, Applied())
        assertEquals(Setting.Set(ChromeConfig.of(WireChromePolicy())), changes.chrome)
        val applied = apply(first)
        assertNull(Enforcement.changes(plan(withChrome, applied = applied), applied).chrome)
        assertEquals(Setting.Clear, Enforcement.changes(plan(policy(), applied = applied), applied).chrome)
    }

    // Reset protection.

    @Test
    fun `reset protection is set on release builds only, from the parent's accounts`() {
        val accounts = policy(frpAccounts = listOf(" 123456789 ", "123456789", ""))
        assertEquals(listOf("123456789"), plan(accounts).frpAccounts)
        val debug = plan(accounts, debugBuild = true)
        assertNull(debug.frpAccounts)
        assertTrue(debug.problems.any { "test build" in it })
        assertNull(plan(policy()).frpAccounts)
    }

    // Play's allowed accounts (platform notes A4).

    @Test
    fun `Play's accounts are set from the policy, on debug builds too, and taken back when it has none`() {
        val listed = policy(playAccounts = listOf(" Parent@Gmail.com ", "parent@gmail.com", "", "co.parent+play@example.org"))
        val first = plan(listed)
        assertEquals(listOf("parent@gmail.com", "co.parent+play@example.org"), first.playAccounts)
        assertTrue(first.problems.isEmpty())
        // They can't lock anyone out of the phone, so a test build sets them too.
        assertEquals(first.playAccounts, plan(listed, debugBuild = true).playAccounts)
        assertEquals(Setting.Set(listOf("parent@gmail.com", "co.parent+play@example.org")), Enforcement.changes(first, Applied()).playAccounts)
        val applied = apply(first)
        assertEquals(listOf("parent@gmail.com", "co.parent+play@example.org"), applied.playAccounts)
        // The same again changes nothing; another list is set in its place.
        assertNull(Enforcement.changes(plan(listed, applied = applied), applied).playAccounts)
        val other = plan(policy(playAccounts = listOf("parent@gmail.com")), applied = applied)
        assertEquals(Setting.Set(listOf("parent@gmail.com")), Enforcement.changes(other, applied).playAccounts)
        // None in the policy: Belay takes back what it set, and then holds nothing.
        val none = plan(policy(), applied = applied)
        assertNull(none.playAccounts)
        assertEquals(Setting.Clear, Enforcement.changes(none, applied).playAccounts)
        assertNull(apply(none, applied).playAccounts)
        // With none set and none asked for, Play's configuration is left alone.
        assertNull(Enforcement.changes(plan(policy()), Applied()).playAccounts)
    }

    @Test
    fun `setting Play's accounts that failed is tried again, and a take-back that failed is still Belay's`() {
        val listed = plan(policy(playAccounts = listOf("parent@gmail.com")))
        val failed = Enforcement.after(Applied(), listed, Enforcement.changes(listed, Applied()), ApplyOutcome(playFailed = true), T0)
        assertNull(failed.playAccounts)
        assertEquals(Setting.Set(listOf("parent@gmail.com")), Enforcement.changes(plan(policy(playAccounts = listOf("parent@gmail.com")), applied = failed), failed).playAccounts)
        val held = apply(listed)
        val none = plan(policy(), applied = held)
        val stuck = Enforcement.after(held, none, Enforcement.changes(none, held), ApplyOutcome(playFailed = true), T0)
        assertEquals(listOf("parent@gmail.com"), stuck.playAccounts)
        assertEquals(Setting.Clear, Enforcement.changes(plan(policy(), applied = stuck), stuck).playAccounts)
    }

    @Test
    fun `an account that isn't an email address is left out, and the problem doesn't repeat it`() {
        val plan = plan(policy(playAccounts = listOf("not an email", "a,b@example.org", "parent@example", "parent@gmail.com")))
        assertEquals(listOf("parent@gmail.com"), plan.playAccounts)
        assertEquals(listOf("Play's accounts: one isn't an email address, so Belay left it out."), plan.problems)
        val nothingGood = plan(policy(playAccounts = listOf("nobody")))
        assertNull(nothingGood.playAccounts)
        assertEquals(1, nothingGood.problems.size)
    }

    @Test
    fun `at most five of Play's accounts, as one comma-separated string`() {
        val many = (1..7).map { "parent$it@example.org" }
        assertEquals(many.take(PlayAccounts.MAX), plan(policy(playAccounts = many)).playAccounts)
        assertEquals("parent@gmail.com,co.parent@example.org", PlayAccounts.value(listOf("parent@gmail.com", "co.parent@example.org")))
        assertEquals("com.android.vending", PlayAccounts.PLAY_STORE)
        assertEquals("allowed_accounts", PlayAccounts.KEY)
        for (good in listOf("parent@gmail.com", "o'brien.family+play@mail.example.co.uk", "a@b.co")) assertTrue(PlayAccounts.valid(good), good)
        for (bad in listOf("", "Parent@Gmail.com", "parent", "parent@", "@gmail.com", "parent@gmail", "pa rent@gmail.com", "a,b@gmail.com", "parent@-gmail.com")) {
            assertFalse(PlayAccounts.valid(bad), bad)
        }
    }

    // Applying, loosening and idempotence.

    @Test
    fun `a Phase 1 policy enforces nothing`() {
        val plan = plan(WirePolicy(version = 0))
        assertTrue(plan.suspend.isEmpty() && plan.hide.isEmpty() && plan.locks.isEmpty())
        assertNull(plan.privateDns)
        assertNull(plan.chrome)
        assertNull(plan.frpAccounts)
        assertNull(plan.playAccounts)
        assertTrue(Enforcement.changes(plan, Applied()).none)
    }

    @Test
    fun `applying the same plan again changes nothing`() {
        val policy = policy(
            newApps = WireNewApps.ASK, decisions = mapOf(game to WireAppState.BLOCKED), pause = WirePause(T0 + HOUR),
            restrictions = WireRestrictions(safeBoot = true, configDateTime = true),
            web = WireWebPolicy(chrome = WireChromePolicy(), hideBrowsers = true),
        )
        val first = plan(policy)
        val applied = apply(first)
        val again = plan(policy, applied = applied)
        assertTrue(Enforcement.changes(again, applied).none)
        assertEquals(applied, apply(again, applied))
    }

    @Test
    fun `approving a waiting app unsuspends it, and blocking it hides it`() {
        val asking = policy(newApps = WireNewApps.ASK, decisions = (apps.values - setOf(chat)).associateWith { WireAppState.ALLOWED })
        val waiting = apply(plan(asking))
        assertEquals(setOf(chat.packageName), waiting.suspended)

        val approve = policy(version = 2, newApps = WireNewApps.ASK, decisions = apps.values.associateWith { WireAppState.ALLOWED })
        val approved = plan(approve, applied = waiting)
        assertEquals(setOf(chat.packageName), Enforcement.changes(approved, waiting).unsuspend)

        val block = policy(version = 3, newApps = WireNewApps.ASK, decisions = (apps.values - setOf(chat)).associateWith { WireAppState.ALLOWED } + (chat to WireAppState.BLOCKED))
        val blocked = plan(block, applied = waiting)
        val changes = Enforcement.changes(blocked, waiting)
        assertEquals(setOf(chat.packageName), changes.hide)
        assertTrue(changes.suspend.isEmpty(), "already suspended while it waited")
    }

    @Test
    fun `removing a block lets go of exactly what Belay hid and suspended`() {
        val blocked = apply(plan(policy(decisions = mapOf(game to WireAppState.BLOCKED))))
        val changes = Enforcement.changes(plan(policy(version = 2), applied = blocked), blocked)
        assertEquals(setOf(game.packageName), changes.unhide)
        assertEquals(setOf(game.packageName), changes.unsuspend)
        // Under ask, an undecided app goes back to waiting: shown again, but still suspended.
        val asking = Enforcement.changes(plan(policy(version = 2, newApps = WireNewApps.ASK), applied = blocked), blocked)
        assertEquals(setOf(game.packageName), asking.unhide)
        assertFalse(game.packageName in asking.unsuspend)
    }

    @Test
    fun `Belay never lets go of what it didn't suspend, hide or lock`() {
        // Something else suspended Notes and locked safe boot; Belay's record doesn't have them.
        val applied = Applied(policyVersion = 1, suspended = setOf(game.packageName), locks = setOf(Lock.CONFIG_VPN))
        val changes = Enforcement.changes(plan(policy(version = 2), applied = applied), applied)
        assertEquals(setOf(game.packageName), changes.unsuspend)
        assertEquals(setOf(Lock.CONFIG_VPN), changes.unlock)
        assertFalse(notes.packageName in changes.unsuspend)
        assertFalse(Lock.SAFE_BOOT in changes.unlock)
    }

    @Test
    fun `loosening restrictions clears only what Belay set, and automatic time is handed back`() {
        val locked = apply(plan(policy(restrictions = WireRestrictions(safeBoot = true, configDateTime = true))))
        assertTrue(locked.autoTime)
        val changes = Enforcement.changes(plan(policy(version = 2), applied = locked), locked)
        assertEquals(setOf(Lock.SAFE_BOOT, Lock.CONFIG_DATE_TIME), changes.unlock)
        assertEquals(false, changes.autoTime)
        assertTrue(changes.lock.isEmpty())
    }

    @Test
    fun `what failed to apply is tried again, and what failed to let go is still held`() {
        val plan = plan(policy(decisions = mapOf(game to WireAppState.BLOCKED, chat to WireAppState.BLOCKED), restrictions = WireRestrictions(safeBoot = true)))
        val changes = Enforcement.changes(plan, Applied())
        val outcome = ApplyOutcome(failedSuspend = setOf(chat.packageName), failedLock = setOf(Lock.SAFE_BOOT), problems = listOf("Couldn't suspend ${chat.packageName}."))
        val applied = Enforcement.after(Applied(), plan, changes, outcome, T0)
        assertFalse(chat.packageName in applied.suspended)
        assertTrue(chat.packageName in applied.hidden)
        assertTrue(applied.locks.isEmpty())
        assertTrue("Couldn't suspend ${chat.packageName}." in applied.problems)
        val retry = Enforcement.changes(plan, applied)
        assertEquals(setOf(chat.packageName), retry.suspend)
        assertEquals(setOf(Lock.SAFE_BOOT), retry.lock)

        val loosen = plan(policy(version = 2))
        val letGo = Enforcement.changes(loosen, applied)
        val stuck = Enforcement.after(applied, loosen, letGo, ApplyOutcome(failedUnsuspend = setOf(game.packageName)), T0)
        assertEquals(setOf(game.packageName), stuck.suspended)
        assertTrue(stuck.hidden.isEmpty())
    }

    @Test
    fun `a reinstalled app lost its suspension, so Belay forgets it and suspends it again`() {
        val asking = policy(newApps = WireNewApps.ASK, decisions = (apps.values - setOf(chat)).associateWith { WireAppState.ALLOWED })
        val applied = apply(plan(asking))
        val (afterCheck, gone) = Enforcement.reconcile(applied, apps.keys, ActualState(checkedPackages = setOf(chat.packageName)))
        assertTrue(gone.isEmpty())
        assertTrue(afterCheck.suspended.isEmpty())
        assertEquals(setOf(chat.packageName), Enforcement.changes(plan(asking, applied = afterCheck), afterCheck).suspend)
    }

    @Test
    fun `an uninstalled app leaves Belay's record, and is named so its policy can be tidied`() {
        val applied = apply(plan(policy(decisions = mapOf(game to WireAppState.BLOCKED))))
        val (next, gone) = Enforcement.reconcile(applied, apps.keys - game.packageName, ActualState())
        assertEquals(setOf(game.packageName), gone)
        assertTrue(next.suspended.isEmpty() && next.hidden.isEmpty())
    }

    @Test
    fun `a lock that was lost is set again, and one that holds is kept`() {
        val applied = Applied(policyVersion = 1, locks = setOf(Lock.SAFE_BOOT, Lock.CONFIG_VPN))
        val (next, _) = Enforcement.reconcile(
            applied, apps.keys, ActualState(checkedLocks = setOf(Lock.SAFE_BOOT, Lock.CONFIG_VPN), locks = setOf(Lock.CONFIG_VPN)),
        )
        assertEquals(setOf(Lock.CONFIG_VPN), next.locks)
    }

    @Test
    fun `another user or profile is reported in the words the server looks for`() {
        val plan = Enforcement.plan(Enforcement.Input(policy(), apps, roles, Applied(), false, Enforcement.sdkFull(37), T0, otherUsers = 1))
        val problem = plan.problems.single()
        assertTrue("another user or profile" in problem)
        assertTrue(problem.length <= WireLimits.MAX_PROBLEM)
        assertTrue(plan(policy()).problems.isEmpty())
    }

    // The enforcement report.

    @Test
    fun `the report says which version is applied since when, how many apps are held, and the problems`() {
        assertNull(Enforcement.report(Applied()))
        val plan = plan(policy(version = 4, newApps = WireNewApps.ASK, decisions = mapOf(game to WireAppState.BLOCKED, dialer to WireAppState.BLOCKED)))
        val applied = apply(plan, now = T0)
        val report = Enforcement.report(applied)!!
        assertEquals(4, report.policyVersion)
        assertEquals(T0, report.appliedAt)
        assertEquals(4, report.suspendedCount) // game (blocked), chat, notes, widget (waiting)
        assertEquals(1, report.problems.size)
        // Applying the same version later keeps when it was first applied.
        assertEquals(T0, apply(plan, applied, now = T0 + HOUR).appliedAt)
        assertEquals(T0 + HOUR, apply(plan(policy(version = 5)), applied, now = T0 + HOUR).appliedAt)
    }

    @Test
    fun `problems are capped for the server`() {
        val many = (1..30).map { app("com.android.system$it", system = true).copy(launchable = false) }
        val plan = plan(policy(decisions = many.associateWith { WireAppState.BLOCKED }), installed = apps + inventory(*many.toTypedArray()))
        assertEquals(30, plan.problems.size)
        val report = Enforcement.report(apply(plan))!!
        assertEquals(WireLimits.MAX_PROBLEMS, report.problems.size)
        assertTrue(report.problems.all { it.length <= WireLimits.MAX_PROBLEM })
    }

    // Phase 6: the recovery key.

    private fun recoveryPlan(restrictions: WireRestrictions, recoveryUntil: Long?, debugBuild: Boolean = false, now: Long = T0, maintenanceUntil: Long? = null) =
        Enforcement.plan(
            Enforcement.Input(
                policy(restrictions = restrictions, maintenanceUntil = maintenanceUntil), apps, roles, Applied(), debugBuild,
                Enforcement.sdkFull(37), now, recoveryUntil = recoveryUntil,
            ),
        )

    @Test
    fun `the recovery key lifts debugging and factory reset until it ends, then they lock again`() {
        val locked = WireRestrictions(debugging = true, factoryReset = true, safeBoot = true)
        val until = T0 + 24 * HOUR
        val during = recoveryPlan(locked, until)
        assertEquals(setOf(Lock.SAFE_BOOT), during.locks)
        assertEquals(until, during.recoveryUntil)
        assertEquals(until, during.nextChangeAt, "a timer puts the locks back when it ends")
        assertTrue(during.problems.isEmpty())
        // Applied: Belay takes back exactly those two locks, and nothing else.
        val before = apply(recoveryPlan(locked, null))
        assertEquals(setOf(Lock.SAFE_BOOT, Lock.DEBUGGING, Lock.FACTORY_RESET), before.locks)
        assertEquals(setOf(Lock.DEBUGGING, Lock.FACTORY_RESET), Enforcement.changes(during, before).unlock)

        val after = recoveryPlan(locked, until, now = until)
        assertEquals(setOf(Lock.SAFE_BOOT, Lock.DEBUGGING, Lock.FACTORY_RESET), after.locks)
        assertNull(after.recoveryUntil)
        assertNull(after.nextChangeAt)
    }

    @Test
    fun `with maintenance too, the earlier end comes first`() {
        val locked = WireRestrictions(debugging = true, factoryReset = true)
        val plan = recoveryPlan(locked, recoveryUntil = T0 + 24 * HOUR, maintenanceUntil = T0 + 2 * HOUR)
        assertEquals(emptySet(), plan.locks)
        assertEquals(T0 + 2 * HOUR, plan.nextChangeAt)
    }

    @Test
    fun `a debug build never locks them anyway, and the recovery key changes nothing it applies`() {
        val locked = WireRestrictions(debugging = true, factoryReset = true)
        val debug = recoveryPlan(locked, T0 + 24 * HOUR, debugBuild = true)
        assertEquals(emptySet(), debug.locks)
        assertEquals(T0 + 24 * HOUR, debug.recoveryUntil)
        assertNull(debug.nextChangeAt)
        assertTrue(debug.problems.any { "test build" in it })
    }

    @Test
    fun `the recovery key opens nothing a policy didn't lock`() {
        val plan = recoveryPlan(WireRestrictions(safeBoot = true), T0 + 24 * HOUR)
        assertEquals(setOf(Lock.SAFE_BOOT), plan.locks)
        assertNull(plan.nextChangeAt)
    }

    // The packages this phone never blocks, for the report.

    @Test
    fun `the report lists what this phone never blocks, Belay and the roles first, installed only`() {
        val plan = plan(policy())
        assertEquals(
            listOf(
                belay, framework, phoneService, systemUi, settings, dialer, safety, messages, launcher, keyboard, webView,
            ).map { it.packageName },
            plan.neverBlocked,
        )
        assertEquals(neverBlocked.toSet(), plan.neverBlocked.toSet())
        val applied = apply(plan)
        assertEquals(plan.neverBlocked, applied.neverBlocked)
        assertEquals(plan.neverBlocked, Enforcement.report(applied)!!.neverBlocked)
        // The same phone gives the same list, whatever order the inventory comes in.
        val reversed = plan(policy(), installed = apps.entries.reversed().associate { it.key to it.value })
        assertEquals(plan.neverBlocked, reversed.neverBlocked)
    }

    @Test
    fun `the never-blocked list is capped, keeping Belay and the roles`() {
        val many = (1..150).map { app("com.android.service$it", system = true).copy(launchable = false) }
        val plan = plan(policy(), installed = apps + inventory(*many.toTypedArray()))
        assertEquals(WireLimits.MAX_NEVER_BLOCKED, plan.neverBlocked.size)
        assertEquals(belay.packageName, plan.neverBlocked.first())
        assertTrue(dialer.packageName in plan.neverBlocked && messages.packageName in plan.neverBlocked && keyboard.packageName in plan.neverBlocked)
    }

    @Test
    fun `the report carries the update's state, the recovery key's use and the commands' results`() {
        val offer = WireAgentUpdate(versionCode = 4, sha256 = "ab".repeat(32), size = 10)
        val applied = apply(plan(policy(version = 7).copy(agentUpdate = offer)))
        assertEquals(offer, applied.agentUpdate)
        val update = WireAgentUpdateState(4, WireUpdateState.INSTALLING, null, T0)
        val use = WireRecoveryUse(1, T0, T0 + 24 * HOUR)
        val results = (1..25).map { WireCommandResult("command-$it", WireCommandOutcome.DONE, T0 + it) }
        val report = Enforcement.report(applied, update, use, results)!!
        assertEquals(update, report.agentUpdate)
        assertEquals(use, report.recovery)
        assertEquals(results.take(WireLimits.MAX_COMMAND_RESULTS), report.commands)
        assertNull(Enforcement.report(Applied(), update, use, results), "nothing before the first policy")
    }
}
