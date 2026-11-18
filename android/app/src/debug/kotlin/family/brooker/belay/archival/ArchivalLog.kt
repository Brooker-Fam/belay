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
 * the names of its extras and, when one names a message, whether reading it worked and how many rows
 * it has: only the rows' ids are read, to count them. Never a value: no text, sender, recipient,
 * thread, URI or anything else from a message, and nothing about it is sent to the server.
 *
 * Any app can send an update (WRITE_SMS keeps none out: docs/platform-notes.md T8), and Android
 * doesn't tell Belay which app sent one, so an update proves nothing about Google Messages, and the
 * record says so ([ArchivalTestState.senders]). What one can do is bounded (the eighth review's K1):
 * Belay reads only one message's URI, of the one shape [ArchivalLog.messageUri] takes, through a URI
 * it builds itself; and an update keeps at most [ArchivalLog.MAX_NAMES] names of
 * [ArchivalLog.MAX_NAME_LENGTH] printable ASCII characters, the record the last
 * [ArchivalLog.MAX_KEPT] updates, and after [ArchivalLog.MAX_UPDATES] a test only counts them.
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
    /** The phone's message store answered: [UriRead.rows] (counted from the rows' ids alone). */
    @SerialName("read")
    READ,

    /** The query returned no cursor (the provider refused it). */
    @SerialName("no_cursor")
    NO_CURSOR,

    /** The query threw; [UriRead.error] names the exception's class, never its message. */
    @SerialName("failed")
    FAILED,

    /**
     * In the phone's message store ([ArchivalLog.MESSAGE_STORES]), but not one message's URI
     * ([ArchivalLog.messageUri]): refused, without asking the store anything.
     */
    @SerialName("not_one_message")
    NOT_ONE_MESSAGE,

    /** Not the phone's message store ([ArchivalLog.MESSAGE_STORES]): Belay doesn't read it. */
    @SerialName("not_messages")
    NOT_MESSAGES,

    /** The extra was there, but not a URI. */
    @SerialName("not_a_uri")
    NOT_A_URI,
}

/**
 * An update's URI as the test keeps it: what reading it gave and, when it was read, how many rows it
 * has. Never the URI itself, and nothing from a row: Belay asks only for the rows' ids, to count them.
 */
@Serializable
data class UriRead(
    val outcome: ArchivalRead,
    val rows: Int? = null,
    val error: String? = null,
)

/**
 * A message the test reads: the row [id] of the phone's [store] ("sms" or "mms"), as
 * [ArchivalLog.messageUri] found it in an update.
 */
data class MessageUri(val store: String, val id: Long) {
    /** The URI Belay queries, built from [store] and [id] alone. */
    val uri: String get() = "content://$store/$id"
}

