package family.brooker.belay.archival

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The archival test's pure part (app/src/debug/.../archival/ArchivalLog.kt, debug builds only; compiled
 * into these tests by core/build.gradle.kts): the time box, what an update keeps, and what it never
 * does. Made-up messages and numbers only.
 */
class ArchivalLogTest {
    private val t0 = 1_800_000_000_000L
    private val minute = 60_000L
    private val zone = ZoneId.of("America/New_York")

    private fun started(minutes: Int = 60) = ArchivalLog.start(ArchivalTestState(), t0, minutes)

    /** What a message event's extras could carry: the test may keep the names, never these values. */
    private val madeUpExtras = mapOf(
        ArchivalLog.EXTRA_URI to "content://sms/4242",
        "body" to "Made-up words: meet at the made-up park at four",
        "address" to "+15555550123",
        "thread_id" to "77",
        "event" to "received",
    )

    @Test
    fun `the time box is an hour unless asked, from 1 to 120 minutes`() {
        assertEquals(60, ArchivalLog.minutes(null))
        assertEquals(30, ArchivalLog.minutes(30))
        assertEquals(1, ArchivalLog.minutes(0))
        assertEquals(1, ArchivalLog.minutes(-5))
        assertEquals(120, ArchivalLog.minutes(500))
        assertEquals(t0 + 120 * minute, ArchivalLog.start(ArchivalTestState(), t0, 10_000).until)
    }

    @Test
    fun `it's on from its start until its time is up, and then it's expired`() {
        val state = started()
        assertEquals(t0 + 60 * minute, state.until)
        assertTrue(ArchivalLog.isOn(state, t0))
        assertTrue(ArchivalLog.isOn(state, t0 + 60 * minute - 1))
        assertFalse(ArchivalLog.isOn(state, t0 + 60 * minute))
        assertFalse(ArchivalLog.expired(state, t0 + 59 * minute))
        assertTrue(ArchivalLog.expired(state, t0 + 60 * minute))
        assertTrue(ArchivalLog.expired(state, t0 + 600 * minute))
    }

    @Test
    fun `a clock set back before the start ends it too`() {
        val state = started()
        assertFalse(ArchivalLog.isOn(state, t0 - 1))
        assertTrue(ArchivalLog.expired(state, t0 - 24 * 60 * minute))
    }

    @Test
    fun `never started, it's neither on nor expired`() {
        assertFalse(ArchivalLog.isOn(ArchivalTestState(), t0))
        assertFalse(ArchivalLog.expired(ArchivalTestState(), t0))
        // A state missing its times (a damaged file) is never on.
        assertFalse(ArchivalLog.isOn(ArchivalTestState(on = true), t0))
        assertTrue(ArchivalLog.expired(ArchivalTestState(on = true), t0))
    }

    @Test
    fun `stopping keeps what it counted, and says why`() {
        val counted = ArchivalLog.record(started(), ArchivalLog.update(t0 + minute, ArchivalVia.SERVICE, listOf("a"), null))
        val stopped = ArchivalLog.stop(counted, t0 + 2 * minute, ArchivalStop.ADB)
        assertFalse(stopped.on)
        assertEquals(t0 + 2 * minute, stopped.stoppedAt)
        assertEquals(ArchivalStop.ADB, stopped.stoppedBecause)
        assertEquals(1, stopped.counts.updates)
        assertEquals(1, stopped.updates.size)
        // Stopping what isn't on changes nothing.
        assertEquals(stopped, ArchivalLog.stop(stopped, t0 + 3 * minute, ArchivalStop.TIME_UP))
    }

