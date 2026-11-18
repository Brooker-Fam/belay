package family.brooker.belay.core.mobiledata

import family.brooker.belay.core.Applied
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.Fixtures
import family.brooker.belay.core.KidRules
import family.brooker.belay.core.NeverBlocked
import family.brooker.belay.core.PhoneRoles
import family.brooker.belay.core.Protection
import family.brooker.belay.core.WireNewApps
import family.brooker.belay.core.WireOffBelay
import family.brooker.belay.core.WireOffBelayPosition
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.kid.OffBelay
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Phase 13's Wi-Fi-only apps on the phone: which packages Belay asks Android to keep off mobile
 * data, the ones it never does (calls, texting, the keyboard, the home screen, Android's own parts,
 * a shared uid), when it calls Android again, the report and the kid's list. Made-up apps only.
 */
class WifiOnlyTest {
    private val video = Fixtures.app("com.example.video", label = "Video Tube")
    private val game = Fixtures.app("com.example.blocks", label = "Block Party")
    private val chat = Fixtures.app("com.example.chat", label = "Chatter")
    private val texts = Fixtures.app("com.example.texts", label = "Texts")
    private val dialer = Fixtures.app("com.example.dialer", label = "Phone", system = true)
    private val keyboard = Fixtures.app("com.example.keyboard", label = "Keys", system = true)
    private val launcher = Fixtures.app("com.example.home", label = "Home", system = true)
    private val carrier = Fixtures.app("com.example.carrier", label = "Carrier Services", system = true).copy(launchable = false)
    private val apps = Fixtures.inventory(video, game, chat, texts, dialer, keyboard, launcher, carrier)
    private val roles = PhoneRoles(
        self = "family.brooker.belay",
        dialers = setOf(dialer.packageName),
        texting = setOf(texts.packageName),
        home = setOf(launcher.packageName),
        keyboards = setOf(keyboard.packageName),
    )
    private val protected = NeverBlocked.of(roles, apps, hiddenByBelay = emptySet())
    private val ids = apps.keys.withIndex().associate { (i, name) -> name to WifiOnly.Identity(uid = 10100 + i, shared = false) }

    private fun plan(list: List<String>, hidden: Set<String> = emptySet(), identities: Map<String, WifiOnly.Identity> = ids) =
        WifiOnly.plan(list, apps, hidden, protected, identities)

    @Test
    fun `the apps a parent listed are asked for, sorted, with their uids`() {
        val plan = plan(listOf(game.packageName, video.packageName))
        assertEquals(listOf(game.packageName, video.packageName), plan.wanted)
        assertEquals(setOf(game.packageName, video.packageName), plan.uids.keys)
        assertEquals(emptyMap(), plan.skipped)
        assertEquals(emptyList(), plan.problems)
    }

    @Test
    fun `never the phone's lifelines, calls, texting, the keyboard, the home screen, Android's own parts, Belay`() {
        val list = listOf(dialer, texts, keyboard, launcher, carrier).map { it.packageName } + listOf("family.brooker.belay", "android", "com.android.phone")
        val plan = plan(list + video.packageName)
        assertEquals(listOf(video.packageName), plan.wanted)
        assertTrue(list.all { plan.skipped[it] == WifiOnly.Skip.NEVER }, plan.skipped.toString())
        // Each one on the phone is reported in the parent's words, naming it by its package, with why.
        assertTrue(plan.problems.contains("com.example.texts can't be Wi-Fi only: ${Protection.TEXTS.words}."), plan.problems.toString())
        assertTrue(plan.problems.contains("com.example.dialer can't be Wi-Fi only: ${Protection.CALLS.words}."))
        assertTrue(plan.problems.contains("com.example.keyboard can't be Wi-Fi only: ${Protection.KEYBOARD.words}."))
        assertTrue(plan.problems.contains("com.example.carrier can't be Wi-Fi only: ${Protection.ANDROID.words}."), "Carrier Services is one of Android's own parts")
        assertTrue(plan.problems.none { "Texts" in it || "Phone (" in it }, "never the developer's label")
        // Ones not on the phone (Belay's own package isn't in this inventory) aren't reported.
        assertTrue(plan.problems.none { it.startsWith("family.brooker.belay") || it.startsWith("android ") })
    }

