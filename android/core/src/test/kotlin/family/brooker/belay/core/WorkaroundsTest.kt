package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WorkaroundsTest {
    private val roles = PhoneRoles(self = "family.example.belay")

    private fun plan(policy: WirePolicy, recoveryUntil: Long? = null) =
        Enforcement.plan(Enforcement.Input(policy, emptyMap(), roles, Applied(), false, Enforcement.sdkFull(37), T0, recoveryUntil = recoveryUntil))

    private val filtered = WirePolicy(version = 2, web = WireWebPolicy(privateDns = "family-filter-dns.cleanbrowsing.org"))

    @Test
    fun `a proxy is reported only while the policy has a web filter`() {
        assertEquals(listOf(Workarounds.PROXY), Workarounds.problems(plan(filtered), proxy = true, wirelessDebugging = false))
        assertEquals(emptyList(), Workarounds.problems(plan(filtered), proxy = false, wirelessDebugging = false))
        // Without a filter, a proxy gets around nothing Belay does.
        assertEquals(emptyList(), Workarounds.problems(plan(WirePolicy(version = 2)), proxy = true, wirelessDebugging = false))
    }

    @Test
    fun `wireless debugging is reported unless the policy lifted debugging on purpose`() {
        val locked = WirePolicy(version = 2, restrictions = WireRestrictions(debugging = true))
        assertEquals(listOf(Workarounds.WIRELESS_DEBUGGING), Workarounds.problems(plan(WirePolicy(version = 2)), proxy = false, wirelessDebugging = true))
        assertEquals(listOf(Workarounds.WIRELESS_DEBUGGING), Workarounds.problems(plan(locked), proxy = false, wirelessDebugging = true))
        assertEquals(emptyList(), Workarounds.problems(plan(locked), proxy = false, wirelessDebugging = false))
        // Maintenance mode and the recovery key's repair access open adb for repairs.
        val maintenance = locked.copy(maintenanceUntil = T0 + HOUR)
        assertEquals(emptyList(), Workarounds.problems(plan(maintenance), proxy = false, wirelessDebugging = true))
        assertEquals(emptyList(), Workarounds.problems(plan(locked, recoveryUntil = T0 + HOUR), proxy = false, wirelessDebugging = true))
    }

    @Test
    fun `both together, in Belay's words, short enough to send`() {
        val both = Workarounds.problems(plan(filtered), proxy = true, wirelessDebugging = true)
        assertEquals(listOf(Workarounds.PROXY, Workarounds.WIRELESS_DEBUGGING), both)
        assertTrue(both.all { it.length <= Enforcement.MAX_PROBLEM })
        // The server tells "another user or profile" apart as tampering of its own; these say neither.
        assertTrue(both.none { "profile" in it || "another user" in it })
    }
}
