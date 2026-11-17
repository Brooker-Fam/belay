package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.inventory
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.core.location.WireLocationStatus
import family.brooker.belay.core.location.WireLost
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Phase 4 in Phase 2's plan: keep_on and lost mode lock location on. Made-up apps. */
class LocationEnforcementTest {
    private val belay = app("family.example.belay", label = "Belay")
    private val apps = inventory(belay, app("com.example.game"))
    private val roles = PhoneRoles(self = belay.packageName)

    private fun plan(location: WireLocation?) = Enforcement.plan(
        Enforcement.Input(WirePolicy(version = 1, location = location), apps, roles, Applied(), debugBuild = true, Enforcement.sdkFull(37), T0),
    )

    @Test
    fun `keep_on locks location on while a mode is on, and lost mode always`() {
        assertTrue(Lock.CONFIG_LOCATION in plan(WireLocation(mode = WireLocationMode.ON_DEMAND, keepOn = true)).locks)
        assertTrue(Lock.CONFIG_LOCATION in plan(WireLocation(mode = WireLocationMode.PERIODIC, keepOn = true)).locks)
        assertTrue(Lock.CONFIG_LOCATION in plan(WireLocation(lost = WireLost(T0, "This phone is lost"))).locks)
        assertFalse(Lock.CONFIG_LOCATION in plan(WireLocation(mode = WireLocationMode.ON_DEMAND)).locks)
        assertFalse(Lock.CONFIG_LOCATION in plan(WireLocation(keepOn = true)).locks, "no mode: Belay doesn't hold location on")
        assertFalse(Lock.CONFIG_LOCATION in plan(null).locks)
    }

    @Test
    fun `the kid sees that location is locked on, once Belay applied it`() {
        val policy = WirePolicy(version = 1, location = WireLocation(mode = WireLocationMode.ON_DEMAND, keepOn = true))
        val plan = plan(policy.location)
        val applied = Enforcement.after(Applied(), plan, Enforcement.changes(plan, Applied()), ApplyOutcome(), T0)
        assertTrue(KidRules.Rule.LOCATION_LOCKED_ON in KidRules.of(policy, plan, applied, null))
        assertFalse(KidRules.Rule.LOCATION_LOCKED_ON in KidRules.of(policy, plan, Applied(policyVersion = 1), null))
    }

    @Test
    fun `the report carries location's status`() {
        val status = WireLocationStatus(permission = true, locationOn = true, lastFixAt = T0)
        assertEquals(status, Enforcement.report(Applied(policyVersion = 1), location = status)?.location)
        assertEquals(null, Enforcement.report(Applied(policyVersion = 1))?.location)
    }
}
