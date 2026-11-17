package family.brooker.belay.core

import kotlinx.serialization.Serializable

/*
 * Phase 6: Belay updates itself (docs/protocol.md, "Updates"). The policy's agent_update names
 * an APK a parent approved; the phone downloads it, checks it here, and installs it with a
 * PackageInstaller session as device owner. Everything here is pure: :app reads the facts (the
 * download's hash, what PackageManager says about the APK and about Belay itself) and carries
 * out what [AgentUpdates.next] says, on its own thread.
 */

/** What an APK says about itself (getPackageArchiveInfo with GET_SIGNING_CERTIFICATES), or Belay's own PackageInfo. */
data class ApkFacts(
    val packageName: String,
    val versionCode: Long,
    /** SHA-256 of each certificate the APK's contents are signed with now (SigningInfo.getApkContentsSigners), lowercase hex. */
    val signers: Set<String>,
)

/** The downloaded file, as Belay hashed it while writing it. */
data class DownloadFacts(val sha256: String, val size: Long)

/**
 * How the offered update is going. Kept across the restart an update causes (Android kills
 * the old Belay to install the new one), so the new Belay knows it was its own doing.
 */
@Serializable
data class UpdateRecord(
    /** The offer this is about: its SHA-256, which also names the file. */
    val sha256: String,
    val versionCode: Long,
    val versionName: String? = null,
    val state: WireUpdateState,
    /** Belay's own words, or Android's status message word for word. */
    val problem: String? = null,
    /** When [state] began. */
    val at: Long,
    /** Failed tries in a row, for the wait before the next one. */
    val failures: Int = 0,
    /** After a failure: the next try is due then. */
    val retryAt: Long? = null,
    /** Not tried again: the same file would fail the same way. A new offer starts over. */
    val final: Boolean = false,
    /** Belay handed this APK to Android's installer, so "done" was Belay's doing (the kid is told). */
    val installed: Boolean = false,
)

/** What the update thread does next. */
sealed interface UpdateStep {
    data object Idle : UpdateStep

    /** Write [record] (a new state: done, refused, timed out) and nothing else. */
    data class Save(val record: UpdateRecord) : UpdateStep

    /** Write [record] (downloading), then download (resuming), check and install. */
    data class Start(val record: UpdateRecord) : UpdateStep

    /** Nothing until then: a retry, or the wait for Android's installer. */
    data class Later(val at: Long) : UpdateStep
}

sealed interface UpdateCheck {
    data object Ok : UpdateCheck

    /** [final]: the same file would fail again, so it isn't tried again; otherwise it is downloaded again. */
    data class Refused(val problem: String, val final: Boolean) : UpdateCheck
}

object AgentUpdates {
    /** After the first failure the next try waits a minute, doubling up to this. */
    const val FIRST_RETRY_MS = 60_000L
    const val MAX_RETRY_MS = 6L * 60 * 60 * 1000

    /** Android's installer has this long to install (and restart Belay) before Belay calls it a failure. */
    const val INSTALL_TIMEOUT_MS = 10L * 60 * 1000

    // PackageInstaller's public status codes (Android's own values; :core has no Android classes).
    const val STATUS_FAILURE_BLOCKED = 2
    const val STATUS_FAILURE_INVALID = 4
    const val STATUS_FAILURE_CONFLICT = 5
    const val STATUS_FAILURE_INCOMPATIBLE = 7

