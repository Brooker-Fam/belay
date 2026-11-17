package family.brooker.belay.core

import family.brooker.belay.core.location.WireFix
import family.brooker.belay.core.screentime.AgreementAnswer
import family.brooker.belay.core.screentime.MoreTime
import family.brooker.belay.core.screentime.ScreenTimeWireLimits
import family.brooker.belay.core.screentime.WireAgreementAnswer
import kotlinx.serialization.Serializable

/**
 * Something the kid asked a parent for, as the phone keeps it (data category
 * [DataCategories.REQUESTS]). The server keeps the same id; its answer comes back in the
 * policy's `requests`. Phase 3 adds two [kind]s, each with its own fields: more time for a
 * limit today, and the kid's answer to the family agreement. Phase 7 adds "I need help" (with
 * where the phone is, only when the kid shares it) and "Talk to my parent", and lets the kid
 * change the words of a pending request or take it back ([withdrawnAt]).
 */
@Serializable
data class KidRequest(
    /** UUID made on the phone. */
    val id: String,
    /** The app (`app`), the app the kid was in (`more_time`, or "" for none), or "" (the other kinds). */
    val packageName: String,
    /** The app's name, from its developer: untrusted. "" when there's no app. */
    val label: String,
    /** The kid's own words: untrusted, at most [WireLimits.MAX_REASON] characters. */
    val reason: String? = null,
    val askedAt: Long,
    /** Counts each send, so every send is its own outbox item. */
    val revision: Int = 0,
    /** Phase 3: what the kid asks for. */
    val kind: WireRequestKind = WireRequestKind.APP,
    /** more_time: the limit's id. */
    val limitId: String? = null,
    /** more_time: the minutes asked for, 5 to 240. */
    val minutes: Int? = null,
    /** agreement: the version answered. */
    val version: Int? = null,
    /** agreement: "I agree" or "I want to talk about it". */
    val answer: WireAgreementAnswer? = null,
    /** Phase 7, help: where the phone was, only when the kid chose to share it. */
    val location: WireFix? = null,
    /** Phase 7: when the kid took it back, while it was pending. */
    val withdrawnAt: Long? = null,
    /** Phase 7, help: the kid asked to share where the phone is, and Belay is finding it. */
    val sharing: Boolean = false,
)

/**
 * A request with the server's answer, if it has one yet, and (Phase 7, help) when a parent saw
 * it ([seen], from the policy's `help_seen`).
 */
data class AnsweredRequest(val request: KidRequest, val answer: WireRequestAnswer?, val seen: WireHelpSeen? = null) {
    /** The kid took it back (Phase 7). */
    val withdrawn: Boolean get() = request.withdrawnAt != null

    /** Still open: not answered, or only "pending", and not taken back. Sending again updates the reason. */
    val open: Boolean get() = !withdrawn && (answer == null || answer.status == WireRequestStatus.PENDING)

    /** A Phase 2 request for an app (not more time or an agreement answer). */
    val forApp: Boolean get() = request.kind == WireRequestKind.APP
}

object Requests {
    /** Requests older than this are forgotten (the policy carries the last 30 days of answers). */
    const val KEEP_MS = 60L * 24 * 60 * 60 * 1000

    /** The kid's words, trimmed and capped for the wire; null when there are none. */
    fun cleanReason(text: String?): String? =
        text?.trim()?.take(WireLimits.MAX_REASON)?.takeIf { it.isNotEmpty() }

    /** Each request with the policy's answer for it, and when a parent saw it (help), newest first. */
    fun answered(requests: List<KidRequest>, policy: WirePolicy?): List<AnsweredRequest> {
        val answers = policy?.requests.orEmpty().associateBy { it.id }
        val seen = policy?.helpSeen.orEmpty().groupBy { it.requestId }.mapValues { (_, all) -> all.minBy { it.at } }
        return requests.sortedByDescending { it.askedAt }.map { AnsweredRequest(it, answers[it.id], seen[it.id]) }
    }

    /**
     * Phase 7: "I need help", sent at once with no words needed. The kid's [reason] (optional) and
     * [sharing] (they chose to share where the phone is, which Belay is finding) go with it.
     */
    fun help(reason: String?, sharing: Boolean, now: Long, newId: () -> String): KidRequest = KidRequest(
        id = newId(),
        packageName = "",
        label = "",
        reason = cleanReason(reason),
        askedAt = now,
        kind = WireRequestKind.HELP,
        sharing = sharing,
    )

    /** Phase 7: "Talk to my parent", with the kid's words; null when there are none (the server needs them). */
    fun talk(reason: String?, now: Long, newId: () -> String): KidRequest? {
        val words = cleanReason(reason) ?: return null
        return KidRequest(id = newId(), packageName = "", label = "", reason = words, askedAt = now, kind = WireRequestKind.TALK)
    }

