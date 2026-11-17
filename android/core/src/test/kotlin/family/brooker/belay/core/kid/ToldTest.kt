package family.brooker.belay.core.kid

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.location.FixReading
import family.brooker.belay.core.location.FixWant
import family.brooker.belay.core.location.LocationState
import family.brooker.belay.core.location.LocationWork
import family.brooker.belay.core.location.LostApplied
import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.ToldKind
import family.brooker.belay.core.location.WireFixReason
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.core.location.WireLocationProvider
import family.brooker.belay.core.location.WireLost
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** "What Belay told your parent", built from the phone's own record of what it ran. */
class ToldTest {
    private val day = 24 * HOUR
    private val reading = FixReading(T0, 40.0, -75.0, 12, WireLocationProvider.GPS, mock = false)

    @Test
    fun `every check a parent asked for is listed, sent or not, newest first`() {
        val onDemand = WireLocation(mode = WireLocationMode.ON_DEMAND)
        val owner = LocationWork.Facts(owner = true, permission = true, locationOn = true)
        val record = mutableListOf<ToldEntry>()
        // A check that ran, one that found nothing, and one refused because location was off.
        val asked = LocationWork.commands(onDemand, listOf(WireCommand("command-1", WireCommand.LOCATE_NOW, T0, via = "Claude")), owner, T0)
        record += LocationWork.record(onDemand, LocationState(wants = asked.wants), asked.wants, reading, null, T0, ids()).told
        val nothing = FixWant(WireFixReason.ON_DEMAND, T0 + HOUR, commandId = "command-2")
        record += LocationWork.record(onDemand, LocationState(wants = listOf(nothing)), listOf(nothing), null, LocationWork.PROBLEM_NO_GPS_FIX, T0 + HOUR, ids()).told
        record += LocationWork.commands(WireLocation(), listOf(WireCommand("command-3", WireCommand.LOCATE_NOW, T0)), owner, T0 + 2 * HOUR).told

        val list = Told.list(record, T0 + 3 * HOUR)
        assertEquals(listOf("command-3", "command-2", "command-1"), list.map { it.id })
        assertEquals(listOf(false, false, true), list.map { it.sent })
        assertEquals("Claude", list.last().via)
        assertEquals(3, Told.checks(list).size)
    }

    @Test
    fun `a lost mode is one line, with its newest count`() {
        val lost = WireLocation(lost = WireLost(T0, "This phone is lost"))
        var state = LocationState(lost = LostApplied(T0))
        val record = mutableListOf<ToldEntry>()
        repeat(4) { i ->
            val want = FixWant(WireFixReason.LOST, T0 + i * 300_000L)
            state = state.copy(wants = listOf(want))
            val recorded = LocationWork.record(lost, state, listOf(want), reading.copy(at = T0 + i * 300_000L), null, T0, ids())
            state = recorded.state
            record += recorded.told
        }
        val line = Told.list(record, T0 + HOUR).single()
        assertEquals(ToldKind.LOST, line.kind)
        assertEquals(4, line.count)
        assertEquals(T0 + 900_000, line.lastAt)
    }

    @Test
    fun `the list is the last 30 days`() {
        val old = ToldEntry("command-old", ToldKind.CHECK, T0, sent = true)
        val recent = ToldEntry("command-new", ToldKind.CHECK, T0 + 29 * day, sent = true)
        // A lost mode that started long ago but sent a fix recently is still there.
        val lost = ToldEntry("lost:1", ToldKind.LOST, T0 - day, sent = true, count = 900, lastAt = T0 + 30 * day)
        val list = Told.list(listOf(old, recent, lost), T0 + 31 * day)
        assertEquals(listOf("lost:1", "command-new"), list.map { it.id })
        assertTrue(Told.keepFrom(T0 + 31 * day) > T0)
    }
}
