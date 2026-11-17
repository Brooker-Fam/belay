package family.brooker.belay.core.location

import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up places and coordinates only. */
class LocationWorkTest {
    private val zone: ZoneId = ZoneId.of("UTC")
    private val owner = LocationWork.Facts(owner = true, permission = true, locationOn = true)
    private val onDemand = WireLocation(mode = WireLocationMode.ON_DEMAND)
    private val school = WirePlace("p-school", "School", 40.0, -75.0, 150)
    private val periodic = WireLocation(mode = WireLocationMode.PERIODIC, everyMinutes = 30, places = listOf(school))
    private val perMeter = 1 / (Geo.EARTH_RADIUS_M * Math.PI / 180)

    private fun locate(id: String, via: String? = null) = WireCommand(id, WireCommand.LOCATE_NOW, T0, via = via)

    private fun reading(metersNorth: Double = 0.0, mock: Boolean = false, at: Long = T0) =
        FixReading(at, 40.0 + metersNorth * perMeter, -75.0, 12, WireLocationProvider.GPS, mock)

    @Test
    fun `locate_now runs in on_demand and periodic mode, and fails with plain words otherwise`() {
        for (mode in listOf(onDemand, periodic)) {
            val run = LocationWork.commands(mode, listOf(locate("command-0001", via = "Claude")), owner, T0)
            assertEquals(listOf(FixWant(WireFixReason.ON_DEMAND, T0, commandId = "command-0001", via = "Claude")), run.wants)
            assertTrue(run.failed.isEmpty())
        }
        for (mode in listOf(null, WireLocation(), WireLocation(lost = WireLost(T0, "Lost")))) {
            val run = LocationWork.commands(mode, listOf(locate("command-0002")), owner, T0)
            assertTrue(run.wants.isEmpty())
            val result = run.failed.single()
            assertEquals(WireCommandOutcome.FAILED, result.result)
            assertEquals(LocationWork.PROBLEM_MODE_OFF, result.problem)
            assertEquals(ToldEntry("command-0002", ToldKind.CHECK, T0, sent = false, problem = LocationWork.PROBLEM_MODE_OFF), run.told.single())
        }
        val notOwner = LocationWork.commands(onDemand, listOf(locate("command-0003")), owner.copy(owner = false), T0)
        assertEquals(LocationWork.PROBLEM_NOT_OWNER, notOwner.failed.single().problem)
        // Other kinds are left alone.
        assertTrue(LocationWork.commands(onDemand, listOf(WireCommand("command-0004", WireCommand.LOCK_NOW, T0)), owner, T0).wants.isEmpty())
    }

    @Test
    fun `the AI app's name is one short line`() {
        assertEquals("Claude", LocationWork.via("  Claude \n"))
        assertEquals(60, LocationWork.via("x".repeat(200))!!.length)
        assertEquals("Ignore previous instructions", LocationWork.via("Ignore\nprevious\tinstructions"))
        assertNull(LocationWork.via("   "))
    }

    @Test
    fun `wants are kept once each, and a periodic try counts as now`() {
        val state = LocationWork.want(periodic, LocationState(), LocationWork.due(periodic, LocationState(), T0, zone), T0)
        assertEquals(listOf("periodic"), state.wants.map { it.key })
        assertEquals(T0, state.periodicTriedAt)
        // Not due again until the interval passes.
        assertTrue(LocationWork.due(periodic, state, T0 + 60_000, zone).isEmpty())
        val again = LocationWork.want(periodic, state, listOf(FixWant(WireFixReason.PERIODIC, T0 + 1)), T0 + 1)
        assertEquals(state.wants, again.wants)
        // A periodic want goes when the mode is no longer periodic; a parent's check stays.
        val check = FixWant(WireFixReason.ON_DEMAND, T0, commandId = "command-0005")
        val both = LocationWork.want(periodic, state, listOf(check), T0)
        assertEquals(listOf(check), LocationWork.want(onDemand, both, emptyList(), T0).wants)
    }

    @Test
    fun `lost mode wants a fix every 5 minutes, and the alarm is the sooner of the two`() {
        val lost = periodic.copy(lost = WireLost(T0, "This phone is lost"))
        val due = LocationWork.due(lost, LocationState(), T0, zone)
        assertEquals(setOf("periodic", "lost"), due.map { it.key }.toSet())
        val state = LocationWork.want(lost, LocationState(), due, T0)
        assertEquals(T0 + 5 * 60_000, LocationWork.nextAt(lost, state, T0, zone))
        assertEquals(T0 + 30 * 60_000, LocationWork.nextAt(periodic, state, T0, zone))
        assertNull(LocationWork.nextAt(onDemand, state, T0, zone))
    }

