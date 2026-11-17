package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OtherUsersTest {
    @Test
    fun `removing other users is done only when none is left, and says why not otherwise`() {
        assertNull(OtherUsers.removalProblem(before = 0, left = 0, refused = 0, error = null))
        assertNull(OtherUsers.removalProblem(before = 2, left = 0, refused = 0, error = null))
        assertEquals(
            "Android didn't remove the other user or profile. Something other than Belay may stop users from being removed.",
            OtherUsers.removalProblem(before = 1, left = 1, refused = 1, error = null),
        )
        assertEquals(
            "Android didn't remove 1 of the 2 other users or profiles: SecurityException: not allowed",
            OtherUsers.removalProblem(before = 2, left = 1, refused = 0, error = "SecurityException: not allowed"),
        )
        assertEquals(WireLimits.MAX_PROBLEM, OtherUsers.removalProblem(1, 1, 0, "e".repeat(300))!!.length)
    }

    @Test
    fun `foreign restrictions are the ones in force that Belay didn't set, capped`() {
        val inForce = setOf("no_factory_reset", "no_safe_boot", "no_add_user", "no_config_vpn")
        assertEquals(listOf("no_config_vpn", "no_factory_reset"), OtherUsers.foreignRestrictions(inForce, setOf("no_safe_boot", "no_add_user", "no_sms")))
        assertEquals(emptyList(), OtherUsers.foreignRestrictions(emptySet(), setOf("no_safe_boot")))
        val many = (1..40).map { "no_thing_$it" }.toSet() + ("x".repeat(100))
        val capped = OtherUsers.foreignRestrictions(many, emptySet())
        assertEquals(WireLimits.MAX_FOREIGN_RESTRICTIONS, capped.size)
        assertTrue(capped.all { it.length <= WireLimits.MAX_RESTRICTION_KEY })
        assertEquals(capped.sorted(), capped)
    }
}