    @Test
    fun `an app that shares its uid with others is never asked for, and the parent hears why`() {
        val shared = ids + (chat.packageName to WifiOnly.Identity(10333, shared = true))
        val plan = plan(listOf(chat.packageName, video.packageName), identities = shared)
        assertEquals(listOf(video.packageName), plan.wanted)
        assertEquals(WifiOnly.Skip.SHARED_UID, plan.skipped[chat.packageName])
        assertEquals(1, plan.problems.size)
        assertTrue(plan.problems.single().startsWith("com.example.chat can't be Wi-Fi only: it shares its connection"))
    }

    @Test
    fun `an app not on the phone, or that Belay blocked, waits quietly`() {
        val plan = plan(listOf("com.example.later", game.packageName, video.packageName), hidden = setOf(game.packageName))
        assertEquals(listOf(video.packageName), plan.wanted)
        assertEquals(WifiOnly.Skip.NOT_INSTALLED, plan.skipped["com.example.later"])
        assertEquals(WifiOnly.Skip.BLOCKED, plan.skipped[game.packageName])
        assertEquals(emptyList(), plan.problems)
        // Installed per the inventory, but PackageManager has no uid for it (it went meanwhile): not installed.
        val gone = plan(listOf(video.packageName), identities = ids - video.packageName)
        assertEquals(WifiOnly.Skip.NOT_INSTALLED, gone.skipped[video.packageName])
        assertEquals(emptyList(), gone.wanted)
    }

    @Test
    fun `the policy's list is read as package names, each once, at most 100`() {
        assertEquals(listOf("com.example.video"), WifiOnly.listed(listOf(" com.example.video ", "com.example.video", "not a package", "", "a b")))
        assertEquals(100, WifiOnly.listed((1..150).map { "com.example.app$it" }).size)
    }

    @Test
    fun `Belay calls Android when what it wants changes, and not again when nothing did`() {
        val plan = plan(listOf(video.packageName))
        // First time: Android has nothing.
        assertEquals(listOf(video.packageName), WifiOnly.call(plan, WifiOnly.Applied(), android = emptyList()))
        val applied = WifiOnly.asked(plan, plan.wanted, refused = emptyList())
        assertEquals(WifiOnly.Applied(listOf(video.packageName), mapOf(video.packageName to plan.uids.getValue(video.packageName)), emptyList()), applied)
        // A second step: Android holds it, nothing changed: no call.
        assertNull(WifiOnly.call(plan, applied, android = listOf(video.packageName)))
        // A parent adds an app: called again with both.
        val more = plan(listOf(video.packageName, game.packageName))
        assertEquals(listOf(game.packageName, video.packageName), WifiOnly.call(more, applied, android = listOf(video.packageName)))
        // A parent removes every app: called with none, so Android lets them use mobile data again.
        assertEquals(emptyList(), WifiOnly.call(plan(emptyList()), applied, android = listOf(video.packageName)))
        // Nothing listed and nothing held: nothing to do.
        assertNull(WifiOnly.call(plan(emptyList()), WifiOnly.Applied(), android = emptyList()))
        // Belay can't read Android's list (not device owner): it changes nothing.
        assertNull(WifiOnly.call(plan, WifiOnly.Applied(), android = null))
    }

    @Test
    fun `an app installed again under a new uid, removed, or unblocked is asked for again`() {
        val plan = plan(listOf(video.packageName))
        val applied = WifiOnly.asked(plan, plan.wanted, emptyList())
        // Reinstalled: Android resolved the old uid when Belay called (platform notes Q2).
        val again = plan(listOf(video.packageName), identities = ids + (video.packageName to WifiOnly.Identity(10999, shared = false)))
        assertEquals(listOf(video.packageName), WifiOnly.call(again, applied, android = listOf(video.packageName)))
        // Removed: Belay calls without it, so Android drops the uid another app could get.
        val removed = WifiOnly.plan(listOf(video.packageName), apps - video.packageName, emptySet(), protected, ids)
        assertEquals(emptyList(), WifiOnly.call(removed, applied, android = listOf(video.packageName)))
        // Blocked, then unblocked: hidden it's refused by Android, so Belay asks again once it's visible.
        val blocked = plan(listOf(video.packageName), hidden = setOf(video.packageName))
        val whileBlocked = WifiOnly.asked(blocked, blocked.wanted, emptyList())
        assertEquals(listOf(video.packageName), WifiOnly.call(plan, whileBlocked, android = emptyList()))
    }