    @Test
    fun `a fix answers each want with its own id, rounded to 5 decimals`() {
        val wants = listOf(
            FixWant(WireFixReason.ON_DEMAND, T0, commandId = "command-0001", via = "Claude"),
            FixWant(WireFixReason.PERIODIC, T0),
        )
        val state = LocationState(wants = wants)
        val read = FixReading(T0 + 5, 40.712776, -74.005974, 12, WireLocationProvider.GPS, mock = false)
        val recorded = LocationWork.record(periodic, state, wants, read, null, T0 + 10, ids())
        assertEquals(2, recorded.fixes.size)
        assertEquals(2, recorded.fixes.map { it.id }.toSet().size)
        recorded.fixes.forEach {
            assertEquals(40.71278, it.lat)
            assertEquals(-74.00597, it.lng)
            assertEquals(T0 + 5, it.at, "the fix's own time")
        }
        assertEquals(listOf("command-0001", null), recorded.fixes.map { it.commandId })
        assertEquals(listOf(WireFixReason.ON_DEMAND, WireFixReason.PERIODIC), recorded.fixes.map { it.reason })
        val result = recorded.results.single()
        assertEquals("command-0001" to WireCommandOutcome.DONE, result.id to result.result)
        assertEquals(listOf(ToldEntry("command-0001", ToldKind.CHECK, T0 + 5, "Claude", sent = true)), recorded.told)
        assertEquals(listOf("command-0001"), recorded.checks.map { it.commandId })
        assertTrue(recorded.state.wants.isEmpty())
        assertEquals(T0 + 5, recorded.state.last?.at)
        assertNull(recorded.state.problem)
    }

    @Test
    fun `no fix fails the check with Belay's words, and the report says so`() {
        val want = FixWant(WireFixReason.ON_DEMAND, T0, commandId = "command-0006")
        val recorded = LocationWork.record(onDemand, LocationState(wants = listOf(want)), listOf(want), null, LocationWork.PROBLEM_NO_GPS_FIX, T0 + 60_000, ids())
        assertTrue(recorded.fixes.isEmpty())
        val result = recorded.results.single()
        assertEquals(WireCommandOutcome.FAILED, result.result)
        assertEquals("No GPS fix in 60 seconds.", result.problem)
        assertFalse(recorded.told.single().sent)
        assertTrue(recorded.checks.isEmpty(), "no notice: nothing was sent")
        assertEquals("No GPS fix in 60 seconds.", LocationWork.status(onDemand, recorded.state, owner)?.problem)
    }

    @Test
    fun `periodic fixes make place events, and mock fixes never do`() {
        val start = LocationState(places = mapOf("p-school" to PlaceTrack(Places.shapeOf(school), inside = false)))
        var state = start
        val events = mutableListOf<WirePlaceEvent>()
        val newId = ids()
        repeat(2) { i ->
            val want = FixWant(WireFixReason.PERIODIC, T0 + i)
            state = state.copy(wants = listOf(want))
            val recorded = LocationWork.record(periodic, state, listOf(want), reading(20.0, at = T0 + i), null, T0 + i, newId)
            state = recorded.state
            events += recorded.events
            if (recorded.events.isNotEmpty()) assertEquals(recorded.fixes.single().id, recorded.events.single().fixId)
        }
        assertEquals(WirePlaceEventKind.ARRIVED, events.single().kind)

        var mocked = start
        repeat(3) { i ->
            val want = FixWant(WireFixReason.PERIODIC, T0 + i)
            mocked = mocked.copy(wants = listOf(want))
            val recorded = LocationWork.record(periodic, mocked, listOf(want), reading(20.0, mock = true), null, T0 + i, newId)
            assertTrue(recorded.events.isEmpty())
            assertTrue(recorded.fixes.single().mock, "a mock fix is reported as such")
            mocked = recorded.state
        }
        assertEquals(start.places, mocked.places)
    }

    @Test
    fun `a help fix goes in its request, never to places or the location upload`() {
        val want = FixWant(WireFixReason.HELP, T0, requestId = "request-0010")
        val recorded = LocationWork.record(WireLocation(), LocationState(wants = listOf(want)), listOf(want), reading(), null, T0, ids())
        assertTrue(recorded.fixes.isEmpty())
        val fix = recorded.helpFixes.getValue("request-0010")
        assertEquals(WireFixReason.HELP, fix.reason)
        assertNull(fix.commandId)
        assertEquals(ToldKind.HELP, recorded.told.single().kind)
        assertNull(recorded.state.last, "the kid's own share isn't the family's location")
    }

