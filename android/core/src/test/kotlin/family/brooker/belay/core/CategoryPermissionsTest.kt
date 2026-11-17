package family.brooker.belay.core

import family.brooker.belay.core.CategoryPermissions.BACKGROUND_LOCATION
import family.brooker.belay.core.CategoryPermissions.CAMERA
import family.brooker.belay.core.CategoryPermissions.COARSE_LOCATION
import family.brooker.belay.core.CategoryPermissions.FINE_LOCATION
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.core.location.WireLost
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CategoryPermissionsTest {
    private val notifications = "android.permission.POST_NOTIFICATIONS"
    private val localNetwork = "android.permission.ACCESS_LOCAL_NETWORK"
    private val declared = listOf(notifications, localNetwork, CAMERA, BACKGROUND_LOCATION, FINE_LOCATION, COARSE_LOCATION)
    private val location = setOf(FINE_LOCATION, COARSE_LOCATION, BACKGROUND_LOCATION)

    private fun policy(location: WireLocation?) = WirePolicy(version = 1, location = location)

    private fun plan(policy: WirePolicy?, helpFix: Boolean = false, cameraInUse: Boolean = false) =
        CategoryPermissions.plan(declared, CategoryPermissions.categoriesOn(policy, helpFix), cameraInUse)

    @Test
    fun `location is granted only while the policy has a mode on, or lost mode, or the help fix`() {
        val on = listOf(
            policy(WireLocation(mode = WireLocationMode.ON_DEMAND)),
            policy(WireLocation(mode = WireLocationMode.PERIODIC)),
            policy(WireLocation(lost = WireLost(T0, "This phone is lost"))),
        )
        for (p in on) {
            val plan = plan(p)
            assertTrue(plan.grant.containsAll(location), "granted with ${p.location}")
            assertTrue(plan.deny.none { it in location })
        }
        val off = listOf(null, policy(null), policy(WireLocation()), policy(WireLocation(mode = WireLocationMode.OFF, keepOn = true)))
        for (p in off) {
            val plan = plan(p)
            assertTrue(plan.deny.containsAll(location), "denied with ${p?.location}")
            assertTrue(plan.grant.none { it in location })
        }
        val help = plan(policy(WireLocation()), helpFix = true)
        assertTrue(help.grant.containsAll(location), "the one fix a kid shares with a help request")
    }

    @Test
    fun `every mode change gives the same answer for the same mode`() {
        val modes = listOf(null, WireLocation(), WireLocation(mode = WireLocationMode.ON_DEMAND), WireLocation(mode = WireLocationMode.PERIODIC))
        for (from in modes) {
            for (to in modes) {
                val before = plan(policy(from))
                val after = plan(policy(to))
                val wanted = to != null && to.mode != WireLocationMode.OFF
                assertEquals(wanted, after.grant.containsAll(location), "$from -> $to")
                assertEquals(!wanted, after.deny.containsAll(location), "$from -> $to")
                // The rule doesn't depend on what came before.
                if (from == to) assertEquals(before, after)
            }
        }
    }

    @Test
    fun `every other permission is granted as before, and the camera never is`() {
        for (p in listOf(null, policy(WireLocation(mode = WireLocationMode.ON_DEMAND)))) {
            val plan = plan(p)
            assertTrue(notifications in plan.grant && localNetwork in plan.grant)
            assertTrue(CAMERA !in plan.grant)
            assertTrue(CAMERA in plan.deny, "denied by policy outside the enrollment screen")
        }
        val scanning = plan(null, cameraInUse = true)
        assertTrue(CAMERA !in scanning.grant && CAMERA !in scanning.deny, "left to the enrollment screen while it scans")
    }

    @Test
    fun `background location is granted after the foreground ones, and denied before them`() {
        val on = plan(policy(WireLocation(mode = WireLocationMode.ON_DEMAND)))
        assertEquals(BACKGROUND_LOCATION, on.grant.last())
        val off = plan(policy(WireLocation()))
        assertEquals(BACKGROUND_LOCATION, off.deny.first())
        assertTrue(CategoryPermissions.tied(FINE_LOCATION) && !CategoryPermissions.tied(notifications))
    }
}