    /**
     * Phase 7: the kid changes the words of an open request [id] to [reason]: sent again (the server
     * takes a new reason while it's pending). Null when it isn't open, or a `talk` would be left
     * without words, or nothing changed.
     */
    fun edit(answered: List<AnsweredRequest>, id: String, reason: String?): KidRequest? {
        val open = answered.firstOrNull { it.request.id == id && it.open }?.request ?: return null
        val words = cleanReason(reason)
        if (open.kind == WireRequestKind.TALK && words == null) return null
        if (words == open.reason) return null
        return open.copy(reason = words, revision = open.revision + 1)
    }

    /**
     * Phase 7: the kid takes back the open request [id]: sent again with `withdrawn_at`, and it
     * leaves the policy's requests. An answered one can't be taken back (null), nor an agreement
     * answer "I agree", which the server answers as it arrives.
     */
    fun withdraw(answered: List<AnsweredRequest>, id: String, now: Long): KidRequest? {
        val open = answered.firstOrNull { it.request.id == id && it.open }?.request ?: return null
        if (open.kind == WireRequestKind.AGREEMENT && open.answer == WireAgreementAnswer.AGREE) return null
        return open.copy(withdrawnAt = now, revision = open.revision + 1)
    }

    /**
     * Phase 7: the help request [id] with where the phone was ([fix], reason `help`), sent again;
     * or, with no fix, only marked as no longer finding it. Null when there's no such request.
     */
    fun withHelpFix(requests: List<KidRequest>, id: String, fix: WireFix?): KidRequest? {
        val help = requests.firstOrNull { it.id == id && it.kind == WireRequestKind.HELP } ?: return null
        if (fix == null) return help.copy(sharing = false).takeIf { help.sharing }
        return help.copy(location = fix, sharing = false, revision = help.revision + 1)
    }

    /** The newest open request for the app [packageName], which sending again updates. */
    fun open(answered: List<AnsweredRequest>, packageName: String): AnsweredRequest? =
        answered.firstOrNull { it.forApp && it.request.packageName == packageName && it.open }

    /**
     * The waiting apps that need a request made for them now: any without a request since it
     * was installed ([installedAt]: its first-install time), so the parent sees it even if
     * the kid never opens Belay. One already answered (declined, say) isn't repeated: the kid
     * sees the answer and can ask again with a reason. An app removed and installed again is
     * asked for again.
     */
    fun toMake(waiting: List<String>, requests: List<KidRequest>, installedAt: (String) -> Long?): List<String> {
        val lastAsked = HashMap<String, Long>()
        requests.filter { it.kind == WireRequestKind.APP }.forEach { lastAsked.merge(it.packageName, it.askedAt, ::maxOf) }
        return waiting.filter { name ->
            val asked = lastAsked[name] ?: return@filter true
            val installed = installedAt(name) ?: return@filter false
            asked < installed
        }
    }

    /**
     * What the kid sending [reason] for [packageName] makes: the open request with the new
     * reason, or a new request when none is open.
     */
    fun send(
        answered: List<AnsweredRequest>,
        packageName: String,
        label: String,
        reason: String?,
        now: Long,
        newId: () -> String,
    ): KidRequest {
        val open = open(answered, packageName)?.request
        return open?.copy(reason = cleanReason(reason), revision = open.revision + 1)
            ?: KidRequest(newId(), packageName, label.take(WireLimits.MAX_LABEL), cleanReason(reason), now)
    }

    /**
     * Phase 3: the kid asks for [minutes] more for [limitId] today, from the app [packageName]
     * (with its [label]) or from Belay's screen. While a request for the same limit made since
     * [todayStart] is still open, this sends it again with the new reason: the server only takes
     * a new reason for a pending request, so the minutes stay as first asked.
     */
    fun moreTime(
        answered: List<AnsweredRequest>,
        limitId: String,
        minutes: Int,
        packageName: String?,
        label: String?,
        reason: String?,
        now: Long,
        todayStart: Long,
        newId: () -> String,
    ): KidRequest {
        val open = openMoreTime(answered, limitId, todayStart)?.request
        return open?.copy(reason = cleanReason(reason), revision = open.revision + 1)
            ?: KidRequest(
                id = newId(),
                packageName = packageName.orEmpty(),
                label = label.orEmpty().take(WireLimits.MAX_LABEL),
                reason = cleanReason(reason),
                askedAt = now,
                kind = WireRequestKind.MORE_TIME,
                limitId = limitId,
                minutes = minutes.coerceIn(ScreenTimeWireLimits.MIN_MORE_TIME_MINUTES, ScreenTimeWireLimits.MAX_MORE_TIME_MINUTES),
            )
    }

