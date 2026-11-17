package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CommandLogTest {
    private val runs = setOf(WireCommand.REMOVE_OTHER_USERS)
    private val remove = WireCommand("command-1", WireCommand.REMOVE_OTHER_USERS, issuedAt = T0)

    @Test
    fun `a command runs once, even while the policy still lists it`() {
        val first = Commands.plan(listOf(remove), CommandLog().doneIds, T0, runs)
        assertEquals(listOf(remove), first.run)
        val log = CommandLog().record(listOf(CommandLog.done(remove, T0 + 1)))
        assertEquals(listOf(WireCommandResult("command-1", WireCommandOutcome.DONE, T0 + 1)), log.results)
        val again = Commands.plan(listOf(remove), log.doneIds, T0 + 2, runs)
        assertEquals(CommandPlan(emptyList(), emptyList(), emptyList()), again)
        assertTrue(CommandLog.notRun(again, T0 + 2).isEmpty())
    }

    @Test
    fun `expired commands and kinds Belay doesn't know are reported, not run`() {
        val late = WireCommand("command-2", WireCommand.REMOVE_OTHER_USERS, issuedAt = T0, expiresAt = T0 + 10)
        val newer = WireCommand("command-3", "from_a_newer_server", issuedAt = T0)
        val plan = Commands.plan(listOf(late, newer), emptySet(), T0 + 10, runs)
        assertEquals(
            listOf(
                WireCommandResult("command-2", WireCommandOutcome.EXPIRED, T0 + 10),
                WireCommandResult("command-3", WireCommandOutcome.FAILED, T0 + 10, "Belay doesn't know this command yet. Updating Belay may help."),
            ),
            CommandLog.notRun(plan, T0 + 10),
        )
    }

    @Test
    fun `results are newest first, the last 20, and done ids are kept far longer`() {
        var log = CommandLog()
        for (i in 1..30) {
            log = log.record(listOf(WireCommandResult("command-$i", WireCommandOutcome.DONE, T0 + i)))
        }
        assertEquals(WireLimits.MAX_COMMAND_RESULTS, log.results.size)
        assertEquals("command-30", log.results.first().id)
        assertEquals("command-11", log.results.last().id)
        assertEquals(30, log.done.size)
        assertTrue("command-1" in log.doneIds, "an old id still never runs again")

        // Several in one step: the one that ran last is the newest.
        val two = CommandLog().record(listOf(CommandLog.done(remove, T0), WireCommandResult("command-9", WireCommandOutcome.EXPIRED, T0)))
        assertEquals(listOf("command-9", "command-1"), two.results.map { it.id })

        var full = CommandLog()
        for (i in 1..(CommandLog.MAX_DONE + 50)) full = full.record(listOf(WireCommandResult("c-$i", WireCommandOutcome.DONE, T0)))
        assertEquals(CommandLog.MAX_DONE, full.done.size)
        assertEquals("c-${CommandLog.MAX_DONE + 50}", full.done.last())
    }

    @Test
    fun `a failure's words are capped for the server`() {
        assertEquals(WireLimits.MAX_PROBLEM, CommandLog.failed(remove, T0, "x".repeat(300)).problem!!.length)
    }
}
