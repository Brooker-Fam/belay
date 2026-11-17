package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals

class CommandsTest {
    private val runs = setOf(WireCommand.LOCK_NOW, WireCommand.REMOVE_OTHER_USERS)

    @Test
    fun `commands run once each, expire, and kinds Belay doesn't know are reported`() {
        val lockNow = WireCommand("c-1", WireCommand.LOCK_NOW, issuedAt = 1_500, expiresAt = 2_100)
        val expired = WireCommand("c-2", WireCommand.LOCK_NOW, issuedAt = 1_400, expiresAt = 1_410)
        val later = WireCommand("c-3", "locate_now", issuedAt = 1_500, expiresAt = 2_600)
        val done = WireCommand("c-4", WireCommand.LOCK_NOW, issuedAt = 1_500, expiresAt = 2_600)
        val plan = Commands.plan(listOf(lockNow, expired, later, done, lockNow), done = setOf("c-4"), now = 1_505, runs = runs)
        assertEquals(CommandPlan(run = listOf(lockNow), expired = listOf(expired), unknown = listOf(later)), plan)
        assertEquals(listOf(lockNow), plan.lockNow)
        assertEquals(listOf(lockNow), Commands.plan(listOf(lockNow), emptySet(), 2_099, runs).run)
        assertEquals(listOf(lockNow), Commands.plan(listOf(lockNow), emptySet(), 2_100, runs).expired, "expires_at itself is too late")
    }

    @Test
    fun `a command without expires_at never expires, and a kind this build doesn't run is reported`() {
        val remove = WireCommand("c-5", WireCommand.REMOVE_OTHER_USERS, issuedAt = 1)
        assertEquals(listOf(remove), Commands.plan(listOf(remove), emptySet(), Long.MAX_VALUE, runs).run)
        assertEquals(listOf(remove), Commands.plan(listOf(remove), emptySet(), 2, runs = setOf(WireCommand.LOCK_NOW)).unknown)
        assertEquals(emptyList(), Commands.plan(listOf(remove), setOf("c-5"), 2, runs).run)
    }
}