    /** The open more-time request for [limitId] made since [todayStart], if any. */
    fun openMoreTime(answered: List<AnsweredRequest>, limitId: String, todayStart: Long): AnsweredRequest? =
        answered.firstOrNull {
            it.request.kind == WireRequestKind.MORE_TIME && it.request.limitId == limitId && it.request.askedAt >= todayStart && it.open
        }

    /**
     * Phase 3: the kid's [answer] to version [version] of the family agreement. The same answer
     * again while it's open sends it again with the new reason; a different one is a new request.
     */
    fun agreement(
        answered: List<AnsweredRequest>,
        version: Int,
        answer: WireAgreementAnswer,
        reason: String?,
        now: Long,
        newId: () -> String,
    ): KidRequest {
        val open = answered.firstOrNull {
            it.request.kind == WireRequestKind.AGREEMENT && it.request.version == version && it.request.answer == answer && it.open
        }?.request
        return open?.copy(reason = cleanReason(reason), revision = open.revision + 1)
            ?: KidRequest(
                id = newId(),
                packageName = "",
                label = "",
                reason = cleanReason(reason),
                askedAt = now,
                kind = WireRequestKind.AGREEMENT,
                version = version,
                answer = answer,
            )
    }

    /**
     * The request as the server takes it: each kind with only its own fields, and (Phase 7)
     * `withdrawn_at` once the kid took it back. A help request carries its shared fix.
     */
    fun toWire(request: KidRequest): WireRequest = when (request.kind) {
        WireRequestKind.APP -> WireRequest(
            id = request.id,
            kind = WireRequestKind.APP,
            packageName = request.packageName,
            label = request.label.take(WireLimits.MAX_LABEL),
            reason = cleanReason(request.reason),
            askedAt = request.askedAt,
        )
        WireRequestKind.MORE_TIME -> MoreTime.request(
            id = request.id,
            limitId = request.limitId.orEmpty(),
            minutes = request.minutes ?: ScreenTimeWireLimits.MIN_MORE_TIME_MINUTES,
            askedAt = request.askedAt,
            packageName = request.packageName.takeIf { it.isNotEmpty() },
            reason = request.reason,
        )
        WireRequestKind.AGREEMENT -> AgreementAnswer.request(
            id = request.id,
            version = request.version ?: 0,
            answer = request.answer ?: WireAgreementAnswer.TALK,
            askedAt = request.askedAt,
            reason = request.reason,
        )
        WireRequestKind.HELP -> WireRequest(
            id = request.id,
            kind = WireRequestKind.HELP,
            reason = cleanReason(request.reason),
            askedAt = request.askedAt,
            location = request.location,
        )
        WireRequestKind.TALK -> WireRequest(
            id = request.id,
            kind = WireRequestKind.TALK,
            reason = cleanReason(request.reason),
            askedAt = request.askedAt,
        )
    }.copy(withdrawnAt = request.withdrawnAt)

    /** The outbox item id for this send of [request]: unique per send, ordered by revision. */
    fun itemId(request: KidRequest): String = "request:${request.id}:${request.revision}"
}

/** Which policy the phone keeps, and how the long-poll paces itself. */
object PolicyRules {
    /** How long the server may hold the long-poll (it allows up to 55 s). */
    const val POLL_WAIT_S = 50

    /** The long-poll's backoff stops growing here: commands should arrive within minutes. */
    const val POLL_BACKOFF_MAX_MS = 5L * 60 * 1000

    /**
     * Whether [incoming] replaces [stored], which arrived at [storedAt]. Any version that
     * differs does, lower ones too (the family restored an older server backup), as long as
     * its request was sent ([sentAt]) after the stored policy arrived: then the answer is the
     * server's state since. An answer to a request sent earlier (a check-in that crossed the
     * long-poll) only counts if it is newer, so it can't roll the phone back.
     */
    fun replaces(stored: WirePolicy?, storedAt: Long?, incoming: WirePolicy, sentAt: Long): Boolean = when {
        stored == null -> true
        incoming.version == stored.version -> false
        incoming.version > stored.version -> true
        else -> storedAt == null || sentAt >= storedAt
    }

    /**
     * The wait before the long-poll tries again after its [failures]-th failure in a row:
     * the outbox's backoff, capped lower, and never sooner than the server's Retry-After.
     */
    fun pollRetryMs(failures: Int, retryAfterMs: Long?, random: Double): Long =
        maxOf(retryAfterMs ?: 0, OutboxPolicy.backoffMs(failures, random).coerceAtMost(POLL_BACKOFF_MAX_MS))
}

