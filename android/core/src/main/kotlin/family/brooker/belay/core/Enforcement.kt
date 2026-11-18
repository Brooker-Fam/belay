package family.brooker.belay.core

import family.brooker.belay.core.calls.WireCallsStatus
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.WireLocationStatus
import family.brooker.belay.core.mobiledata.WireMobileDataStatus
import family.brooker.belay.core.screentime.WireNetworkLogStatus
import family.brooker.belay.core.screentime.WireScreenTimeStatus
import kotlinx.serialization.Serializable

/**
 * The settings Belay can lock: Android user restrictions, named here so :core stays free of
 * Android classes (:app maps each to its UserManager key). [minSdkFull] is the first
 * Build.VERSION.SDK_INT_FULL (major * 100000 + minor) that knows the key; 0 for keys older
 * than Belay's minSdk 31.
 */
@Serializable
enum class Lock(val minSdkFull: Int = 0) {
    SAFE_BOOT,
    ADD_USER,
    USER_SWITCH,

    /** DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY. */
    UNKNOWN_SOURCES,

    /** 37.2 and up: the older keys no longer cover registered app stores (platform notes M2). */
    UNKNOWN_SOURCES_REGISTERED_STORES(3_700_002),
    CONFIG_VPN,
    CONFIG_PRIVATE_DNS,
    CONFIG_DATE_TIME,
    CONFIG_DEFAULT_APPS(3_400_000),
    MODIFY_ACCOUNTS,

    /** DISALLOW_SIM_GLOBALLY: no new eSIMs. */
    SIM(3_500_000),

    /** Can lock a phone for good: only on release builds (CLAUDE.md, "Ask before"). */
    FACTORY_RESET,

    /** Can lock a phone for good: only on release builds, and lifted during maintenance. */
    DEBUGGING,

    /**
     * Phase 4: DISALLOW_CONFIG_LOCATION, while the policy's location has `keep_on` (and a mode on)
     * or lost mode: the kid can't turn location off; Belay still can (platform notes L2).
     */
    CONFIG_LOCATION,
}

/** Why Belay never suspends or hides a package, in words for the parent's problem list. */
enum class Protection(val words: String) {
    BELAY("it's Belay itself"),
    CALLS("it places phone calls, and 911 and 988 always work"),
    EMERGENCY("it's for emergencies, and 911 and 988 always work"),
    TEXTS("it's the texting app, and texting 988 always works"),
    HOME("it's the home screen"),
    SYSTEM_UI("it's Android's System UI"),
    SETTINGS("it's Settings"),
    KEYBOARD("it's the keyboard, and texting 988 always works"),
    ANDROID("it's part of Android"),
}

/**
 * What only the phone can tell: which packages fill the roles Belay never blocks, and which
 * apps are browsers. :app reads these from PackageManager, TelecomManager and Settings at
 * every step, so a new default app is protected at once.
 */
data class PhoneRoles(
    val self: String,
    /** The default dialer and the preloaded one. */
    val dialers: Set<String> = emptySet(),
    /** The default SMS app. */
    val texting: Set<String> = emptySet(),
    /** System apps that handle Android's emergency assistance intent. */
    val emergency: Set<String> = emptySet(),
    /** The default home screen, and the system's own home screens. */
    val home: Set<String> = emptySet(),
    val settings: Set<String> = emptySet(),
    /** The keyboard in use, when it came with the phone. */
    val keyboards: Set<String> = emptySet(),
    /** Apps that open any web address (the test of Android's browser role). */
    val browsers: Set<String> = emptySet(),
    /**
     * Left alone by a pause, though still suspended while waiting or blocked: the phone's own
     * clock (a suspended app can't ring the device, so alarms would stay silent) and the
     * keyboard in use (texting 988 needs one).
     */
    val pauseExempt: Set<String> = emptySet(),
)

object NeverBlocked {
    /** Fixed names from AOSP: the framework, telephony and telecom, System UI, Settings, alerts. */
    val FIXED: Map<String, Protection> = linkedMapOf(
        "android" to Protection.ANDROID,
        "com.android.phone" to Protection.CALLS,
        "com.android.server.telecom" to Protection.CALLS,
        "com.android.systemui" to Protection.SYSTEM_UI,
        "com.android.settings" to Protection.SETTINGS,
        "com.android.emergency" to Protection.EMERGENCY,
        "com.android.cellbroadcastreceiver" to Protection.EMERGENCY,
        "com.google.android.cellbroadcastreceiver" to Protection.EMERGENCY,
    )

