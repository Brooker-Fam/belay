package family.brooker.belay.core.kid

import family.brooker.belay.core.Applied
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.inventory
import family.brooker.belay.core.PhoneRoles
import family.brooker.belay.core.WireAppPolicy
import family.brooker.belay.core.WireChromePolicy
import family.brooker.belay.core.WireNewApps
import family.brooker.belay.core.WireOffBelay
import family.brooker.belay.core.WireOffBelayPosition
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRestrictions
import family.brooker.belay.core.WireWebPolicy
import family.brooker.belay.core.screentime.WireLimit
import family.brooker.belay.core.screentime.WireScreenTime
import family.brooker.belay.core.screentime.WireStage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Phase 11: Off belay on the kid's "My stage". Made-up apps and words only. */
class OffBelayTest {
    private val belay = app("family.example.belay", label = "Belay")
    private val game = app("com.example.game", label = "Block Builder")
    private val apps = inventory(belay, game)
    private val roles = PhoneRoles(self = belay.packageName)
    private val starter = WireStage(name = "Starter", number = 1, since = T0)
    private val words = "When you turn 16"

    private fun policy(position: WireOffBelayPosition, how: String? = words, stage: WireStage? = starter) =
        WirePolicy(version = 3, stage = stage, offBelay = WireOffBelay(how, position))

    private fun plan(policy: WirePolicy) = Enforcement.plan(Enforcement.Input(policy, apps, roles, Applied(), false, Enforcement.sdkFull(37), T0))

    private fun line(policy: WirePolicy) = OffBelay.line(policy, plan(policy))

    @Test
    fun `it's listed last with the family's words, from the first stage`() {
        assertEquals(OffBelay.Line(WireOffBelayPosition.LATER, words, blocksNothing = false), line(policy(WireOffBelayPosition.LATER)))
        assertEquals(OffBelay.Line(WireOffBelayPosition.NEXT, words, blocksNothing = false), line(policy(WireOffBelayPosition.NEXT)))
        // Without words yet, on a stage: still listed.
        assertEquals(OffBelay.Line(WireOffBelayPosition.LATER, null, blocksNothing = false), line(policy(WireOffBelayPosition.LATER, how = "   ")))
    }

    @Test
    fun `on no stage, only the family's words make it worth saying`() {
        assertEquals(words, line(policy(WireOffBelayPosition.LATER, stage = null))?.how)
        assertNull(line(policy(WireOffBelayPosition.LATER, how = null, stage = null)))
        // An older server sends no Off belay at all.
        assertNull(line(WirePolicy(version = 3, stage = starter)))
        assertNull(OffBelay.line(null, null))
    }

    @Test
    fun `on it, Belay says it blocks nothing only when nothing is held, filtered, paused or limited`() {
        val on = policy(WireOffBelayPosition.ON, stage = starter.copy(name = "Off belay", number = 4))
        assertTrue(line(on)?.blocksNothing == true)
        // Each of these still blocks an app or a website.
        val blocking = listOf(
            on.copy(apps = WireAppPolicy(newApps = WireNewApps.ASK)),
            on.copy(pause = WirePause(until = T0 + HOUR)),
            on.copy(web = WireWebPolicy(privateDns = "family-filter-dns.cleanbrowsing.org")),
            on.copy(web = WireWebPolicy(chrome = WireChromePolicy())),
            on.copy(restrictions = WireRestrictions(unknownSources = true)),
            on.copy(screenTime = WireScreenTime(limits = listOf(WireLimit(id = "l-1", name = "Games", packages = listOf(game.packageName), minutes = 60)))),
        )
        for (policy in blocking) assertFalse(line(policy)?.blocksNothing ?: true, policy.toString())
        // A locked setting that blocks no app or website, like VPN settings, doesn't count.
        assertTrue(line(on.copy(restrictions = WireRestrictions(configVpn = true, safeBoot = true)))?.blocksNothing == true)
        // Without a plan yet, it doesn't say so.
        assertFalse(OffBelay.line(on, null)?.blocksNothing ?: true)
    }
}
