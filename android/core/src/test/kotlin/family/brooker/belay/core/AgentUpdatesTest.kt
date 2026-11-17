package family.brooker.belay.core

import family.brooker.belay.core.AgentUpdates.failed
import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up hashes and certificates. */
class AgentUpdatesTest {
    private val sha = "ab".repeat(32)
    private val key = "c0".repeat(32)
    private val offer = WireAgentUpdate(versionCode = 4, versionName = "0.4.0", sha256 = sha, size = 12_345_678)
    private val belay = ApkFacts("family.brooker.belay", versionCode = 3, signers = setOf(key))
    private val good = belay.copy(versionCode = 4)
    private val download = DownloadFacts(sha, offer.size)
    private val minute = 60_000L

    private fun next(record: UpdateRecord?, running: Long = 3, now: Long = T0, offered: WireAgentUpdate? = offer) =
        AgentUpdates.next(offered, record, running, now)

    private fun started(now: Long = T0): UpdateRecord = assertIs<UpdateStep.Start>(next(null, now = now)).record

    // What to do about an offer.

    @Test
    fun `nothing offered, nothing to do or report`() {
        assertEquals(UpdateStep.Idle, next(null, offered = null))
        assertNull(AgentUpdates.report(null, started(), running = 3))
    }

    @Test
    fun `a new offer starts a download, and the report follows the record`() {
        val record = started()
        assertEquals(UpdateRecord(sha, 4, "0.4.0", WireUpdateState.DOWNLOADING, at = T0), record)
        assertEquals(WireAgentUpdateState(4, WireUpdateState.DOWNLOADING, null, T0), AgentUpdates.report(offer, record, running = 3))
        // Not reported until Belay has started on it.
        assertNull(AgentUpdates.report(offer, null, running = 3))
    }

    @Test
    fun `Belay is done once it runs the offered version or a newer one, whoever installed it`() {
        val done = assertIs<UpdateStep.Save>(next(null, running = 4)).record
        assertEquals(WireUpdateState.DONE, done.state)
        assertFalse(done.installed)
        assertFalse(AgentUpdates.justUpdated(null, done), "the kid isn't told about an update Belay didn't install")
        assertEquals(UpdateStep.Idle, next(done, running = 4))
        assertEquals(WireUpdateState.DONE, assertIs<UpdateStep.Save>(next(null, running = 9)).record.state)
    }

    @Test
    fun `after installing itself, the new Belay records done and tells the kid once`() {
        val installing = started().copy(state = WireUpdateState.INSTALLING, installed = true, at = T0 + minute)
        // Reported as done at once, before the record says so.
        assertEquals(WireUpdateState.DONE, AgentUpdates.report(offer, installing, running = 4)?.state)
        val done = assertIs<UpdateStep.Save>(next(installing, running = 4, now = T0 + 2 * minute)).record
        assertEquals(WireUpdateState.DONE, done.state)
        assertTrue(done.installed)
        assertEquals(T0 + 2 * minute, done.at)
        assertTrue(AgentUpdates.justUpdated(installing, done))
        assertFalse(AgentUpdates.justUpdated(done, done))
        assertEquals(WireAgentUpdateState(4, WireUpdateState.DONE, null, T0 + 2 * minute), AgentUpdates.report(offer, done, running = 4))
    }

    @Test
    fun `a failure waits, doubling, and never loops`() {
        val first = started().failed("The server answered HTTP 503 for the update.", T0)
        assertEquals(WireUpdateState.FAILED, first.state)
        assertEquals(1, first.failures)
        assertEquals(T0 + minute, first.retryAt)
        assertEquals(UpdateStep.Later(T0 + minute), next(first, now = T0 + 30_000))
        val retry = assertIs<UpdateStep.Start>(next(first, now = T0 + minute)).record
        assertEquals(WireUpdateState.DOWNLOADING, retry.state)
        assertEquals(1, retry.failures, "failures in a row are kept until it works")
        assertNull(retry.problem)

        val second = retry.failed("again", T0 + minute)
        assertEquals(T0 + 3 * minute, second.retryAt)
        assertEquals(listOf(1L, 2, 4, 8, 16, 32, 64, 128, 256, 360, 360).map { it * minute }, (1..11).map { AgentUpdates.retryWaitMs(it) })
        assertEquals(10 * minute, AgentUpdates.retryWaitMs(1, retryAfterMs = 10 * minute), "the server's Retry-After counts")
    }