    /**
     * What to do about [offer], given Belay's [record] and the version code Belay runs
     * ([running]). Belay is done once it runs the offered version or a newer one, whoever
     * installed it. Otherwise it downloads and installs, waits after failures (never in a loop),
     * gives up on a file that can't pass the checks, and never installs again a version an older
     * Belay was put over (a parent's adb, in maintenance mode).
     */
    fun next(offer: WireAgentUpdate?, record: UpdateRecord?, running: Long, now: Long): UpdateStep {
        if (offer == null) return UpdateStep.Idle
        val mine = record?.takeIf { it.sha256 == offer.sha256 }
        if (running >= offer.versionCode) {
            if (mine?.state == WireUpdateState.DONE) return UpdateStep.Idle
            val base = mine ?: fresh(offer, now)
            return UpdateStep.Save(base.copy(state = WireUpdateState.DONE, problem = null, at = now, retryAt = null, failures = 0, final = false))
        }
        if (mine == null) {
            invalid(offer)?.let { return UpdateStep.Save(fresh(offer, now).failed(it, now, final = true)) }
            return UpdateStep.Start(fresh(offer, now))
        }
        return when (mine.state) {
            WireUpdateState.DONE -> UpdateStep.Save(mine.failed(olderPutBack(offer.versionCode), now, final = true))
            WireUpdateState.FAILED -> when {
                mine.final -> UpdateStep.Idle
                // A retry time further away than any wait means the clock went back: go now.
                mine.retryAt == null || now >= mine.retryAt || mine.retryAt - now > MAX_RETRY_MS -> UpdateStep.Start(restart(mine, now))
                else -> UpdateStep.Later(mine.retryAt)
            }
            // Interrupted (Belay restarted mid-way): go on where the file left off.
            WireUpdateState.DOWNLOADING, WireUpdateState.CHECKING -> UpdateStep.Start(restart(mine, now))
            WireUpdateState.INSTALLING ->
                if (now - mine.at in 0 until INSTALL_TIMEOUT_MS) {
                    UpdateStep.Later(mine.at + INSTALL_TIMEOUT_MS)
                } else {
                    UpdateStep.Save(mine.failed(INSTALL_TIMED_OUT, now))
                }
        }
    }

    /**
     * The checks before installing (docs/protocol.md, "Updates"): the download is exactly the
     * offered file, and the APK in it is Belay, with exactly the offered version code, newer than
     * the one running, signed with exactly the certificates Belay runs with. [archive] is null
     * when Android couldn't read the file as an app.
     */
    fun check(offer: WireAgentUpdate, download: DownloadFacts, archive: ApkFacts?, running: ApkFacts): UpdateCheck {
        if (download.size != offer.size) {
            return UpdateCheck.Refused("The downloaded update has ${download.size} bytes, not the ${offer.size} the server offered.", final = false)
        }
        if (download.sha256.lowercase() != offer.sha256.lowercase()) {
            return UpdateCheck.Refused("The downloaded update doesn't match the SHA-256 the server offered.", final = false)
        }
        if (archive == null) return UpdateCheck.Refused("Android can't read the downloaded update as an app.", final = true)
        if (archive.packageName != running.packageName) {
            return UpdateCheck.Refused("The update is the app ${archive.packageName.take(MAX_NAME)}, not Belay.", final = true)
        }
        if (archive.versionCode != offer.versionCode) {
            return UpdateCheck.Refused(
                "The update is version ${archive.versionCode}, not the version ${offer.versionCode} the server offered.",
                final = true,
            )
        }
        if (archive.versionCode <= running.versionCode) {
            return UpdateCheck.Refused(
                "The update is version ${archive.versionCode}, which isn't newer than the version ${running.versionCode} Belay runs.",
                final = true,
            )
        }
        if (archive.signers.isEmpty()) return UpdateCheck.Refused("The update isn't signed.", final = true)
        if (archive.signers != running.signers) {
            return UpdateCheck.Refused("The update isn't signed with the same key as this Belay, so Belay won't install it.", final = true)
        }
        return UpdateCheck.Ok
    }

    /**
     * Whether Android's refusal (a PackageInstaller status) would come again for the same file:
     * an invalid, conflicting or incompatible APK. Others (storage, a timeout, a verifier's
     * block, an aborted session) are tried again after a wait.
     */
    fun installFailureIsFinal(status: Int): Boolean =
        status == STATUS_FAILURE_INVALID || status == STATUS_FAILURE_CONFLICT || status == STATUS_FAILURE_INCOMPATIBLE

    /** Android's refusal, word for word, as the problem the parent sees. */
    fun androidSaid(message: String?, status: Int): String = "Android said: ${message?.takeIf { it.isNotBlank() } ?: "status $status"}".take(WireLimits.MAX_PROBLEM)

    /** The enforcement report's agent_update: null when nothing is offered, or Belay hasn't started on it. */
    fun report(offer: WireAgentUpdate?, record: UpdateRecord?, running: Long): WireAgentUpdateState? {
        if (offer == null) return null
        val mine = record?.takeIf { it.sha256 == offer.sha256 } ?: return null
        // Done once Belay runs that version or a newer one, even before the record says so.
        if (running >= offer.versionCode) return WireAgentUpdateState(offer.versionCode, WireUpdateState.DONE, null, mine.at)
        return WireAgentUpdateState(offer.versionCode, mine.state, mine.problem, mine.at)
    }

