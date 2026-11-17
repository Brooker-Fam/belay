package family.brooker.belay.core.location

import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.ids
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up places: the coordinates are a field outside a made-up town. */
class PlacesTest {
    private val school = WirePlace("p-school", "School", 40.0, -75.0, 150, listOf(WirePlaceNotify.ARRIVE, WirePlaceNotify.LEAVE))
    private val field = WirePlace("p-field", "Field", 40.0, -75.0, 400)

    /** About this many degrees of latitude per meter. */
    private val perMeter = 1 / (Geo.EARTH_RADIUS_M * Math.PI / 180)

    private var n = 0

    /** A fix [metersNorth] of the places' center. */
    private fun fix(metersNorth: Double, accuracy: Int = 10, mock: Boolean = false, at: Long = T0 + (n * 60_000L)) =
        PlaceFix("fix-${++n}", at, 40.0 + metersNorth * perMeter, -75.0, accuracy, mock)

    /** Each fix in turn, from [start]; the tracks at the end and every event. */
    private fun run(places: List<WirePlace>, vararg fixes: PlaceFix, start: Map<String, PlaceTrack> = emptyMap()): PlacesOutcome {
        var tracks = start
        val events = mutableListOf<WirePlaceEvent>()
        val newId = ids()
        for (f in fixes) {
            val outcome = Places.evaluate(places, tracks, f, newId)
            tracks = outcome.tracks
            events += outcome.events
        }
        return PlacesOutcome(tracks, events)
    }

    private fun outside(place: WirePlace = school) = mapOf(place.id to PlaceTrack(Places.shapeOf(place), inside = false))

    private fun inside(place: WirePlace = school) = mapOf(place.id to PlaceTrack(Places.shapeOf(place), inside = true))

    @Test
    fun `the distance is right to within a meter`() {
        assertEquals(1000.0, Geo.distanceM(40.0, -75.0, 40.0 + 1000 * perMeter, -75.0), 0.5)
        assertEquals(0.0, Geo.distanceM(40.0, -75.0, 40.0, -75.0), 0.0)
    }

    @Test
    fun `two fixes in a row inside the radius less the accuracy arrive`() {
        val first = fix(50.0)
        val second = fix(60.0)
        val outcome = run(listOf(school), first, second, start = outside())
        val event = outcome.events.single()
        assertEquals(WirePlaceEventKind.ARRIVED, event.kind)
        assertEquals("p-school", event.placeId)
        assertEquals(first.at, event.at, "the event is when the phone was first seen inside")
        assertEquals(second.id, event.fixId, "the second fix decided")
        assertEquals(true, outcome.tracks.getValue("p-school").inside)
    }

    @Test
    fun `one fix inside isn't enough`() {
        val outcome = run(listOf(school), fix(50.0), start = outside())
        assertTrue(outcome.events.isEmpty())
        assertEquals(false, outcome.tracks.getValue("p-school").inside)
    }

    @Test
    fun `two fixes in a row outside the radius plus the accuracy leave`() {
        val outcome = run(listOf(school), fix(400.0), fix(500.0), start = inside())
        assertEquals(WirePlaceEventKind.LEFT, outcome.events.single().kind)
        assertEquals(false, outcome.tracks.getValue("p-school").inside)
    }

    @Test
    fun `jitter at the edge decides nothing and doesn't flap`() {
        // Inside, then fixes that hop across the 150 m edge, each within its accuracy of it.
        val outcome = run(listOf(school), fix(145.0, accuracy = 20), fix(155.0, accuracy = 20), fix(140.0, accuracy = 20), fix(160.0, accuracy = 20), start = inside())
        assertTrue(outcome.events.isEmpty())
        assertEquals(true, outcome.tracks.getValue("p-school").inside)
        assertNull(outcome.tracks.getValue("p-school").streak, "a fix near the edge starts the count again")
    }

    @Test
    fun `a fix near the edge between two outside ones breaks the row`() {
        val outcome = run(listOf(school), fix(400.0), fix(150.0, accuracy = 20), fix(400.0), start = inside())
        assertTrue(outcome.events.isEmpty())
        val more = run(listOf(school), fix(400.0), start = outcome.tracks)
        assertEquals(WirePlaceEventKind.LEFT, more.events.single().kind)
    }

    @Test
    fun `a fix less accurate than the radius decides nothing, and doesn't break the row`() {
        val vague = fix(0.0, accuracy = 200)
        val alone = run(listOf(school), vague, vague.copy(id = "fix-x"), start = outside())
        assertTrue(alone.events.isEmpty())
        assertEquals(outside(), alone.tracks)
        val between = run(listOf(school), fix(50.0), fix(0.0, accuracy = 151), fix(50.0), start = outside())
        assertEquals(WirePlaceEventKind.ARRIVED, between.events.single().kind)
    }

    @Test
    fun `a mock fix never counts`() {
        val outcome = run(listOf(school), fix(10.0, mock = true), fix(10.0, mock = true), fix(10.0, mock = true), start = outside())
        assertTrue(outcome.events.isEmpty())
        assertEquals(outside(), outcome.tracks)
        assertNull(Places.edgeDistanceM(listOf(school), fix(10.0, mock = true)))
    }

    @Test
    fun `overlapping places each get their own events`() {
        val outcome = run(listOf(school, field), fix(50.0), fix(50.0), start = outside(school) + outside(field))
        assertEquals(setOf("p-school", "p-field"), outcome.events.map { it.placeId }.toSet())
        assertTrue(outcome.events.all { it.kind == WirePlaceEventKind.ARRIVED })
        // 300 m out: outside the school, still inside the field.
        val later = run(listOf(school, field), fix(300.0), fix(300.0), start = outcome.tracks)
        assertEquals(listOf("p-school" to WirePlaceEventKind.LEFT), later.events.map { it.placeId to it.kind })
    }

    @Test
    fun `the first decision for a place is quiet`() {
        val outcome = run(listOf(school), fix(20.0), fix(20.0))
        assertTrue(outcome.events.isEmpty(), "a phone already at school when the place is added didn't just arrive")
        assertEquals(true, outcome.tracks.getValue("p-school").inside)
        val left = run(listOf(school), fix(500.0), fix(500.0), start = outcome.tracks)
        assertEquals(WirePlaceEventKind.LEFT, left.events.single().kind)
    }

    @Test
    fun `a place that moved or grew starts again, and a removed place is forgotten`() {
        val moved = school.copy(lat = 40.1)
        val outcome = run(listOf(moved), fix(20.0), start = inside())
        assertNull(outcome.tracks.getValue("p-school").inside)
        val gone = run(listOf(field), fix(20.0), start = inside())
        assertEquals(setOf("p-field"), gone.tracks.keys)
    }

    @Test
    fun `the edge distance takes the nearest edge, less the accuracy`() {
        // 100 m north: 50 m inside the school's edge, 300 m inside the field's; accuracy 10.
        assertEquals(40.0, Places.edgeDistanceM(listOf(school, field), fix(100.0))!!, 0.5)
        assertEquals(0.0, Places.edgeDistanceM(listOf(school), fix(150.0, accuracy = 30))!!, 0.0)
        assertNull(Places.edgeDistanceM(emptyList(), fix(100.0)))
    }
}
