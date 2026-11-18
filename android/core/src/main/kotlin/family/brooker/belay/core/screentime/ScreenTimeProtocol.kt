package family.brooker.belay.core.screentime

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.DayOfWeek

// Phase 3's part of the device API (docs/protocol.md), with core/Protocol.kt's conventions:
// snake_case names, and every policy field defaults to enforcing and collecting nothing.
// Protocol.kt's WirePolicy, WireEnforcement, WireRequest and WireCommand carry these types, and
// the server's Zod schemas (server/src/device/schemas.ts) mirror them. Where the design was open,
// the KDoc says "Decision:".

/** A day of the week as the policy writes it. */
@Serializable
enum class WireDay(val dayOfWeek: DayOfWeek) {
    @SerialName("mon") MON(DayOfWeek.MONDAY),
    @SerialName("tue") TUE(DayOfWeek.TUESDAY),
    @SerialName("wed") WED(DayOfWeek.WEDNESDAY),
    @SerialName("thu") THU(DayOfWeek.THURSDAY),
    @SerialName("fri") FRI(DayOfWeek.FRIDAY),
    @SerialName("sat") SAT(DayOfWeek.SATURDAY),
    @SerialName("sun") SUN(DayOfWeek.SUNDAY),
    ;

    companion object {
        fun of(day: DayOfWeek): WireDay = entries[day.value - 1]
    }
}

/** Minutes for some days of the week, overriding a limit's `minutes` on those days. */
@Serializable
data class WireByDay(
    val mon: Int? = null,
    val tue: Int? = null,
    val wed: Int? = null,
    val thu: Int? = null,
    val fri: Int? = null,
    val sat: Int? = null,
    val sun: Int? = null,
) {
    operator fun get(day: DayOfWeek): Int? = when (day) {
        DayOfWeek.MONDAY -> mon
        DayOfWeek.TUESDAY -> tue
        DayOfWeek.WEDNESDAY -> wed
        DayOfWeek.THURSDAY -> thu
        DayOfWeek.FRIDAY -> fri
        DayOfWeek.SATURDAY -> sat
        DayOfWeek.SUNDAY -> sun
    }
}

/** A daily time limit that one app, or several apps together, share. */
@Serializable
data class WireLimit(
    val id: String,
    /** The family's words ("Games"), at most 60 characters: untrusted for AI. */
    val name: String,
    /** The apps sharing the limit; ["*"]: every app that isn't exempt (a daily total). */
    val packages: List<String> = emptyList(),
    /** Per day, 0 to 1440. 0 means the apps can't be used that day. */
    val minutes: Int,
    @SerialName("by_day") val byDay: WireByDay? = null,
) {
    companion object {
        const val EVERY_APP = "*"
    }
}

@Serializable
enum class WireScheduleKind {
    @SerialName("school") SCHOOL,
    @SerialName("bedtime") BEDTIME,
    @SerialName("custom") CUSTOM,
}

/**
 * A time when apps are paused, on some days of the week. Decision: [end] at or before [start] ends
 * the next day, so equal times are a whole day. [days] and [skip] name the day each time starts.
 */
@Serializable
data class WireSchedule(
    val id: String,
    val kind: WireScheduleKind,
    /** The family's words: untrusted for AI. */
    val name: String,
    val days: List<WireDay> = emptyList(),
    /** "HH:MM", local time in the policy's zone. */
    val start: String,
    val end: String,
    /** Apps that stay open, beyond never-blocked and exempt ones. */
    val allow: List<String> = emptyList(),
    /** Lock the screen when it starts. */
    val lock: Boolean = false,
    /** "YYYY-MM-DD": days it doesn't start. */
    val skip: List<String> = emptyList(),
)

/**
 * Extra time a parent gave for one day, usually in answer to a `more_time` request.
 *
 * Decision: [limitId] `"*"` gives the minutes to every limit ("15 more minutes of phone"), and
 * [packageName] (an addition to the design) keeps the minutes for that one app ("15 more minutes
 * of this game"): other apps under the same limit still stop at its usual minutes. Both left out:
 * the whole limit gets the minutes.
 */
@Serializable
data class WireExtra(
    val id: String,
    @SerialName("limit_id") val limitId: String,
    val minutes: Int,
    /** "YYYY-MM-DD" in the policy's zone, as its day_starts counts days. */
    val day: String,
    @SerialName("request_id") val requestId: String? = null,
    @SerialName("package") val packageName: String? = null,
) {
    companion object {
        const val EVERY_LIMIT = "*"
    }
}

/** Extra minutes the kid may take without asking, [times] a day: a rule a parent set. */
@Serializable
data class WireSelfServe(val minutes: Int, val times: Int)