    /** Whether going from [before] to [after] finished an update Belay installed (the kid is told). */
    fun justUpdated(before: UpdateRecord?, after: UpdateRecord): Boolean =
        after.state == WireUpdateState.DONE && after.installed &&
            !(before?.sha256 == after.sha256 && before.state == WireUpdateState.DONE)

    /** The wait after the [failures]-th failure in a row, never sooner than the server's Retry-After. */
    fun retryWaitMs(failures: Int, retryAfterMs: Long? = null): Long {
        val doublings = (failures.coerceAtLeast(1) - 1).coerceAtMost(20)
        return maxOf(retryAfterMs ?: 0, (FIRST_RETRY_MS shl doublings).coerceAtMost(MAX_RETRY_MS))
    }

    /** [this] failed with [problem]: a retry after the backoff, or never again ([final]). */
    fun UpdateRecord.failed(problem: String, now: Long, final: Boolean = false, retryAfterMs: Long? = null): UpdateRecord {
        val failures = failures + 1
        return copy(
            state = WireUpdateState.FAILED,
            problem = problem.take(WireLimits.MAX_PROBLEM),
            at = now,
            failures = failures,
            retryAt = if (final) null else now + retryWaitMs(failures, retryAfterMs),
            final = final,
        )
    }

    /** What's wrong with the offer itself, before downloading anything. */
    private fun invalid(offer: WireAgentUpdate): String? = when {
        !SHA256.matches(offer.sha256) -> "The server's offer has no valid SHA-256."
        offer.size <= 0 -> "The server's offer has no valid size."
        offer.size > WireLimits.MAX_AGENT_BYTES -> "The update is larger than the ${WireLimits.MAX_AGENT_BYTES / (1024 * 1024)} MB Belay accepts."
        else -> null
    }

    private fun fresh(offer: WireAgentUpdate, now: Long) = UpdateRecord(
        sha256 = offer.sha256,
        versionCode = offer.versionCode,
        versionName = offer.versionName?.take(MAX_NAME),
        state = WireUpdateState.DOWNLOADING,
        at = now,
    )

    private fun restart(record: UpdateRecord, now: Long) =
        record.copy(state = WireUpdateState.DOWNLOADING, problem = null, at = now, retryAt = null)

    private fun olderPutBack(versionCode: Long) =
        "An older Belay was installed over version $versionCode, so Belay won't install that version again by itself."

    const val INSTALL_TIMED_OUT = "Android didn't finish installing the update within 10 minutes."

    private const val MAX_NAME = 100
    private val SHA256 = Regex("^[0-9a-f]{64}$")
}

/**
 * The download resumes after a failure: Belay asks for the bytes from the ones it has on
 * (`Range: bytes=<have>-`), and the server answers 206 with the rest, or 200 with the whole
 * file (docs/protocol.md, `GET /api/v1/agent/<sha256>.apk`).
 */
object DownloadRules {
    sealed interface Plan {
        /** Write the body after the bytes already on disk. */
        data object Append : Plan

        /** The body is the whole file: start the file over. */
        data object FromStart : Plan

        /** The file on disk is already complete. */
        data object Complete : Plan

        /** The part on disk is no good: delete it, and start over next time. */
        data class Discard(val problem: String) : Plan

        data class Fail(val problem: String) : Plan
    }

    private val CONTENT_RANGE = Regex("""^bytes (\d+)-(\d+)/(\d+|\*)$""")

    /** For an answer with [status] and its Content-Range, to a request for the bytes from [have] of a [size]-byte file. */
    fun plan(have: Long, status: Int, contentRange: String?, size: Long): Plan = when (status) {
        200 -> Plan.FromStart
        206 -> {
            val match = contentRange?.trim()?.let(CONTENT_RANGE::matchEntire)
            val start = match?.groupValues?.get(1)?.toLongOrNull()
            val end = match?.groupValues?.get(2)?.toLongOrNull()
            val total = match?.groupValues?.get(3)
            if (start == have && end != null && end in start until size && (total == "*" || total?.toLongOrNull() == size)) {
                Plan.Append
            } else {
                Plan.Discard("The server sent the wrong part of the update.")
            }
        }
        416 -> if (have == size) Plan.Complete else Plan.Discard("The server couldn't send the rest of the update.")
        else -> Plan.Fail("The server answered HTTP $status for the update.")
    }
}