/** The phone's rules in plain words, for the kid's screen: only what Belay applies now. */
object KidRules {
    enum class Rule {
        NEW_APPS_WAIT,
        NO_SAFE_MODE,
        NO_NEW_USERS,
        NO_UNKNOWN_SOURCES,
        NO_VPN,
        PRIVATE_DNS_LOCKED,
        CLOCK_LOCKED,
        DEFAULT_APPS_LOCKED,
        ACCOUNTS_LOCKED,
        NO_NEW_ESIM,
        NO_FACTORY_RESET,
        RESET_PROTECTION,
        NO_DEBUGGING,
        REPAIR_MODE,

        /** Phase 6: the recovery key opened repair access (debugging and factory reset) for a while. */
        RECOVERY_OPEN,

        /** Phase 4: location is locked on (keep_on, or lost mode). */
        LOCATION_LOCKED_ON,
        WEB_FILTER,
        NO_BROWSERS,
        CHROME_NO_INCOGNITO,
        CHROME_SAFE_SEARCH,
        CHROME_YOUTUBE_RESTRICTED,
        CHROME_SAFE_SITES,
        CHROME_NO_DOWNLOADS,
        CHROME_ALLOWLIST,
        CHROME_BLOCKLIST,
    }

    /**
     * [privateDns] is the host Belay has set, if any. Factory reset and debugging only show
     * when Belay actually locked them (never on a debug build).
     */
    fun of(policy: WirePolicy?, plan: EnforcementPlan?, applied: Applied, privateDns: String?): List<Rule> {
        if (policy == null || plan == null) return emptyList()
        val rules = mutableListOf<Rule>()
        if (policy.apps.newApps == WireNewApps.ASK) rules += Rule.NEW_APPS_WAIT
        val locks = applied.locks
        if (Lock.SAFE_BOOT in locks) rules += Rule.NO_SAFE_MODE
        if (Lock.ADD_USER in locks) rules += Rule.NO_NEW_USERS
        if (Lock.UNKNOWN_SOURCES in locks) rules += Rule.NO_UNKNOWN_SOURCES
        if (Lock.CONFIG_VPN in locks) rules += Rule.NO_VPN
        if (privateDns != null) rules += Rule.WEB_FILTER
        if (Lock.CONFIG_PRIVATE_DNS in locks) rules += Rule.PRIVATE_DNS_LOCKED
        if (Lock.CONFIG_DATE_TIME in locks) rules += Rule.CLOCK_LOCKED
        if (Lock.CONFIG_DEFAULT_APPS in locks) rules += Rule.DEFAULT_APPS_LOCKED
        if (Lock.MODIFY_ACCOUNTS in locks) rules += Rule.ACCOUNTS_LOCKED
        if (Lock.SIM in locks) rules += Rule.NO_NEW_ESIM
        if (Lock.CONFIG_LOCATION in locks) rules += Rule.LOCATION_LOCKED_ON
        if (Lock.FACTORY_RESET in locks) rules += Rule.NO_FACTORY_RESET
        if (applied.frpAccounts != null) rules += Rule.RESET_PROTECTION
        if (Lock.DEBUGGING in locks) rules += Rule.NO_DEBUGGING
        if (plan.maintenanceUntil != null && policy.restrictions.debugging && Lock.DEBUGGING !in locks) rules += Rule.REPAIR_MODE
        if (plan.recoveryUntil != null && (policy.restrictions.debugging || policy.restrictions.factoryReset) &&
            Lock.DEBUGGING !in locks && Lock.FACTORY_RESET !in locks
        ) {
            rules += Rule.RECOVERY_OPEN
        }
        if (policy.web.hideBrowsers && plan.hiddenBrowsers.all { it in applied.hidden }) rules += Rule.NO_BROWSERS
        val chrome = applied.chrome
        if (chrome != null && plan.hiddenBrowsers.isEmpty()) {
            if (chrome.incognitoModeAvailability == 1) rules += Rule.CHROME_NO_INCOGNITO
            if (chrome.forceGoogleSafeSearch) rules += Rule.CHROME_SAFE_SEARCH
            if (chrome.forceYouTubeRestrict > 0) rules += Rule.CHROME_YOUTUBE_RESTRICTED
            if (chrome.safeSitesFilterBehavior == 1) rules += Rule.CHROME_SAFE_SITES
            if (chrome.downloadRestrictions == 3) rules += Rule.CHROME_NO_DOWNLOADS
            if (chrome.urlAllowlist != null) {
                rules += Rule.CHROME_ALLOWLIST
            } else if (chrome.urlBlocklist.isNotEmpty()) {
                rules += Rule.CHROME_BLOCKLIST
            }
        }
        return rules
    }
}
