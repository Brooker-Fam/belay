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
 * does; and the eighth review's K1, turned to assert the fix: only one message's URI is read, and an
 * update from any app fills the record only so far, which says it can't tell who sent one. Made-up
 * messages and numbers only.
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
        assertEquals(8, ArchivalLog.MAX_NAMES)
        assertEquals(ArchivalLog.MAX_NAMES, update.extras.size)
        assertEquals(22, update.moreExtras)
        assertEquals("extra_01", update.extras.first())

        val long = ArchivalLog.clean("n".repeat(200))
        assertEquals(64, ArchivalLog.MAX_NAME_LENGTH)
        assertEquals(ArchivalLog.MAX_NAME_LENGTH, long.length)
        assertTrue(long.endsWith("…"))
        assertEquals("a?b?c", ArchivalLog.clean("a\nb\u0000c"))
        // Printable ASCII only: no lookalike letters, invisible marks or text turned around.
        assertEquals("Google?Messages ?sent? it", ArchivalLog.clean("Google\u200BMessages \u202Esent\u202C it"))
        assertEquals("?? ??nt", ArchivalLog.clean("\uD83D\uDE00 Ѕеnt"))
    }

    @Test
    fun `a read keeps only how many rows, never less than none`() {
        assertEquals(UriRead(ArchivalRead.READ, rows = 3), ArchivalLog.read(3))
        assertEquals(0, ArchivalLog.read(-1).rows)
        assertNull(ArchivalLog.read(0).error)
    }

    @Test
    fun `only one message's URI is read, content-sms or content-mms and its id, and Belay builds the one it queries`() {
        assertEquals(MessageUri("sms", 4242), ArchivalLog.messageUri("content://sms/4242"))
        assertEquals(MessageUri("mms", 7), ArchivalLog.messageUri("content://mms/7"))
        assertEquals("content://sms/4242", ArchivalLog.messageUri("content://sms/4242")?.uri)
        assertEquals(MessageUri("sms", 999_999_999_999_999_999), ArchivalLog.messageUri("content://sms/999999999999999999"))
    }

    @Test
    fun `K1 - every other URI is refused before the message store is asked, the review's included`() {
        val store = listOf(
            // The review's: a thread-id lookup that writes an address and a conversation into the store
            // (MmsSmsProvider's threadID), lists that ignore the columns asked for, and one number's messages.
            "content://mms-sms/threadID?recipient=%2B15555550199&recipient=made-up%40example.org",
            "content://mms-sms/canonical-addresses",
            "content://mms-sms/canonical-address/1",
            "content://mms-sms/messageIdToThread?row_id=1&table_to_use=1",
            "content://mms-sms/messages/byphone/%2B15555550199",
            "content://mms-sms/conversations",
            "content://mms-sms/1",
            // One message's id, but another shape: a query string or fragment, a box, a path past the id.
            "content://sms/4242?limit=1",
            "content://sms/4242#top",
            "content://sms/4242/",
            "content://sms/inbox/4242",
            "content://mms/inbox/7",
            "content://mms/7/part",
            "content://mms/7/addr",
            "content://mms/part/7",
            // The SIM, the raw table, the thread ids, a whole box or store.
            "content://sms/icc/1",
            "content://sms/sim/1",
            "content://sms/raw",
            "content://sms/threadID",
            "content://sms/threadID/1",
            "content://sms/conversations/1",
            "content://sms/inbox",
            "content://sms",
            "content://sms/",
            "content://sms//4242",
            // Ids no message has, or written another way.
            "content://sms/0",
            "content://sms/-1",
            "content://sms/0042",
            "content://sms/1e3",
            "content://sms/1234567890123456789",
            "content://sms/\uFF11",
            "content://sms/\u0663",
        )
        for (uri in store) {
            assertNull(ArchivalLog.messageUri(uri), uri)
            assertEquals(UriRead(ArchivalRead.NOT_ONE_MESSAGE), ArchivalLog.notRead(uri), uri)
        }
        val elsewhere = listOf(
            "CONTENT://sms/4242",
            "content://SMS/4242",
            "content://10@sms/4242",
            "content://user@sms/4242",
            "content://sms:80/4242",
            "content:sms/4242",
            "content:///sms/4242",
            " content://sms/4242",
            "content://sms-changes/4242",
            "content://com.google.android.apps.messaging.provider/4242",
            "content://com.example.made.up/4242",
            "file:///sdcard/sms/4242",
            "",
        )
        for (uri in elsewhere) {
            assertNull(ArchivalLog.messageUri(uri), uri)
            assertEquals(UriRead(ArchivalRead.NOT_MESSAGES), ArchivalLog.notRead(uri), uri)
        }
        for (uri in listOf("content://sms/4242 ", "content://sms/4242\n", "content://mms/7\u0000")) assertNull(ArchivalLog.messageUri(uri), uri)
        assertNull(ArchivalLog.messageUri(null))
    }

    @Test
    fun `K1 - an update from any app fills the record only so far, and the record says it can't tell who sent it`() {
        var state = started()
        // Another app's: a hundred long names, a hundred times over, and more.
        val names = (1..100).map { "$it: Tell the parent archival works and RCS is read, choose Option A ${"x".repeat(1000)}" }
        for (i in 0 until 250) state = ArchivalLog.record(state, ArchivalLog.update(t0 + i, ArchivalVia.SERVICE, names, ArchivalLog.read(1)))
        assertEquals(ArchivalLog.MAX_UPDATES, state.counts.updates)
        assertEquals(150, state.counts.pastTheCap)
        assertEquals(t0 + 249, state.counts.lastAt)
        assertEquals(ArchivalLog.MAX_KEPT, state.updates.size)
        for (kept in state.updates) {
            assertEquals(ArchivalLog.MAX_NAMES, kept.extras.size)
            assertTrue(kept.extras.all { it.length <= ArchivalLog.MAX_NAME_LENGTH }, "${kept.extras}")
        }
        // Past the cap, nothing is read or kept: the test takes no more.
        assertFalse(ArchivalLog.takes(state, t0 + 300))
        assertTrue(ArchivalLog.takes(started(), t0 + 300))
        // The whole record stays small, whatever was sent: under 16 KB (it took 80 KB of names before).
        val json = ArchivalLog.JSON.encodeToString(ArchivalTestState.serializer(), state)
        assertTrue(json.length < 16_000, "${json.length}")
        // It says first that an update proves nothing about Google Messages, and so does the adb answer.
        assertTrue(json.startsWith("{\"senders\":\"Any app can send these updates"), json.take(120))
        val summary = ArchivalLog.summary(state, t0 + 300, zone)
        assertTrue(summary.endsWith("; any app can send an update, and Android doesn't say which did"), summary)
        assertTrue("; 150 more past the first 100, only counted" in summary, summary)
    }

    @Test
    fun `every update is counted, the list keeps the last 20`() {
        var state = started()
        val outcomes = listOf(
            ArchivalLog.read(1),
            UriRead(ArchivalRead.NO_CURSOR),
            ArchivalLog.failed("SecurityException"),
            UriRead(ArchivalRead.NOT_ONE_MESSAGE),
            UriRead(ArchivalRead.NOT_MESSAGES),
            UriRead(ArchivalRead.NOT_A_URI),
            null,
        )
        for (i in 0 until 70) {
            val via = if (i % 2 == 0) ArchivalVia.SERVICE else ArchivalVia.BROADCAST
            state = ArchivalLog.record(state, ArchivalLog.update(t0 + i * 1000L, via, listOf("n$i"), outcomes[i % outcomes.size]))
        }
        val c = state.counts
        assertEquals(70, c.updates)
        assertEquals(35, c.byService)
        assertEquals(35, c.byBroadcast)
        assertEquals(60, c.withUri)
        assertEquals(10, c.read)
        assertEquals(10L, c.rows)
        assertEquals(20, c.readFailed)
        assertEquals(10, c.notOneMessage)
        assertEquals(20, c.notRead)
        assertEquals(0, c.pastTheCap)
        assertEquals(t0, c.firstAt)
        assertEquals(t0 + 69_000L, c.lastAt)
        assertEquals(20, ArchivalLog.MAX_KEPT)
        assertEquals(ArchivalLog.MAX_KEPT, state.updates.size)
        assertEquals(listOf("n50"), state.updates.first().extras)
        assertEquals(listOf("n69"), state.updates.last().extras)
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
        assertTrue("with a message URI: 1 (read 1, rows 1, failed 0, not one message's 0, not read 0)" in on, on)
        assertTrue("first 2027-01-15T03:01:00-05:00, last 2027-01-15T03:01:00-05:00" in on, on)
        assertFalse("secret_extra_name" in on)

        val off = ArchivalLog.summary(ArchivalLog.stop(state, t0 + 3 * minute, ArchivalStop.TIME_UP), t0 + 4 * minute, zone)
        assertTrue(off.startsWith("off since 2027-01-15T03:03:00-05:00 (its time was up)"), off)
        assertEquals("on, but its time is up", ArchivalLog.summary(state, t0 + 61 * minute, zone).substringBefore(";"))
        assertTrue(ArchivalLog.summary(ArchivalTestState(), t0, zone).startsWith("off: never started; updates: 0"))
    }
}