    /**
     * Every package Belay never suspends or hides, whatever the policy says, and why: the
     * protocol's list ("Enforcement rules"), plus the keyboard in use. "Android's own system
     * packages" are the system packages with no icon in the launcher (the framework, providers,
     * services, WebView, Play services). A package Belay hid itself counts as launchable: a
     * hidden app's launcher icon can't be seen, and it was blockable when Belay hid it.
     */
    fun of(roles: PhoneRoles, apps: Map<String, PackageRecord>, hiddenByBelay: Set<String>): Map<String, Protection> {
        val out = LinkedHashMap<String, Protection>()
        // Each group in name order, so the same phone always gives the same list (it's reported).
        fun add(names: Collection<String>, why: Protection) = names.sorted().forEach { out.putIfAbsent(it, why) }
        add(listOf(roles.self), Protection.BELAY)
        FIXED.forEach { (name, why) -> out.putIfAbsent(name, why) }
        add(roles.dialers, Protection.CALLS)
        add(roles.emergency, Protection.EMERGENCY)
        add(roles.texting, Protection.TEXTS)
        add(roles.home, Protection.HOME)
        add(roles.settings, Protection.SETTINGS)
        add(roles.keyboards, Protection.KEYBOARD)
        add(apps.values.filter { it.system && !it.launchable && it.packageName !in hiddenByBelay }.map { it.packageName }, Protection.ANDROID)
        return out
    }

    /**
     * What the enforcement report lists as never blocked (docs/protocol.md, "Enforcement
     * rules"): the installed ones from [of], in its order (Belay, the fixed names, the roles,
     * then Android's own packages), at most [WireLimits.MAX_NEVER_BLOCKED].
     */
    fun report(protected: Map<String, Protection>, apps: Map<String, PackageRecord>): List<String> =
        protected.keys.filter { it in apps }.take(WireLimits.MAX_NEVER_BLOCKED)
}

/**
 * Chrome's managed configuration (setApplicationRestrictions on com.android.chrome), as the
 * policy values Chrome reads. Names and values from Chromium's policy definitions; all of
 * them are supported on Android.
 */
@Serializable
data class ChromeConfig(
    /** IncognitoModeAvailability: 0 available, 1 disabled. */
    val incognitoModeAvailability: Int,
    val forceGoogleSafeSearch: Boolean,
    /** ForceYouTubeRestrict: 0 off, 1 moderate, 2 strict. */
    val forceYouTubeRestrict: Int,
    /** SafeSitesFilterBehavior: 0 off, 1 filters adult sites. */
    val safeSitesFilterBehavior: Int,
    /** DownloadRestrictions: 0 no special restrictions, 3 blocks all downloads. */
    val downloadRestrictions: Int,
    val urlBlocklist: List<String>,
    /** Null: no allowlist. */
    val urlAllowlist: List<String>?,
    /**
     * DnsOverHttpsMode "off": Chrome looks names up through the phone's resolver, so a
     * Private DNS filter covers Chrome too.
     */
    val dnsOverHttpsMode: String = "off",
    /**
     * ProxySettings, a dictionary policy, which Chrome on Android takes as a JSON string:
     * [PROXY_DIRECT], so Chrome never uses a proxy set on the phone's Wi-Fi or mobile network (a
     * proxy looks names up itself, past Private DNS) and connects directly (platform notes H2).
     * Null only in a record an older Belay stored, so updating Belay sets it.
     */
    val proxySettings: String? = null,
) {
    companion object {
        /** Chrome's ProxySettings with ProxyMode "direct": never use a proxy server. */
        const val PROXY_DIRECT = """{"ProxyMode":"direct"}"""

        fun of(chrome: WireChromePolicy) = ChromeConfig(
            incognitoModeAvailability = if (chrome.incognito) 0 else 1,
            forceGoogleSafeSearch = chrome.safeSearch,
            forceYouTubeRestrict = when (chrome.youtubeRestrict) {
                "off" -> 0
                "moderate" -> 1
                else -> 2
            },
            safeSitesFilterBehavior = if (chrome.safeSites) 1 else 0,
            downloadRestrictions = if (chrome.allowDownloads) 0 else 3,
            // Allowlist mode: everything is blocked except the allowlist (Chrome's own recipe).
            urlBlocklist = (if (chrome.urlAllowlist != null) listOf("*") else emptyList()) + chrome.urlBlocklist,
            urlAllowlist = chrome.urlAllowlist,
            proxySettings = PROXY_DIRECT,
        )
    }
}

