package family.brooker.belay.archival

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/*
 * Debug builds only: this directory is in src/debug, so release builds contain none of it (CI checks
 * the release APK's manifest and classes). Plain Kotlin with no Android classes, so :core's JVM tests
 * compile it too (android/core/build.gradle.kts); the Android side is ArchivalTest.kt, next to
 * DebugTools.kt.
 *
 * The archival test for the Pixel (docs/phase5-checklist.md, T8; docs/platform-notes.md T8): for a
 * time box, an hour by default, Belay names itself the archival app in Google Messages' managed
 * configuration, and Google Messages may then tell it of each message event (sent, received, edited,
 * deleted). For each update the test keeps only when it came, how (Belay's service or a broadcast),
 * the names of its extras and, when one names a message, whether reading it worked, its column
 * names and its row count. Never a value: no text, sender, recipient, thread, URI or anything else
 * from a message, and nothing about it is sent to the server.
 */

/** How an update reached Belay: the foreground service the docs describe, or a broadcast. */
@Serializable
enum class ArchivalVia {
    @SerialName("service")
    SERVICE,

    @SerialName("broadcast")
    BROADCAST,
}

/** What reading an update's message URI gave. */
@Serializable
enum class ArchivalRead {
    /** The phone's message store answered: [UriRead.columns] and [UriRead.rows]. */
    @SerialName("read")
    READ,

    /** The query returned no cursor (the provider refused it). */
    @SerialName("no_cursor")
    NO_CURSOR,

    /** The query threw; [UriRead.error] names the exception's class, never its message. */
    @SerialName("failed")
    FAILED,

    /** Not the phone's message store ([ArchivalLog.MESSAGE_STORES]): Belay doesn't read it. */
    @SerialName("not_messages")
    NOT_MESSAGES,

    /** The extra was there, but not a URI. */
    @SerialName("not_a_uri")
    NOT_A_URI,
}

/** An update's URI as the test keeps it: never the URI itself, and never a value from a row. */
@Serializable
data class UriRead(
    val outcome: ArchivalRead,
    val columns: List<String> = emptyList(),
    val rows: Int? = null,
    val error: String? = null,
)

/** One update from Google Messages. */
@Serializable
data class ArchivalUpdate(
    val at: Long,
    val via: ArchivalVia,
    /** The extras' names, sorted, at most [ArchivalLog.MAX_NAMES]; never their values. */
    val extras: List<String> = emptyList(),
    /** How many names there were past [ArchivalLog.MAX_NAMES]. */
    @SerialName("more_extras")
    val moreExtras: Int = 0,
    /** Null when no [ArchivalLog.EXTRA_URI] came. */
    val uri: UriRead? = null,
)

/** Every update since the test started, counted (the list keeps only the last ones). */
@Serializable
data class ArchivalCounts(
    val updates: Int = 0,
    @SerialName("by_service")
    val byService: Int = 0,
    @SerialName("by_broadcast")
    val byBroadcast: Int = 0,
    @SerialName("with_uri")
    val withUri: Int = 0,
    val read: Int = 0,
    val rows: Long = 0,
    /** [ArchivalRead.NO_CURSOR] or [ArchivalRead.FAILED]. */
    @SerialName("read_failed")
    val readFailed: Int = 0,
    /** [ArchivalRead.NOT_MESSAGES] or [ArchivalRead.NOT_A_URI]. */
    @SerialName("not_read")
    val notRead: Int = 0,
    @SerialName("first_at")
    val firstAt: Long? = null,
    @SerialName("last_at")
    val lastAt: Long? = null,
)

/** Why the test ended. */
@Serializable
enum class ArchivalStop {
    @SerialName("adb")
    ADB,

    @SerialName("time_up")
    TIME_UP,

    /** "Release this phone" (DebugTools.releasePhone). */
    @SerialName("released")
    RELEASED,

    /** It couldn't start (Google Messages' configuration was refused), and took back what it set. */
    @SerialName("start_failed")
    START_FAILED,
}