@Serializable
enum class WireIfUnmeasured {
    /** Every app with a limit is paused while Belay can't count (the default). */
    @SerialName("pause_limited") PAUSE_LIMITED,

    /** Apps stay open; a limit that was already used up stays used up. */
    @SerialName("keep_open") KEEP_OPEN,
}

/** The policy's `screen_time`. Null in the policy: no measuring, no limits, no schedules. */
@Serializable
data class WireScreenTime(
    /** Count app time and send it with `POST /api/v1/usage`. Limits are counted on the phone either way. */
    val measure: Boolean = false,
    /** An IANA zone, or "phone": the phone's own zone. */
    val zone: String = ZONE_PHONE,
    /** "HH:MM": when a day's limits reset. */
    @SerialName("day_starts") val dayStarts: String = "00:00",
    /** At most 50. */
    val limits: List<WireLimit> = emptyList(),
    /** At most 20. */
    val schedules: List<WireSchedule> = emptyList(),
    /** Packages never counted or paused, beyond the never-blocked set. */
    val exempt: List<String> = emptyList(),
    @SerialName("if_unmeasured") val ifUnmeasured: WireIfUnmeasured = WireIfUnmeasured.PAUSE_LIMITED,
    val extra: List<WireExtra> = emptyList(),
    @SerialName("self_serve") val selfServe: WireSelfServe? = null,
    /** Minutes before a limit runs out or a schedule starts that the kid is told; 0: no warnings. */
    @SerialName("warn_before") val warnBefore: Int = 5,
) {
    companion object {
        const val ZONE_PHONE = "phone"
    }
}

/**
 * Decision: the next stage's own rules ride along as [screenTime] (an addition to the design), so
 * the phone can say what changes in its own words (Stages.changes) rather than only show the
 * server's English [unlocks].
 */
@Serializable
data class WireStageNext(
    val name: String,
    /** Sentences the server wrote from the difference between the stages: untrusted for AI. */
    val unlocks: List<String> = emptyList(),
    /** How to get there, in the parents' words: untrusted for AI. */
    val how: String? = null,
    @SerialName("screen_time") val screenTime: WireScreenTime? = null,
)

/** The stage the phone is on, for the kid's screen. */
@Serializable
data class WireStage(
    val name: String,
    val number: Int,
    val since: Long,
    val next: WireStageNext? = null,
)

@Serializable
data class WireAgreementSection(val title: String, val text: String)

/** The family agreement, in the family's own words: at most 20 sections of 2000 characters. */
@Serializable
data class WireAgreement(
    val version: Int,
    val sections: List<WireAgreementSection> = emptyList(),
    @SerialName("kid_agreed_at") val kidAgreedAt: Long? = null,
    @SerialName("parents_agreed_at") val parentsAgreedAt: Long? = null,
)

/**
 * The policy's `network_log`: a parent's choice alone, off by default. While it's on, Belay has
 * Android log DNS lookups and sends how many times each app looked up each domain, per day
 * (`POST /api/v1/network`, core's network package).
 */
@Serializable
data class WireNetworkLog(
    val enabled: Boolean = false,
    /**
     * The family's private websites (a parent's alone): registrable domains, lowercase hostnames
     * like a [family.brooker.belay.core.network.WireNetworkEntry]'s domain, that Belay never keeps a
     * lookup of, or of a name under one, like 988's websites (core's Domains.neverKept). Sent
     * whether logging is on or off; at most 100. Empty from a server older than private websites.
     * Never in Belay's log or its debug state, and never named on the kid's screens.
     */
    @SerialName("private_domains") val privateDomains: List<String> = emptyList(),
)

// ── What the phone reports: enforcement additions, in Device ──

@Serializable
enum class WireLimitState {
    @SerialName("open") OPEN,
    @SerialName("used_up") USED_UP,

    /** Its usual minutes are used up and the apps run on extra time. */
    @SerialName("extra") EXTRA,
}

/**
 * Decision: [used] and [left] are minutes, and are left out when the policy's `measure` is off:
 * then the phone counts only to enforce the limits, and sends no minutes (collection is a parent
 * decision). [used] is rounded down and [left] up, so "1 minute left" means there is still time.
 */
@Serializable
data class WireLimitStatus(
    val id: String,
    val used: Int? = null,
    val left: Int? = null,
    val state: WireLimitState,
)

/** The schedule in effect now; when several are, the one that ends last. */
@Serializable
data class WireScheduleNow(val id: String, val until: Long)