    @Test
    fun `a retry time beyond any wait means the clock went back, so it goes now`() {
        val failed = started().failed("again", T0)
        assertIs<UpdateStep.Start>(next(failed, now = T0 - 7 * HOUR))
    }

    @Test
    fun `a final refusal is never tried again, until a new offer`() {
        val refused = started().failed("The update isn't signed.", T0, final = true)
        assertNull(refused.retryAt)
        assertEquals(UpdateStep.Idle, next(refused, now = T0 + 100 * HOUR))
        val newer = offer.copy(versionCode = 5, sha256 = "cd".repeat(32))
        val fresh = assertIs<UpdateStep.Start>(next(refused, offered = newer)).record
        assertEquals(0, fresh.failures)
        assertEquals(newer.sha256, fresh.sha256)
    }

    @Test
    fun `an install Android never finished is a failure after ten minutes`() {
        val installing = started().copy(state = WireUpdateState.INSTALLING, installed = true, at = T0)
        assertEquals(UpdateStep.Later(T0 + AgentUpdates.INSTALL_TIMEOUT_MS), next(installing, now = T0 + minute))
        val failed = assertIs<UpdateStep.Save>(next(installing, now = T0 + AgentUpdates.INSTALL_TIMEOUT_MS)).record
        assertEquals(WireUpdateState.FAILED, failed.state)
        assertEquals(AgentUpdates.INSTALL_TIMED_OUT, failed.problem)
        assertFalse(failed.final)
        // The clock went back past it: a failure too, so it can't wait forever.
        assertIs<UpdateStep.Save>(next(installing, now = T0 - HOUR))
    }

    @Test
    fun `an interrupted download or check goes on after a restart`() {
        val checking = started().copy(state = WireUpdateState.CHECKING, at = T0)
        assertEquals(WireUpdateState.DOWNLOADING, assertIs<UpdateStep.Start>(next(checking, now = T0 + minute)).record.state)
    }

    @Test
    fun `a version an older Belay was put over isn't installed again`() {
        val done = started().copy(state = WireUpdateState.DONE, installed = true)
        val refused = assertIs<UpdateStep.Save>(next(done, running = 3)).record
        assertEquals(WireUpdateState.FAILED, refused.state)
        assertTrue(refused.final)
        assertTrue("older Belay" in refused.problem!!)
        assertEquals(UpdateStep.Idle, next(refused, running = 3))
    }

    @Test
    fun `an offer that can't be right is refused before downloading`() {
        for (bad in listOf(offer.copy(sha256 = "not hex"), offer.copy(sha256 = sha.uppercase()), offer.copy(size = 0), offer.copy(size = WireLimits.MAX_AGENT_BYTES + 1))) {
            val record = assertIs<UpdateStep.Save>(next(null, offered = bad)).record
            assertEquals(WireUpdateState.FAILED, record.state, "$bad")
            assertTrue(record.final)
        }
        assertEquals("The update is larger than the 100 MB Belay accepts.", assertIs<UpdateStep.Save>(next(null, offered = offer.copy(size = 200L shl 20))).record.problem)
    }

    @Test
    fun `problems are capped for the server`() {
        assertEquals(WireLimits.MAX_PROBLEM, started().failed("x".repeat(500), T0).problem!!.length)
        assertEquals("Android said: INSTALL_FAILED_TEST_ONLY: Failed to install test-only apk. Did you forget to add -t?", AgentUpdates.androidSaid("INSTALL_FAILED_TEST_ONLY: Failed to install test-only apk. Did you forget to add -t?", 4))
        assertEquals("Android said: status 1", AgentUpdates.androidSaid(null, 1))
        assertEquals(WireLimits.MAX_PROBLEM, AgentUpdates.androidSaid("y".repeat(400), 1).length)
    }

    // The checks before installing.