/**
 * Why Belay holds an app suspended, as short codes for its own records (Applied.reasons) and
 * the debug state. Screen time (Phase 3) adds its own: core's screentime ReasonCode.code, like
 * "app_limit" or "bedtime"; a pause is "paused" in both.
 */
object HoldReason {
    const val WAITING = "waiting"
    const val BLOCKED = "blocked"
    const val NO_BROWSERS = "no_browsers"
    const val PAUSED = "paused"
}

/** What a policy means on this phone right now. Pure: the same inputs give the same plan. */
data class EnforcementPlan(
    val version: Int,
    /** Every package Belay should hold suspended: waiting, blocked, hidden browsers, paused. */
    val suspend: Set<String>,
    /** Every package Belay should hide: blocked apps and hidden browsers. */
    val hide: Set<String>,
    val locks: Set<Lock>,
    /** Automatic time, while the date and time are locked. */
    val autoTime: Boolean,
    /**
     * Automatic time zone, while the date and time are locked: the lock alone keeps whatever zone
     * the phone had, so one set by hand before it would stay (platform notes H8).
     */
    val autoTimeZone: Boolean = false,
    /** The Private DNS host to set; null: Belay sets none, and takes back the one it set. */
    val privateDns: String?,
    /** Null: no managed configuration for Chrome. */
    val chrome: ChromeConfig?,
    /** Factory reset protection accounts; null: no policy. */
    val frpAccounts: List<String>?,
    /** Play's allowed accounts (PlayAccounts); null: Belay sets none, and takes back what it set. */
    val playAccounts: List<String>? = null,
    /** The parent's words for blocked-app screens; null: Belay's own. */
    val supportMessage: String?,
    /** User apps waiting for a parent's decision, by package name. */
    val waiting: List<String>,
    /** Apps a parent blocked, by package name. */
    val blocked: List<String>,
    /** Browsers hidden because the policy says no browsers. */
    val hiddenBrowsers: List<String>,
    /** The pause in effect, if any. */
    val pause: WirePause?,
    /** Debugging is lifted until then, for repairs. */
    val maintenanceUntil: Long?,
    /**
     * When the plan next changes by the clock alone (a pause, maintenance or the recovery key's
     * repair access ends), or, with screen time, its next boundary (ScreenTimeEnforcement.merge).
     */
    val nextChangeAt: Long?,
    /** Belay's own words for what the policy asks and Belay won't or can't do. */
    val problems: List<String>,
    /** Phase 6: the recovery key opened repair access until then: debugging and factory reset aren't locked. */
    val recoveryUntil: Long? = null,
    /** The installed packages Belay never blocks, for the report (NeverBlocked.report). */
    val neverBlocked: List<String> = emptyList(),
    /** Phase 6: the update the policy offers. */
    val agentUpdate: WireAgentUpdate? = null,
    /** Why each package in [suspend] is held ([HoldReason], and screen time's codes), in name order. */
    val reasons: Map<String, List<String>> = emptyMap(),
    /** Phase 3: screen time now, for the report (Decision.status); null without screen time. */
    val screenTime: WireScreenTimeStatus? = null,
    /** Phase 11: the hand-over the policy asks for, as this build carries it out; null without one. */
    val handover: HandoverPlan? = null,
)

/**
 * Phase 11: a parent is handing the phone over (the policy's `handover`, docs/protocol.md "Off
 * belay"). Whatever the restrictions say, Belay then holds none of [LIFTS], no reset protection
 * policy and no allowed accounts for Play, and a release build clears that policy once
 * ([clearFrp]), even if it has no record of setting one: the kid resets the phone from Settings
 * and sets it up with their own account.
 */
data class HandoverPlan(
    /** The policy's handover.at: Belay carries out each hand-over once. */
    val at: Long,
    /** False on a debug build, which never sets reset protection, so never clears it either. */
    val clearFrp: Boolean,
) {
    companion object {
        /** Factory reset from Settings, Developer options and adb, and adding or removing accounts (Play's too). */
        val LIFTS: Set<Lock> = setOf(Lock.FACTORY_RESET, Lock.DEBUGGING, Lock.MODIFY_ACCOUNTS)
    }
}

/** Phase 11: what Belay did about reset protection for a hand-over. */
@Serializable
enum class HandoverFrp {
    /** It cleared the reset protection policy and told Play services (a release build). */
    CLEARED,