    @Test
    fun `starting again while it's on moves the end and keeps the counts, after it ended it counts afresh`() {
        val counted = ArchivalLog.record(started(), ArchivalLog.update(t0 + minute, ArchivalVia.SERVICE, emptyList(), null))
        val again = ArchivalLog.start(counted, t0 + 30 * minute, 60)
        assertEquals(t0, again.startedAt)
        assertEquals(t0 + 90 * minute, again.until)
        assertEquals(1, again.counts.updates)

        val ended = ArchivalLog.stop(again, t0 + 40 * minute, ArchivalStop.ADB)
        val fresh = ArchivalLog.start(ended, t0 + 50 * minute, 60)
        assertEquals(ArchivalTestState(on = true, startedAt = t0 + 50 * minute, until = t0 + 110 * minute), fresh)
        // An expired one that was never turned off counts afresh too.
        val expired = ArchivalLog.start(counted, t0 + 61 * minute, 60)
        assertEquals(0, expired.counts.updates)
        assertEquals(t0 + 61 * minute, expired.startedAt)
    }

    @Test
    fun `nothing is kept while it's off or after its time is up`() {
        val update = { at: Long -> ArchivalLog.update(at, ArchivalVia.SERVICE, madeUpExtras.keys, null) }
        val never = ArchivalTestState()
        assertEquals(never, ArchivalLog.record(never, update(t0)))
        val state = started()
        assertEquals(state, ArchivalLog.record(state, update(t0 + 60 * minute)))
        assertEquals(state, ArchivalLog.record(state, update(t0 - 1)))
        val stopped = ArchivalLog.stop(state, t0 + minute, ArchivalStop.ADB)
        assertEquals(stopped, ArchivalLog.record(stopped, update(t0 + 2 * minute)))
    }

    @Test
    fun `an update keeps the extras' names, never their values, and never the URI`() {
        val update = ArchivalLog.update(t0 + minute, ArchivalVia.SERVICE, madeUpExtras.keys, ArchivalLog.read(1))
        val state = ArchivalLog.record(started(), update)
        assertEquals(madeUpExtras.keys.sorted(), state.updates.single().extras)

        val json = ArchivalLog.JSON.encodeToString(ArchivalTestState.serializer(), state)
        for (value in madeUpExtras.values) assertFalse(value in json, "a value was kept: $value")
        assertFalse("4242" in json, "the URI's message id was kept")
        assertFalse("content://" in json, "the URI was kept")

        // Each update has exactly these fields, and its URI part only these: what reading it gave and how
        // many rows, nowhere to keep a value or anything else about a row.
        val kept = ArchivalLog.JSON.parseToJsonElement(json).jsonObject["updates"]!!.jsonArray.single().jsonObject
        assertEquals(setOf("at", "via", "extras", "more_extras", "uri"), kept.keys)
        assertEquals(setOf("outcome", "rows", "error"), (kept["uri"] as JsonObject).keys)
        assertEquals(UriRead(ArchivalRead.READ, rows = 1), state.updates.single().uri)
    }

    @Test
    fun `a failed read keeps only the exception's class, never its message`() {
        val failed = ArchivalLog.failed("SecurityException")
        assertEquals(UriRead(ArchivalRead.FAILED, error = "SecurityException"), failed)
        assertEquals(ArchivalLog.MAX_ERROR_LENGTH, ArchivalLog.failed("X".repeat(500)).error!!.length)
        assertEquals("?", ArchivalLog.failed(null).error)
        assertNull(failed.rows)
    }

    @Test
    fun `names from another app are capped and shown plainly`() {
        val names = (1..30).map { "extra_${it.toString().padStart(2, '0')}" }
        val update = ArchivalLog.update(t0, ArchivalVia.BROADCAST, names + listOf(null, "extra_01"), null)
        assertEquals(ArchivalLog.MAX_NAMES, update.extras.size)
        assertEquals(10, update.moreExtras)
        assertEquals("extra_01", update.extras.first())

        val long = ArchivalLog.clean("n".repeat(200))
        assertEquals(ArchivalLog.MAX_NAME_LENGTH, long.length)
        assertTrue(long.endsWith("…"))
        assertEquals("a?b?c", ArchivalLog.clean("a\nb\u0000c"))
    }

    @Test
    fun `a read keeps only how many rows, never less than none`() {
        assertEquals(UriRead(ArchivalRead.READ, rows = 3), ArchivalLog.read(3))
        assertEquals(0, ArchivalLog.read(-1).rows)
        assertNull(ArchivalLog.read(0).error)
    }