/** The test's whole state: Belay's only record of it (no_backup/debug-archival-test.json). */
@Serializable
data class ArchivalTestState(
    val on: Boolean = false,
    @SerialName("started_at")
    val startedAt: Long? = null,
    val until: Long? = null,
    @SerialName("stopped_at")
    val stoppedAt: Long? = null,
    @SerialName("stopped_because")
    val stoppedBecause: ArchivalStop? = null,
    val counts: ArchivalCounts = ArchivalCounts(),
    /** The last [ArchivalLog.MAX_KEPT] updates, oldest first. */
    val updates: List<ArchivalUpdate> = emptyList(),
)

object ArchivalLog {
    /** Google Messages (docs/platform-notes.md T8). */
    const val GOOGLE_MESSAGES = "com.google.android.apps.messaging"

    /** Its managed configuration's key: the archival app's package name, or empty for none. */
    const val KEY = "messages_archival"

    /** The action Google Messages sends the archival app on each message event. */
    const val ACTION = "GOOGLE_MESSAGES_ARCHIVAL_UPDATE"

    /** The extra that sometimes names the message the event was about. */
    const val EXTRA_URI = "com.google.android.apps.messaging.EXTRA_ARCHIVAL_URI"

    /** The Telephony provider's message stores (TelephonyProvider's manifest): the only URIs Belay reads. */
    val MESSAGE_STORES: Set<String> = setOf("sms", "mms", "mms-sms")

    const val DEFAULT_MINUTES = 60
    const val MAX_MINUTES = 120
    const val MAX_KEPT = 50
    const val MAX_NAMES = 20
    const val MAX_NAME_LENGTH = 80
    const val MAX_COLUMNS = 64
    const val MAX_COLUMN_LENGTH = 64
    const val MAX_ERROR_LENGTH = 60

    /** The state file's form: every field written, unknown ones ignored. */
    val JSON = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    /** The time box asked for over adb, from 1 to [MAX_MINUTES] minutes; [DEFAULT_MINUTES] when not asked. */
    fun minutes(asked: Int?): Int = (asked ?: DEFAULT_MINUTES).coerceIn(1, MAX_MINUTES)

    /**
     * A test from [now] for [minutes] (boxed by [minutes]). Started again while it's on, it keeps
     * its counts and ends [minutes] from now; after one has ended, a new one counts afresh.
     */
    fun start(state: ArchivalTestState, now: Long, minutes: Int): ArchivalTestState {
        val until = now + minutes(minutes) * MINUTE
        return if (isOn(state, now)) state.copy(until = until) else ArchivalTestState(on = true, startedAt = now, until = until)
    }

    /** Ended at [now] for [why]; what it counted stays, to read afterwards. Nothing if it wasn't on. */
    fun stop(state: ArchivalTestState, now: Long, why: ArchivalStop): ArchivalTestState =
        if (!state.on) state else state.copy(on = false, stoppedAt = now, stoppedBecause = why)

    /** On from its start until its end by the phone's clock: a clock set back before the start ends it too. */
    fun isOn(state: ArchivalTestState, now: Long): Boolean {
        val startedAt = state.startedAt ?: return false
        val until = state.until ?: return false
        return state.on && now >= startedAt && now < until
    }

    /** Still marked on, but its time is up: the next look turns it off. */
    fun expired(state: ArchivalTestState, now: Long): Boolean = state.on && !isOn(state, now)

    /** Whether Belay reads a URI with this authority: only the phone's message store. */
    fun readable(authority: String?): Boolean = authority in MESSAGE_STORES

    /**
     * A name another app chose, as the test keeps it: at most [max] characters, with control
     * characters as "?". It's only ever shown, never followed.
     */
    fun clean(name: String, max: Int = MAX_NAME_LENGTH): String {
        val shown = name.map { if (it.isISOControl() || it.isSurrogate()) '?' else it }.joinToString("")
        return if (shown.length <= max) shown else shown.take(max - 1) + "…"
    }

    /** A query's columns, as the test keeps them: at most [MAX_COLUMNS] names. */
    fun columns(names: List<String>?): List<String> = names.orEmpty().take(MAX_COLUMNS).map { clean(it, MAX_COLUMN_LENGTH) }