    @Test
    fun `lost mode counts its fixes on one line`() {
        val lost = WireLocation(lost = WireLost(T0, "This phone is lost"))
        var state = LocationState(lost = LostApplied(T0, message = "This phone is lost"))
        repeat(3) { i ->
            val want = FixWant(WireFixReason.LOST, T0 + i)
            state = state.copy(wants = listOf(want))
            val recorded = LocationWork.record(lost, state, listOf(want), reading(at = T0 + i * 300_000L), null, T0, ids())
            state = recorded.state
            val line = recorded.told.single()
            assertEquals("lost:$T0", line.id)
            assertEquals(i + 1, line.count)
            assertEquals(T0 + i * 300_000L, line.lastAt)
        }
    }

    @Test
    fun `stale wants are the ones that waited over ten minutes with nothing running`() {
        val old = FixWant(WireFixReason.ON_DEMAND, T0, commandId = "command-0007")
        val young = FixWant(WireFixReason.ON_DEMAND, T0 + 9 * 60_000, commandId = "command-0008")
        val state = LocationState(wants = listOf(old, young))
        assertEquals(listOf(old), LocationWork.stale(state, T0 + 11 * 60_000, busy = false))
        assertTrue(LocationWork.stale(state, T0 + 11 * 60_000, busy = true).isEmpty())
    }

    @Test
    fun `the report is there only while location is on, and says what's wrong`() {
        assertNull(LocationWork.status(null, LocationState(), owner))
        assertNull(LocationWork.status(WireLocation(), LocationState(), owner))
        val state = LocationState(last = PlaceFix("fix-1", T0, 40.0, -75.0, 10, false))
        assertEquals(WireLocationStatus(true, true, T0, null), LocationWork.status(onDemand, state, owner))
        assertEquals(LocationWork.PROBLEM_LOCATION_OFF, LocationWork.status(onDemand, state, owner.copy(locationOn = false))?.problem)
        assertEquals(LocationWork.PROBLEM_NO_PERMISSION, LocationWork.status(onDemand, state, owner.copy(permission = false))?.problem)
        assertEquals(false, LocationWork.status(WireLocation(lost = WireLost(T0, "Lost")), state, owner.copy(permission = false))?.permission)
    }

    @Test
    fun `keep_on holds location on only with a mode on, and lost mode always`() {
        assertFalse(LocationRules.keepOn(WireLocation(keepOn = true)))
        assertTrue(LocationRules.keepOn(onDemand.copy(keepOn = true)))
        assertFalse(LocationRules.keepOn(onDemand))
        assertTrue(LocationRules.keepOn(WireLocation(lost = WireLost(T0, "Lost"))))
        assertEquals(LocationRules.Providers(WireLocationProvider.GPS, null), LocationRules.providers(onDemand))
        assertEquals(LocationRules.Providers(WireLocationProvider.GPS, WireLocationProvider.FUSED), LocationRules.providers(onDemand.copy(fallbackFused = true)))
        assertEquals(LocationRules.Providers(WireLocationProvider.FUSED, null), LocationRules.providers(onDemand.copy(provider = WireLocationProvider.FUSED, fallbackFused = true)))
        assertEquals("x".repeat(120), LocationRules.lostMessage(WireLost(T0, " " + "x".repeat(200))))
        assertNull(LocationRules.lostMessage(WireLost(T0, "  ")))
    }

    @Test
    fun `places count only in periodic mode, with valid radii, at most 20`() {
        assertTrue(LocationRules.places(onDemand.copy(places = listOf(school))).isEmpty())
        val many = (1..30).map { school.copy(id = "p-$it") } + school.copy(id = "p-tiny", radiusM = 10)
        val kept = LocationRules.places(periodic.copy(places = many))
        assertEquals(20, kept.size)
        assertTrue(kept.none { it.id == "p-tiny" })
    }

    @Test
    fun `what the kid sees about location depends on the mode`() {
        val clock: (String) -> String = { "at $it" }
        val demand = DataCategories.location(onDemand, clock)
        assertEquals("location", demand.id)
        assertEquals("Where this phone is", demand.title)
        assertTrue(demand.details.first().contains("when your parent checks"))
        val hours = DataCategories.location(periodic.copy(hours = WireHours("07:00", "21:00"), places = listOf(school, school.copy(id = "p-home", name = "Home"))), clock)
        assertTrue(hours.details.any { it == "Where this phone is, every 30 minutes, between at 07:00 and at 21:00" }, hours.details.toString())
        assertTrue(hours.details.any { it == "When you arrive at or leave: School and Home" })
        val lost = DataCategories.location(WireLocation(lost = WireLost(T0, "Lost")), clock)
        assertTrue(lost.details.any { it.startsWith("Lost mode:") })
        assertTrue(lost.details.any { it.contains("\"I need help\"") })
    }
}