    @Test
    fun `only the phone's message store is read`() {
        for (store in listOf("sms", "mms", "mms-sms")) assertTrue(ArchivalLog.readable(store), store)
        for (other in listOf(null, "", "SMS", "sms-changes", "telephony", "com.google.android.apps.messaging.provider", "com.example.made.up")) {
            assertFalse(ArchivalLog.readable(other), "$other")
        }
    }

    @Test
    fun `every update is counted, the list keeps the last 50`() {
        var state = started()
        val outcomes = listOf(
            ArchivalLog.read(1),
            UriRead(ArchivalRead.NO_CURSOR),
            ArchivalLog.failed("SecurityException"),
            UriRead(ArchivalRead.NOT_MESSAGES),
            UriRead(ArchivalRead.NOT_A_URI),
            null,
        )
        for (i in 0 until 60) {
            val via = if (i % 2 == 0) ArchivalVia.SERVICE else ArchivalVia.BROADCAST
            state = ArchivalLog.record(state, ArchivalLog.update(t0 + i * 1000L, via, listOf("n$i"), outcomes[i % outcomes.size]))
        }
        val c = state.counts
        assertEquals(60, c.updates)
        assertEquals(30, c.byService)
        assertEquals(30, c.byBroadcast)
        assertEquals(50, c.withUri)
        assertEquals(10, c.read)
        assertEquals(10L, c.rows)
        assertEquals(20, c.readFailed)
        assertEquals(20, c.notRead)
        assertEquals(t0, c.firstAt)
        assertEquals(t0 + 59_000L, c.lastAt)
        assertEquals(ArchivalLog.MAX_KEPT, state.updates.size)
        assertEquals(listOf("n10"), state.updates.first().extras)
        assertEquals(listOf("n59"), state.updates.last().extras)
    }

    @Test
    fun `the state file reads back, and ignores fields it doesn't know`() {
        val state = ArchivalLog.record(started(), ArchivalLog.update(t0 + minute, ArchivalVia.SERVICE, listOf("x"), ArchivalLog.read(1)))
        val json = ArchivalLog.JSON.encodeToString(ArchivalTestState.serializer(), state)
        assertEquals(state, ArchivalLog.JSON.decodeFromString(ArchivalTestState.serializer(), json))
        val newer = json.replaceFirst("{", "{\"from_a_newer_build\":1,")
        assertEquals(state, ArchivalLog.JSON.decodeFromString(ArchivalTestState.serializer(), newer))
        // Every field is written, so the debug state shows zeros and nulls too.
        assertTrue("\"stopped_because\":null" in json)
        assertTrue("\"by_broadcast\":0" in json)
    }

    @Test
    fun `the one-line summary has the counts and times, never a name`() {
        val state = ArchivalLog.record(started(), ArchivalLog.update(t0 + minute, ArchivalVia.SERVICE, listOf("secret_extra_name"), ArchivalLog.read(1)))
        val on = ArchivalLog.summary(state, t0 + 2 * minute, zone)
        assertTrue(on.startsWith("on until 2027-01-15T04:00:00-05:00 (58 min left); updates: 1 (service 1, broadcast 0)"), on)
        assertTrue("with a message URI: 1 (read 1, rows 1, failed 0, not read 0)" in on, on)
        assertTrue("first 2027-01-15T03:01:00-05:00, last 2027-01-15T03:01:00-05:00" in on, on)
        assertFalse("secret_extra_name" in on)

        val off = ArchivalLog.summary(ArchivalLog.stop(state, t0 + 3 * minute, ArchivalStop.TIME_UP), t0 + 4 * minute, zone)
        assertTrue(off.startsWith("off since 2027-01-15T03:03:00-05:00 (its time was up)"), off)
        assertEquals("on, but its time is up", ArchivalLog.summary(state, t0 + 61 * minute, zone).substringBefore(";"))
        assertTrue(ArchivalLog.summary(ArchivalTestState(), t0, zone).startsWith("off: never started; updates: 0"))
    }
}