    @Test
    fun `the offered file, Belay itself, newer and with the same key, is installed`() {
        assertEquals(UpdateCheck.Ok, AgentUpdates.check(offer, download, good, belay))
        assertEquals(UpdateCheck.Ok, AgentUpdates.check(offer, download.copy(sha256 = sha.uppercase()), good, belay))
    }

    @Test
    fun `a download that isn't the offered file is fetched again`() {
        val short = AgentUpdates.check(offer, download.copy(size = 10), good, belay)
        assertEquals(UpdateCheck.Refused("The downloaded update has 10 bytes, not the 12345678 the server offered.", final = false), short)
        val other = assertIs<UpdateCheck.Refused>(AgentUpdates.check(offer, download.copy(sha256 = "ef".repeat(32)), good, belay))
        assertFalse(other.final)
    }

    @Test
    fun `anything but Belay, the offered version, newer, with the same key is refused for good`() {
        val refusals = mapOf(
            null to "Android can't read the downloaded update as an app.",
            good.copy(packageName = "com.example.game") to "The update is the app com.example.game, not Belay.",
            good.copy(versionCode = 5) to "The update is version 5, not the version 4 the server offered.",
            good.copy(signers = emptySet()) to "The update isn't signed.",
            good.copy(signers = setOf("d1".repeat(32))) to "The update isn't signed with the same key as this Belay, so Belay won't install it.",
            good.copy(signers = setOf(key, "d1".repeat(32))) to "The update isn't signed with the same key as this Belay, so Belay won't install it.",
        )
        for ((archive, words) in refusals) {
            assertEquals(UpdateCheck.Refused(words, final = true), AgentUpdates.check(offer, download, archive, belay), "$archive")
        }
        val notNewer = AgentUpdates.check(offer, download, good, belay.copy(versionCode = 4))
        assertEquals(UpdateCheck.Refused("The update is version 4, which isn't newer than the version 4 Belay runs.", final = true), notNewer)
    }

    @Test
    fun `Android's refusals that would come again stop the retries`() {
        assertTrue(AgentUpdates.installFailureIsFinal(AgentUpdates.STATUS_FAILURE_INVALID))
        assertTrue(AgentUpdates.installFailureIsFinal(AgentUpdates.STATUS_FAILURE_CONFLICT))
        assertTrue(AgentUpdates.installFailureIsFinal(AgentUpdates.STATUS_FAILURE_INCOMPATIBLE))
        assertFalse(AgentUpdates.installFailureIsFinal(AgentUpdates.STATUS_FAILURE_BLOCKED), "a verifier may say yes later")
        assertFalse(AgentUpdates.installFailureIsFinal(1))
        assertFalse(AgentUpdates.installFailureIsFinal(6))
    }

    // Resuming a download.

    @Test
    fun `a resumed download appends the rest, or starts over`() {
        val size = 1000L
        assertEquals(DownloadRules.Plan.FromStart, DownloadRules.plan(0, 200, null, size))
        assertEquals(DownloadRules.Plan.FromStart, DownloadRules.plan(400, 200, null, size), "a server that ignores Range sends it all")
        assertEquals(DownloadRules.Plan.Append, DownloadRules.plan(400, 206, "bytes 400-999/1000", size))
        assertEquals(DownloadRules.Plan.Append, DownloadRules.plan(400, 206, "bytes 400-999/*", size))
        assertIs<DownloadRules.Plan.Discard>(DownloadRules.plan(400, 206, "bytes 0-999/1000", size))
        assertIs<DownloadRules.Plan.Discard>(DownloadRules.plan(400, 206, "bytes 400-999/2000", size))
        assertIs<DownloadRules.Plan.Discard>(DownloadRules.plan(400, 206, null, size))
        assertEquals(DownloadRules.Plan.Complete, DownloadRules.plan(size, 416, "bytes */1000", size))
        assertIs<DownloadRules.Plan.Discard>(DownloadRules.plan(400, 416, "bytes */1000", size))
        assertEquals(DownloadRules.Plan.Fail("The server answered HTTP 404 for the update."), DownloadRules.plan(0, 404, null, size))
    }
}