    /** A test build never sets reset protection, so it left it alone; a release build clears it here. */
    SKIPPED_DEBUG,
}

/** Phase 11: a hand-over Belay carried out (the policy's handover.at), and when. */
@Serializable
data class HandoverDone(val at: Long, val doneAt: Long, val frp: HandoverFrp)

/**
 * What Belay itself did, so it only ever undoes its own work: an app someone else suspended
 * stays suspended, a restriction Belay didn't add stays. Stored after every step.
 */
@Serializable
data class Applied(
    /** The policy version applied; null before the first. */
    val policyVersion: Int? = null,
    /** When that version was first applied. */
    val appliedAt: Long? = null,
    val suspended: Set<String> = emptySet(),
    val hidden: Set<String> = emptySet(),
    val locks: Set<Lock> = emptySet(),
    val autoTime: Boolean = false,
    /** Belay keeps the time zone automatic (false in a record an older Belay stored, so an update sets it). */
    val autoTimeZone: Boolean = false,
    val chrome: ChromeConfig? = null,
    val frpAccounts: List<String>? = null,
    /** Play's allowed accounts as Belay set them, or null: Belay set none. */
    val playAccounts: List<String>? = null,
    /** The short support message Belay set, or null. */
    val supportMessage: String? = null,
    /**
     * The browsers known when Belay last hid browsers. A hidden app no longer answers
     * Android's browser test, so this keeps it counted as one.
     */
    val browsers: Set<String> = emptySet(),
    /** The plan's problems and what failed, for the enforcement report. */
    val problems: List<String> = emptyList(),
    /** The SIM Belay saw last, to report a change (core's SimRules). */
    val sim: SimWatch = SimWatch(),
    /** The installed packages Belay never blocks, as the last plan resolved them (reported). */
    val neverBlocked: List<String> = emptyList(),
    /** Phase 6: the update the applied policy offers, for the report's agent_update. */
    val agentUpdate: WireAgentUpdate? = null,
    /** Why Belay holds each package in [suspended], as the plan said ([HoldReason], screen time's codes). */
    val reasons: Map<String, List<String>> = emptyMap(),
    /** Phase 3: screen time as of the last step, for the report's screen_time. */
    val screenTime: WireScreenTimeStatus? = null,
    /** Phase 11: the hand-over Belay carried out; null without one (or until it has). */
    val handover: HandoverDone? = null,
)

/** What to change on the phone to get from [Applied] to an [EnforcementPlan]. */
data class EnforcementChanges(
    val suspend: Set<String> = emptySet(),
    val unsuspend: Set<String> = emptySet(),
    val hide: Set<String> = emptySet(),
    val unhide: Set<String> = emptySet(),
    val lock: Set<Lock> = emptySet(),
    val unlock: Set<Lock> = emptySet(),
    /** True: turn automatic time on; false: hand it back; null: leave it. */
    val autoTime: Boolean? = null,
    /** The same for the time zone. */
    val autoTimeZone: Boolean? = null,
    val chrome: Setting<ChromeConfig>? = null,
    val frpAccounts: Setting<List<String>>? = null,
    /** Play's allowed accounts: set them, or take back Belay's own. */
    val playAccounts: Setting<List<String>>? = null,
) {
    val none: Boolean
        get() = suspend.isEmpty() && unsuspend.isEmpty() && hide.isEmpty() && unhide.isEmpty() &&
            lock.isEmpty() && unlock.isEmpty() && autoTime == null && autoTimeZone == null && chrome == null &&
            frpAccounts == null && playAccounts == null
}

/** A setting Belay manages as one value: set it to [Set.value], or take back its own. */
sealed interface Setting<out T> {
    data class Set<T>(val value: T) : Setting<T>

    data object Clear : Setting<Nothing>
}

/** What failed while applying [EnforcementChanges]; everything else took effect. */
data class ApplyOutcome(
    val failedSuspend: Set<String> = emptySet(),
    val failedUnsuspend: Set<String> = emptySet(),
    val failedHide: Set<String> = emptySet(),
    val failedUnhide: Set<String> = emptySet(),
    val failedLock: Set<Lock> = emptySet(),
    val failedUnlock: Set<Lock> = emptySet(),
    val autoTimeFailed: Boolean = false,
    val autoTimeZoneFailed: Boolean = false,
    val chromeFailed: Boolean = false,
    val frpFailed: Boolean = false,
    val playFailed: Boolean = false,
    val problems: List<String> = emptyList(),
)

