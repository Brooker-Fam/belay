package family.brooker.belay.core

import family.brooker.belay.core.screentime.AgreementAnswer
import family.brooker.belay.core.screentime.MoreTime
import family.brooker.belay.core.screentime.ScreenTimeWireLimits
import family.brooker.belay.core.screentime.WireAgreementAnswer
import kotlinx.serialization.Serializable

/**
 * Something the kid asked a parent for, as the phone keeps it (data category
 * [DataCategories.REQUESTS]). The server keeps the same id; its answer comes back in the
 * policy's `requests`. Phase 3 adds two [kind]s, each with its own fields: more time for a
 * limit today, and the kid's answer to the family agreement.
 */
@Serializable
data class KidRequest(
    /** UUID made on the phone. */
    val id: String,
    /** The app (`app`), the app the kid was in (`more_time`, or "" for none), or "" (`agreement`). */
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
)

/** A request with the server's answer, if it has one yet. */
data class AnsweredRequest(val request: KidRequest, val answer: WireRequestAnswer?) {
    /** Still open: not answered, or only "pending". Sending again updates the reason. */
    val open: Boolean get() = answer == null || answer.status == WireRequestStatus.PENDING

    /** A Phase 2 request for an app (not more time or an agreement answer). */
    val forApp: Boolean get() = request.kind == WireRequestKind.APP
}

object Requests {
    /** Requests older than this are forgotten (the policy carries the last 30 days of answers). */
    const val KEEP_MS = 60L * 24 * 60 * 60 * 1000

    /** The kid's words, trimmed and capped for the wire; null when there are none. */
    fun cleanReason(text: String?): String? =
        text?.trim()?.take(WireLimits.MAX_REASON)?.takeIf { it.isNotEmpty() }

    /** Each request with the policy's answer for it, newest first. */
    fun answered(requests: List<KidRequest>, policy: WirePolicy?): List<AnsweredRequest> {
        val answers = policy?.requests.orEmpty().associateBy { it.id }
        return requests.sortedByDescending { it.askedAt }.map { AnsweredRequest(it, answers[it.id]) }
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

    /** The request as the server takes it: each kind with only its own fields. */
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
    }

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