    @Test
    fun `something else changing Android's list is put right, but a refusal isn't asked again and again`() {
        val plan = plan(listOf(video.packageName, game.packageName))
        val applied = WifiOnly.asked(plan, plan.wanted, refused = listOf(game.packageName))
        assertNull(WifiOnly.call(plan, applied, android = listOf(video.packageName)), "Android refused the game: remembered")
        assertEquals(listOf(game.packageName, video.packageName), WifiOnly.call(plan, applied, android = emptyList()), "Android's list was cleared")
        assertEquals(listOf("Android didn't keep com.example.blocks off mobile data."), WifiOnly.refusedProblems(applied.refused))
    }

    @Test
    fun `the report is what Android holds, and nothing while there's nothing to hold`() {
        assertNull(WifiOnly.report(emptyList(), android = emptyList()))
        assertNull(WifiOnly.report(emptyList(), android = null))
        assertEquals(WireMobileDataStatus(emptyList()), WifiOnly.report(listOf("com.example.later"), android = emptyList()))
        assertEquals(WireMobileDataStatus(listOf("com.example.blocks", "com.example.video")), WifiOnly.report(listOf("com.example.video"), listOf("com.example.video", "com.example.blocks")))
        // Android still holding one after the policy dropped it (the call failed): reported, so the parent sees it.
        assertEquals(WireMobileDataStatus(listOf("com.example.video")), WifiOnly.report(emptyList(), listOf("com.example.video")))
    }

    @Test
    fun `the kid sees only what Android keeps off mobile data and the policy asks for`() {
        val report = WireMobileDataStatus(listOf("com.example.blocks", "com.example.video"))
        assertEquals(listOf("com.example.video"), WifiOnly.forKid(listOf("com.example.video", "com.example.later"), report))
        assertEquals(emptyList(), WifiOnly.forKid(listOf("com.example.video"), null))
        val policy = WirePolicy(version = 3, apps = family.brooker.belay.core.WireAppPolicy(newApps = WireNewApps.ALLOW))
        val plan = Enforcement.plan(Enforcement.Input(policy, apps, roles, Applied(), debugBuild = true, sdkFull = 3_700_000, now = Fixtures.T0))
        assertFalse(KidRules.Rule.WIFI_ONLY in KidRules.of(policy, plan, Applied(), null))
        assertTrue(KidRules.Rule.WIFI_ONLY in KidRules.of(policy, plan, Applied(), null, wifiOnly = listOf("com.example.video")))
    }

    @Test
    fun `What your parent can see says how much mobile data apps use, and never which websites`() {
        val category = DataCategories.MOBILE_DATA
        assertEquals("mobile_data", category.id)
        assertEquals("How much mobile data apps use", category.title)
        assertTrue(category.details.any { "each app" in it && "each day" in it })
        assertTrue(category.details.any { "Wi-Fi each day" in it })
        assertTrue(category.details.any { it.startsWith("Not which websites") })
        assertTrue(category.details.all { it.length < 200 })
    }

    @Test
    fun `Off belay says Belay blocks nothing only once no app is Wi-Fi only`() {
        val offBelay = WireOffBelay(how = null, position = WireOffBelayPosition.ON)
        val policy = WirePolicy(version = 4, offBelay = offBelay)
        val plan = Enforcement.plan(Enforcement.Input(policy, apps, roles, Applied(), debugBuild = true, sdkFull = 3_700_000, now = Fixtures.T0))
        assertTrue(OffBelay.blocksNothing(policy, plan))
        val wifiOnly = policy.copy(mobileData = WireMobileData(wifiOnly = listOf(video.packageName)))
        assertFalse(OffBelay.blocksNothing(wifiOnly, plan))
        assertFalse(OffBelay.line(wifiOnly, plan)!!.blocksNothing)
    }
}