/** What the phone says is in effect, for the packages and locks that were checked. */
data class ActualState(
    val checkedPackages: Set<String> = emptySet(),
    val suspended: Set<String> = emptySet(),
    val hidden: Set<String> = emptySet(),
    val checkedLocks: Set<Lock> = emptySet(),
    val locks: Set<Lock> = emptySet(),
)

object Enforcement {
    /** At most this many problems of this many characters go to the server (protocol). */
    const val MAX_PROBLEMS = WireLimits.MAX_PROBLEMS
    const val MAX_PROBLEM = WireLimits.MAX_PROBLEM
    const val MAX_SUPPORT_MESSAGE = 200

    /** The SDK_INT_FULL encoding of a major version, like 3_700_000 for 37. */
    fun sdkFull(major: Int, minor: Int = 0): Int = major * 100_000 + minor

    data class Input(
        val policy: WirePolicy,
        /** Every installed package, hidden ones included. */
        val apps: Map<String, PackageRecord>,
        val roles: PhoneRoles,
        val applied: Applied,
        /** Debug builds never lock factory reset or debugging, nor set reset protection. */
        val debugBuild: Boolean,
        /** Build.VERSION.SDK_INT_FULL. */
        val sdkFull: Int,
        val now: Long,
        /**
         * Users and profiles besides the phone's own (DevicePolicyManager.getSecondaryUsers):
         * none on a Belay phone, but Android 17's own Parental Controls make a hidden profile
         * even with DISALLOW_ADD_USER set.
         */
        val otherUsers: Int = 0,
        /**
         * Phase 6: the recovery key opened repair access until then (RecoveryRules.openUntil):
         * like maintenance, but both debugging and factory reset are lifted.
         */
        val recoveryUntil: Long? = null,
    )

    /**
     * The problem for [Input.otherUsers]. The server looks for the words "another user or
     * profile" (it flags them as tampering), so they stay exactly so.
     */
    const val OTHER_USERS_PROBLEM =
        "This phone has another user or profile (Android's own Parental Controls make one). " +
            "It can lift Belay's suspensions, and Private DNS can't be set while it's there."

    fun plan(input: Input): EnforcementPlan {
        val policy = input.policy
        val apps = input.apps
        val now = input.now
        val problems = mutableListOf<String>()
        if (input.otherUsers > 0) problems += OTHER_USERS_PROBLEM
        val protected = NeverBlocked.of(input.roles, apps, input.applied.hidden)

        // A parent's decisions; the last one for a package counts.
        val decisions = LinkedHashMap<String, WireAppState>()
        policy.apps.decisions.forEach { decisions[it.packageName] = it.state }

        val blocked = sortedSetOf<String>()
        for ((name, state) in decisions) {
            if (state != WireAppState.BLOCKED || name !in apps) continue
            val why = protected[name]
            if (why == null) blocked += name else problems += "$name can't be blocked: ${why.words}."
        }

        val hiddenBrowsers = sortedSetOf<String>()
        if (policy.web.hideBrowsers) {
            for (name in (input.roles.browsers + input.applied.browsers).filter { it in apps }.sorted()) {
                val why = protected[name]
                if (why == null) hiddenBrowsers += name else problems += "$name can't be hidden as a browser: ${why.words}."
            }
        }

        // New user apps without a decision wait for a parent. System apps never wait.
        val waiting = if (policy.apps.newApps == WireNewApps.ASK) {
            apps.values
                .filter { !it.system && it.packageName !in decisions && it.packageName !in protected }
                .map { it.packageName }
                .sorted()
        } else {
            emptyList()
        }

        // Phase 3: apps the family exempted from screen time are never paused either.
        val exempt = policy.screenTime?.exempt.orEmpty().toSet()
        val pause = policy.pause?.takeIf { it.until == null || it.until > now }
        val paused = if (pause == null) {
            emptySet()
        } else {
            apps.values
                .filter {
                    it.launchable && it.packageName !in protected && it.packageName !in input.roles.pauseExempt &&
                        it.packageName !in exempt
                }
                .mapTo(HashSet()) { it.packageName }
        }

        val maintenanceUntil = policy.maintenanceUntil?.takeIf { it > now }
        val recoveryUntil = input.recoveryUntil?.takeIf { it > now }
        // Phase 11: while the phone is handed over, none of the hand-over's locks hold, whatever the restrictions say.
        val handover = policy.handover?.let { HandoverPlan(it.at, clearFrp = !input.debugBuild) }
        val restrictions = if (handover == null) {
            policy.restrictions
        } else {
            policy.restrictions.copy(factoryReset = false, debugging = false, modifyAccounts = false)
        }
        // Phase 4: keep_on (with a mode on) and lost mode keep location on: the kid can't turn it off.
        val locks = locks(restrictions, input.debugBuild, maintenanceUntil != null, recoveryUntil != null, input.sdkFull, problems) +
            listOfNotNull(Lock.CONFIG_LOCATION.takeIf { LocationRules.keepOn(policy.location) })

        val privateDns = policy.web.privateDns?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }?.let { host ->
            if (Hostnames.valid(host)) host else null.also { problems += "Private DNS: \"$host\" isn't a host name." }
        }