    /** The message store answered: its [columns] and how many [rows], never what's in them. */
    fun read(columns: List<String>?, rows: Int): UriRead = UriRead(ArchivalRead.READ, columns(columns), rows.coerceAtLeast(0))

    /** The query threw an exception of class [errorClass] (its message is never kept: it can hold the URI). */
    fun failed(errorClass: String?): UriRead = UriRead(ArchivalRead.FAILED, error = clean(errorClass ?: "?", MAX_ERROR_LENGTH))

    /**
     * One update as the test keeps it: when, how, the extras' [names] (the only part of the extras
     * the test ever takes) and what reading its URI gave, if one came.
     */
    fun update(at: Long, via: ArchivalVia, names: Collection<String?>, uri: UriRead?): ArchivalUpdate {
        val clean = names.filterNotNull().map { clean(it) }.distinct().sorted()
        return ArchivalUpdate(at, via, clean.take(MAX_NAMES), (clean.size - MAX_NAMES).coerceAtLeast(0), uri)
    }

    /** [update] counted, and kept among the last [MAX_KEPT], while the test is on; nothing otherwise. */
    fun record(state: ArchivalTestState, update: ArchivalUpdate): ArchivalTestState {
        if (!isOn(state, update.at)) return state
        val c = state.counts
        val outcome = update.uri?.outcome
        val counts = c.copy(
            updates = c.updates + 1,
            byService = c.byService + if (update.via == ArchivalVia.SERVICE) 1 else 0,
            byBroadcast = c.byBroadcast + if (update.via == ArchivalVia.BROADCAST) 1 else 0,
            withUri = c.withUri + if (update.uri != null) 1 else 0,
            read = c.read + if (outcome == ArchivalRead.READ) 1 else 0,
            rows = c.rows + (update.uri?.rows ?: 0),
            readFailed = c.readFailed + if (outcome == ArchivalRead.NO_CURSOR || outcome == ArchivalRead.FAILED) 1 else 0,
            notRead = c.notRead + if (outcome == ArchivalRead.NOT_MESSAGES || outcome == ArchivalRead.NOT_A_URI) 1 else 0,
            firstAt = c.firstAt ?: update.at,
            lastAt = update.at,
        )
        return state.copy(counts = counts, updates = (state.updates + update).takeLast(MAX_KEPT))
    }

    /** The test in one line, for the adb switch: whether it's on, until when, and the counts. Never a name. */
    fun summary(state: ArchivalTestState, now: Long, zone: ZoneId): String {
        val c = state.counts
        val stopped = state.stoppedAt
        val until = state.until
        val standing = when {
            isOn(state, now) && until != null -> "on until ${time(until, zone)} (${minutesLeft(until, now)} min left)"
            state.on -> "on, but its time is up"
            stopped != null -> "off since ${time(stopped, zone)} (${why(state.stoppedBecause)})"
            else -> "off: never started"
        }
        val counted = "updates: ${c.updates} (service ${c.byService}, broadcast ${c.byBroadcast}); " +
            "with a message URI: ${c.withUri} (read ${c.read}, rows ${c.rows}, failed ${c.readFailed}, not read ${c.notRead})"
        val times = c.firstAt?.let { first -> "; first ${time(first, zone)}, last ${time(c.lastAt ?: first, zone)}" }.orEmpty()
        return "$standing; $counted$times"
    }

    private fun why(stop: ArchivalStop?): String = when (stop) {
        ArchivalStop.ADB -> "stopped over adb"
        ArchivalStop.TIME_UP -> "its time was up"
        ArchivalStop.RELEASED -> "the phone was released"
        ArchivalStop.START_FAILED -> "it couldn't start"
        null -> "stopped"
    }

    /** The minutes until [until], rounded up. */
    private fun minutesLeft(until: Long, now: Long): Long = (until - now + MINUTE - 1) / MINUTE

    /** A moment in the phone's time zone, with its offset (CLAUDE.md, "Times"). */
    fun time(at: Long, zone: ZoneId): String =
        DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(OffsetDateTime.ofInstant(Instant.ofEpochMilli(at), zone).truncatedTo(ChronoUnit.SECONDS))

    private const val MINUTE = 60_000L
}