/** One update, from Google Messages or any other app ([ArchivalLog.SENDERS]). */
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
    /** [ArchivalRead.NOT_ONE_MESSAGE]: refused. */
    @SerialName("not_one_message")
    val notOneMessage: Int = 0,
    /** [ArchivalRead.NOT_MESSAGES] or [ArchivalRead.NOT_A_URI]. */
    @SerialName("not_read")
    val notRead: Int = 0,
    /** Updates past [ArchivalLog.MAX_UPDATES]: counted here alone, nothing in them read or kept. */
    @SerialName("past_the_cap")
    val pastTheCap: Int = 0,
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
    /** What every reader of the record needs first: an update proves nothing about who sent it. */
    val senders: String = ArchivalLog.SENDERS,
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

    /** The Telephony provider's message stores (TelephonyProvider's manifest). */
    val MESSAGE_STORES: Set<String> = setOf("sms", "mms", "mms-sms")

    /** The record's first words (the eighth review's K1): it can't prove who sent an update. */
    const val SENDERS =
        "Any app can send these updates: WRITE_SMS keeps no app out, and Android doesn't tell Belay which app sent one, so none of them proves that Google Messages sent it."

    const val DEFAULT_MINUTES = 60
    const val MAX_MINUTES = 120
    const val MAX_KEPT = 20
    const val MAX_NAMES = 8
    const val MAX_NAME_LENGTH = 64
    const val MAX_ERROR_LENGTH = 60

    /** A test reads and keeps this many updates at most; it only counts the rest ([ArchivalCounts.pastTheCap]). */
    const val MAX_UPDATES = 100

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

    /**
     * The one shape of URI the test reads (the eighth review's K1): one message's, `content://sms/<id>`
     * or `content://mms/<id>`, exactly: the URI AOSP 17's SmsProvider and MmsProvider give a message they
     * store (`insert`), whose query reads that one row by its id, for the columns asked for (SMS_ALL_ID,
     * MMS_ALL_ID). Anything else is refused before the store is asked: no query string, fragment, user,
     * port or other path. The same authorities answer URIs that write to the store (MmsSmsProvider's
     * `threadID` adds an address and an empty conversation for a recipient it doesn't know), that ignore
     * the columns asked for (canonical addresses, conversations), that read the SIM (`sms/icc`), or that
     * act on a query string. Belay then queries a URI it builds from [MessageUri.store] and
     * [MessageUri.id] alone, never the one it was sent ([MessageUri.uri]).
     */
    fun messageUri(uri: String?): MessageUri? {
        val match = MESSAGE_URI.matchEntire(uri ?: return null) ?: return null
        return MessageUri(match.groupValues[1], match.groupValues[2].toLong())
    }

    /** Why a URI that isn't one message's ([messageUri]) wasn't read: in the phone's message store, or not. */
    fun notRead(uri: String): UriRead = UriRead(if (IN_A_STORE.containsMatchIn(uri)) ArchivalRead.NOT_ONE_MESSAGE else ArchivalRead.NOT_MESSAGES)

    /** Whether the test still reads and keeps an update: on, and fewer than [MAX_UPDATES] so far. */
    fun takes(state: ArchivalTestState, at: Long): Boolean = isOn(state, at) && state.counts.updates < MAX_UPDATES

    private val MESSAGE_URI = Regex("content://(sms|mms)/([1-9][0-9]{0,17})")
    private val IN_A_STORE = Regex("^content://(" + MESSAGE_STORES.joinToString("|") { Regex.escape(it) } + ")([/?#]|$)")

    /**
     * A name another app chose, as the test keeps it: at most [max] characters (the last a "…" where
     * it's cut), printable ASCII, with anything else as "?", so it can't look like other words or
     * reorder a line. It's only ever shown, never followed.
     */
    fun clean(name: String, max: Int = MAX_NAME_LENGTH): String {
        val shown = name.map { if (it in ' '..'~') it else '?' }.joinToString("")
        return if (shown.length <= max) shown else shown.take(max - 1) + "…"
    }

    /** The message store answered with [rows] rows, counted from their ids alone. */
    fun read(rows: Int): UriRead = UriRead(ArchivalRead.READ, rows.coerceAtLeast(0))

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

    /**
     * [update] counted, and kept among the last [MAX_KEPT], while the test is on; past [MAX_UPDATES],
     * only counted ([ArchivalCounts.pastTheCap]); nothing while it's off.
     */
    fun record(state: ArchivalTestState, update: ArchivalUpdate): ArchivalTestState {
        if (!isOn(state, update.at)) return state
        val c = state.counts
        if (!takes(state, update.at)) return state.copy(counts = c.copy(pastTheCap = c.pastTheCap + 1, lastAt = update.at))
        val outcome = update.uri?.outcome
        val counts = c.copy(
            updates = c.updates + 1,
            byService = c.byService + if (update.via == ArchivalVia.SERVICE) 1 else 0,
            byBroadcast = c.byBroadcast + if (update.via == ArchivalVia.BROADCAST) 1 else 0,
            withUri = c.withUri + if (update.uri != null) 1 else 0,
            read = c.read + if (outcome == ArchivalRead.READ) 1 else 0,
            rows = c.rows + (update.uri?.rows ?: 0),
            readFailed = c.readFailed + if (outcome == ArchivalRead.NO_CURSOR || outcome == ArchivalRead.FAILED) 1 else 0,
            notOneMessage = c.notOneMessage + if (outcome == ArchivalRead.NOT_ONE_MESSAGE) 1 else 0,
            notRead = c.notRead + if (outcome == ArchivalRead.NOT_MESSAGES || outcome == ArchivalRead.NOT_A_URI) 1 else 0,
            firstAt = c.firstAt ?: update.at,
            lastAt = update.at,
        )
        return state.copy(counts = counts, updates = (state.updates + update).takeLast(MAX_KEPT))
    }

    /**
     * The test in one line, for the adb switch: whether it's on, until when, and the counts, ending with
     * the record's own caveat ([SENDERS]). Never a name.
     */
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
            "with a message URI: ${c.withUri} (read ${c.read}, rows ${c.rows}, failed ${c.readFailed}, not one message's ${c.notOneMessage}, not read ${c.notRead})" +
            if (c.pastTheCap > 0) "; ${c.pastTheCap} more past the first $MAX_UPDATES, only counted" else ""
        val times = c.firstAt?.let { first -> "; first ${time(first, zone)}, last ${time(c.lastAt ?: first, zone)}" }.orEmpty()
        return "$standing; $counted$times; any app can send an update, and Android doesn't say which did"
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