        val frpAccounts = policy.frpAccounts.map { it.trim() }.filter { it.isNotEmpty() }.distinct().takeIf { it.isNotEmpty() && handover == null }
        if (frpAccounts != null && input.debugBuild) {
            problems += "This is a test build of Belay: it never sets factory reset protection."
        }
        // While the phone is handed over, Play may use the kid's own account, whatever the policy says.
        val playAccounts = if (handover == null) PlayAccounts.plan(policy.playAccounts, problems) else null

        val nextChangeAt = listOfNotNull(
            pause?.until,
            maintenanceUntil?.takeIf { restrictions.debugging && !input.debugBuild },
            recoveryUntil?.takeIf { (restrictions.debugging || restrictions.factoryReset) && !input.debugBuild },
        ).minOrNull()

        val hide = blocked + hiddenBrowsers
        val reasons = sortedMapOf<String, MutableList<String>>()
        fun hold(names: Collection<String>, why: String) = names.forEach { reasons.getOrPut(it) { mutableListOf() } += why }
        hold(blocked, HoldReason.BLOCKED)
        hold(hiddenBrowsers, HoldReason.NO_BROWSERS)
        hold(waiting, HoldReason.WAITING)
        hold(paused, HoldReason.PAUSED)
        return EnforcementPlan(
            version = policy.version,
            suspend = hide + waiting + paused,
            hide = hide,
            locks = locks,
            autoTime = Lock.CONFIG_DATE_TIME in locks,
            autoTimeZone = Lock.CONFIG_DATE_TIME in locks,
            privateDns = privateDns,
            chrome = policy.web.chrome?.let(ChromeConfig::of),
            frpAccounts = frpAccounts.takeUnless { input.debugBuild },
            playAccounts = playAccounts,
            supportMessage = policy.supportMessage?.trim()?.take(MAX_SUPPORT_MESSAGE)?.takeIf { it.isNotEmpty() },
            waiting = waiting,
            blocked = blocked.toList(),
            hiddenBrowsers = hiddenBrowsers.toList(),
            pause = pause,
            maintenanceUntil = maintenanceUntil,
            nextChangeAt = nextChangeAt,
            problems = problems,
            recoveryUntil = recoveryUntil,
            neverBlocked = NeverBlocked.report(protected, apps),
            agentUpdate = policy.agentUpdate,
            reasons = reasons,
            handover = handover,
        )
    }

    private fun locks(
        r: WireRestrictions,
        debugBuild: Boolean,
        maintenance: Boolean,
        recovery: Boolean,
        sdkFull: Int,
        problems: MutableList<String>,
    ): Set<Lock> {
        val wanted = LinkedHashSet<Lock>()
        if (r.safeBoot) wanted += Lock.SAFE_BOOT
        if (r.addUser) wanted += listOf(Lock.ADD_USER, Lock.USER_SWITCH)
        if (r.unknownSources) wanted += listOf(Lock.UNKNOWN_SOURCES, Lock.UNKNOWN_SOURCES_REGISTERED_STORES)
        if (r.configVpn) wanted += Lock.CONFIG_VPN
        if (r.configPrivateDns) wanted += Lock.CONFIG_PRIVATE_DNS
        if (r.configDateTime) wanted += Lock.CONFIG_DATE_TIME
        if (r.configDefaultApps) wanted += Lock.CONFIG_DEFAULT_APPS
        if (r.modifyAccounts) wanted += Lock.MODIFY_ACCOUNTS
        if (r.sim) wanted += Lock.SIM
        if (r.factoryReset) wanted += Lock.FACTORY_RESET
        if (r.debugging) wanted += Lock.DEBUGGING
        if (debugBuild && (Lock.FACTORY_RESET in wanted || Lock.DEBUGGING in wanted)) {
            problems += "This is a test build of Belay: it never locks factory reset or debugging."
            wanted -= setOf(Lock.FACTORY_RESET, Lock.DEBUGGING)
        }
        if (maintenance) wanted -= Lock.DEBUGGING
        // The recovery key opens both, so a phone whose server is gone can be repaired or reset.
        if (recovery) wanted -= setOf(Lock.DEBUGGING, Lock.FACTORY_RESET)
        val unavailable = wanted.filter { it.minSdkFull > sdkFull }
        // The registered-stores key only exists to close a gap 37.2 opened: nothing to report before it.
        unavailable.filter { it != Lock.UNKNOWN_SOURCES_REGISTERED_STORES }.forEach {
            problems += "This version of Android can't lock ${lockWords(it)}."
        }
        return wanted - unavailable.toSet()
    }

    private fun lockWords(lock: Lock): String = when (lock) {
        Lock.CONFIG_DEFAULT_APPS -> "default apps"
        Lock.SIM -> "adding eSIMs"
        Lock.CONFIG_LOCATION -> "location on"
        else -> lock.name.lowercase().replace('_', ' ')
    }

    /**
     * The changes from [applied] to [plan]. Only what Belay applied is ever undone: an app
     * that is suspended but not in [Applied.suspended] is someone else's, and stays.
     */
    fun changes(plan: EnforcementPlan, applied: Applied): EnforcementChanges = EnforcementChanges(
        suspend = plan.suspend - applied.suspended,
        unsuspend = applied.suspended - plan.suspend,
        hide = plan.hide - applied.hidden,
        unhide = applied.hidden - plan.hide,
        lock = plan.locks - applied.locks,
        unlock = applied.locks - plan.locks,
        autoTime = plan.autoTime.takeIf { it != applied.autoTime },
        autoTimeZone = plan.autoTimeZone.takeIf { it != applied.autoTimeZone },
        chrome = when {
            plan.chrome == applied.chrome -> null
            plan.chrome == null -> Setting.Clear
            else -> Setting.Set(plan.chrome)
        },
        frpAccounts = when {
            // Phase 11: a release build clears reset protection once per hand-over, record or not.
            plan.handover?.clearFrp == true && applied.handover?.at != plan.handover.at -> Setting.Clear
            plan.frpAccounts == applied.frpAccounts -> null
            plan.frpAccounts == null -> Setting.Clear
            else -> Setting.Set(plan.frpAccounts)
        },
        playAccounts = when {
            plan.playAccounts == applied.playAccounts -> null
            plan.playAccounts == null -> Setting.Clear
            else -> Setting.Set(plan.playAccounts)
        },
    )

    /**
     * What Belay holds after applying [changes]: what succeeded, and what it still holds
     * because taking it back failed. [plan]'s problems and the failures become the report.
     */
    fun after(applied: Applied, plan: EnforcementPlan, changes: EnforcementChanges, outcome: ApplyOutcome, now: Long): Applied {
        val problems = (plan.problems + outcome.problems).map { it.take(MAX_PROBLEM) }.distinct().take(MAX_PROBLEMS)
        val suspended = applied.suspended - (changes.unsuspend - outcome.failedUnsuspend) + (changes.suspend - outcome.failedSuspend)
        return Applied(
            policyVersion = plan.version,
            appliedAt = if (applied.policyVersion == plan.version && applied.appliedAt != null) applied.appliedAt else now,
            suspended = suspended,
            hidden = applied.hidden - (changes.unhide - outcome.failedUnhide) + (changes.hide - outcome.failedHide),
            locks = applied.locks - (changes.unlock - outcome.failedUnlock) + (changes.lock - outcome.failedLock),
            autoTime = if (changes.autoTime == null || outcome.autoTimeFailed) applied.autoTime else changes.autoTime,
            autoTimeZone = if (changes.autoTimeZone == null || outcome.autoTimeZoneFailed) applied.autoTimeZone else changes.autoTimeZone,
            chrome = settle(applied.chrome, changes.chrome, outcome.chromeFailed),
            frpAccounts = settle(applied.frpAccounts, changes.frpAccounts, outcome.frpFailed),
            playAccounts = settle(applied.playAccounts, changes.playAccounts, outcome.playFailed),
            supportMessage = applied.supportMessage,
            browsers = if (plan.hiddenBrowsers.isEmpty()) emptySet() else plan.hiddenBrowsers.toSet(),
            problems = problems,
            sim = applied.sim,
            neverBlocked = plan.neverBlocked,
            agentUpdate = plan.agentUpdate,
            // A package still held only because letting it go failed keeps the reasons it had.
            reasons = suspended.associateWith { plan.reasons[it] ?: applied.reasons[it].orEmpty() }.toSortedMap(),
            screenTime = plan.screenTime,
            handover = handoverAfter(applied, plan, changes, outcome, now),
        )
    }

    /**
     * Phase 11: the hand-over Belay has carried out. A release build's is done once reset protection
     * is cleared (a failure is tried again at the next step); a debug build's at once, leaving it alone.
     */
    private fun handoverAfter(applied: Applied, plan: EnforcementPlan, changes: EnforcementChanges, outcome: ApplyOutcome, now: Long): HandoverDone? {
        val wanted = plan.handover ?: return null
        applied.handover?.takeIf { it.at == wanted.at }?.let { return it }
        return when {
            !wanted.clearFrp -> HandoverDone(wanted.at, now, HandoverFrp.SKIPPED_DEBUG)
            changes.frpAccounts == Setting.Clear && !outcome.frpFailed -> HandoverDone(wanted.at, now, HandoverFrp.CLEARED)
            else -> null
        }
    }

    private fun <T> settle(before: T?, change: Setting<T>?, failed: Boolean): T? = when {
        change == null || failed -> before
        change is Setting.Set -> change.value
        else -> null
    }

    /**
     * Forgets what no longer holds: packages that are gone (uninstalling clears a suspension),
     * and, for what [actual] checked, anything the phone no longer has. The next plan then
     * applies it again. Returns the packages that went, so their policies can be tidied away.
     */
    fun reconcile(applied: Applied, installed: Set<String>, actual: ActualState): Pair<Applied, Set<String>> {
        val gone = (applied.suspended + applied.hidden) - installed
        fun kept(names: Set<String>, inEffect: Set<String>) =
            names.filter { it in installed && (it !in actual.checkedPackages || it in inEffect) }.toSet()
        val next = applied.copy(
            suspended = kept(applied.suspended, actual.suspended),
            hidden = kept(applied.hidden, actual.hidden),
            locks = applied.locks.filter { it !in actual.checkedLocks || it in actual.locks }.toSet(),
        )
        return next to gone
    }

    /**
     * The enforcement report for the server (protocol, "Enforcement"); null before the first
     * policy. Phase 6 and 10 add what other parts of Belay keep: the update's state
     * (AgentUpdates.report), the recovery key's last use and the commands' last results.
     */
    fun report(
        applied: Applied,
        agentUpdate: WireAgentUpdateState? = null,
        recovery: WireRecoveryUse? = null,
        commands: List<WireCommandResult> = emptyList(),
        location: WireLocationStatus? = null,
        calls: WireCallsStatus? = null,
        networkLog: WireNetworkLogStatus? = null,
        mobileData: WireMobileDataStatus? = null,
    ): WireEnforcement? {
        val version = applied.policyVersion ?: return null
        return WireEnforcement(
            policyVersion = version,
            appliedAt = applied.appliedAt,
            suspendedCount = (applied.suspended + applied.hidden).size,
            problems = applied.problems.map { it.take(MAX_PROBLEM) }.take(MAX_PROBLEMS),
            agentUpdate = agentUpdate,
            recovery = recovery,
            commands = commands.take(WireLimits.MAX_COMMAND_RESULTS),
            neverBlocked = applied.neverBlocked.take(WireLimits.MAX_NEVER_BLOCKED),
            screenTime = applied.screenTime,
            // Phase 4: whether Belay can take a fix; null while location is off.
            location = location,
            // Phase 5: whether Belay is the default dialer; null while calls is off.
            calls = calls,
            // Phase 3: whether Android logs (and paused it); null while network logging is off.
            networkLog = networkLog,
            // Phase 13: the apps Android keeps off mobile data for Belay; null while there are none to keep.
            mobileData = mobileData,
        )
    }
}

object Hostnames {
    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

    /** A DNS host name: dot-separated labels of letters, digits and hyphens, at most 253 characters. */
    fun valid(host: String): Boolean {
        if (host.length > 253 || host.endsWith('.') || !host.contains('.')) return false
        val labels = host.split('.')
        // An IP address isn't a Private DNS host name.
        if (labels.all { it.toIntOrNull() != null }) return false
        return labels.all { LABEL.matches(it) }
    }
}