/** Decision (an addition): extra minutes the kid took without asking, so the parent sees them. */
@Serializable
data class WireSelfServeTake(
    @SerialName("limit_id") val limitId: String,
    @SerialName("package") val packageName: String? = null,
    val minutes: Int,
    val at: Long,
)

/** The phone's view of screen time right now (`enforcement.screen_time`). */
@Serializable
data class WireScreenTimeStatus(
    /** "YYYY-MM-DD": the day the limits count, in the policy's zone. */
    val day: String,
    /** Usage access is on, so Belay is counting. */
    val measured: Boolean,
    /** Screen time today, in minutes; left out when `measure` is off. */
    @SerialName("used_minutes") val usedMinutes: Int? = null,
    val limits: List<WireLimitStatus> = emptyList(),
    val schedule: WireScheduleNow? = null,
    @SerialName("self_serve") val selfServe: List<WireSelfServeTake> = emptyList(),
)

/**
 * `enforcement.network_log`: null while the policy has logging off and Android's is off too
 * (core's NetworkLog.report).
 */
@Serializable
data class WireNetworkLogStatus(
    /** Android's network logging is on for Belay (DevicePolicyManager.isNetworkLoggingEnabled). */
    val enabled: Boolean,
    /** Android paused logging: another user or profile is on the phone, so it hands Belay nothing. */
    val paused: Boolean = false,
)

// ── POST /api/v1/usage ──

@Serializable
enum class WireGapReason {
    @SerialName("no_usage_access") NO_USAGE_ACCESS,
    @SerialName("phone_off") PHONE_OFF,
    @SerialName("unknown") UNKNOWN,
}

/** A time Belay couldn't count. */
@Serializable
data class WireUsageGap(val from: Long, val to: Long, val reason: WireGapReason)

@Serializable
data class WireUsageApp(
    @SerialName("package") val packageName: String,
    val minutes: Int,
    val opens: Int,
)

/**
 * One local day of usage. Idempotent by ([day], [zone]): a day sent again replaces the server's
 * when its [asOf] is the same or newer. Decision: [asOf] is the time up to which the day was
 * counted, not the newest event, so a later report always replaces an earlier one even when no
 * new event came (an app left open); a complete day sent again after a clock change has the same
 * [asOf] (the day's end), and must replace it too (UsageUploads).
 */
@Serializable
data class WireUsageDay(
    /** "YYYY-MM-DD" in [zone]. */
    val day: String,
    /** IANA. */
    val zone: String,
    @SerialName("as_of") val asOf: Long,
    /** The day is over, and counted to its end. */
    val complete: Boolean,
    /** Screen on and unlocked. */
    @SerialName("screen_minutes") val screenMinutes: Int,
    val unlocks: Int,
    /**
     * Screen minutes in each local hour, 0 to 23. Decision: on the day clocks go back, both
     * 1 a.m. hours add up in one entry (it can pass 60); on the day they go forward, the skipped
     * hour stays 0.
     */
    @SerialName("by_hour") val byHour: List<Int>,
    /** At most 500, most used first; apps under a minute are left out. */
    val apps: List<WireUsageApp> = emptyList(),
    val gaps: List<WireUsageGap> = emptyList(),
)

/** At most 31 days and 256 KB. */
@Serializable
data class UsageRequest(val days: List<WireUsageDay>)

@Serializable
data class UsageResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
)

// ── POST /api/v1/requests: Phase 3 kinds ──

@Serializable
enum class WireAgreementAnswer {
    @SerialName("agree") AGREE,
    @SerialName("talk") TALK,
}

/** Limits from the design's protocol proposal; the agent stays below them. */
object ScreenTimeWireLimits {
    const val MAX_LIMITS = 50
    const val MAX_SCHEDULES = 20
    const val MAX_LIMIT_NAME = 60
    const val MAX_DAY_MINUTES = 1440
    const val MIN_MORE_TIME_MINUTES = 5
    const val MAX_MORE_TIME_MINUTES = 240
    const val MAX_USAGE_DAYS = 31
    const val MAX_USAGE_APPS = 500
    const val MAX_USAGE_BODY_BYTES = 256 * 1024
    const val MAX_COMMAND_REPORTS = 20
    const val MAX_AGREEMENT_SECTIONS = 20
    const val MAX_AGREEMENT_SECTION = 2000

    /** The most minutes enforcement.screen_time reports in one number: 25 hours, the longest day. */
    const val MAX_STATUS_MINUTES = 1500

    /** Self-serve takes in enforcement.screen_time. */
    const val MAX_STATUS_TAKES = 20

    /** Gaps in one UsageDay. */
    const val MAX_USAGE_GAPS = 200
}
