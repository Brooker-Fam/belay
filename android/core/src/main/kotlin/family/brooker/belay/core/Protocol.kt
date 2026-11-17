package family.brooker.belay.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The device API (docs/protocol.md). The server's Zod schemas mirror these types exactly
 * and reject unknown fields, so change both together.
 */
object Wire {
    /** For requests: every field written, nulls left out. For responses: unknown fields ignored. */
    val json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }
}

@Serializable
data class WireVersion(val name: String? = null, val code: Long)

@Serializable
enum class WireChangeKind {
    @SerialName("installed") INSTALLED,
    @SerialName("updated") UPDATED,
    @SerialName("removed") REMOVED,
    @SerialName("reinstalled") REINSTALLED,
}

@Serializable
enum class WireDetection {
    @SerialName("broadcast") BROADCAST,
    @SerialName("changed_packages") CHANGED_PACKAGES,
    @SerialName("snapshot") SNAPSHOT,
}

@Serializable
data class WireEvent(
    val id: String,
    val kind: WireChangeKind,
    @SerialName("package") val packageName: String,
    val label: String,
    val from: WireVersion? = null,
    val to: WireVersion? = null,
    @SerialName("happened_at") val happenedAt: Long? = null,
    @SerialName("detected_at") val detectedAt: Long,
    val detection: WireDetection,
    /**
     * The package as it is now, for installed, updated and reinstalled events, so the server
     * has its source and permissions at once instead of at the next inventory. Null for removals.
     */
    val app: WirePackage? = null,
)

@Serializable
data class WireInstaller(
    val installing: String? = null,
    val initiating: String? = null,
    val originating: String? = null,
    @SerialName("update_owner") val updateOwner: String? = null,
    @SerialName("package_source") val packageSource: Int? = null,
)

@Serializable
data class WirePackage(
    @SerialName("package") val packageName: String,
    val label: String,
    @SerialName("version_name") val versionName: String? = null,
    @SerialName("version_code") val versionCode: Long,
    @SerialName("first_install_time") val firstInstallTime: Long,
    @SerialName("last_update_time") val lastUpdateTime: Long,
    val system: Boolean,
    @SerialName("updated_system") val updatedSystem: Boolean,
    val enabled: Boolean,
    val launchable: Boolean,
    @SerialName("target_sdk") val targetSdk: Int,
    val category: Int,
    val source: String,
    val installer: WireInstaller,
    val permissions: List<String>,
)

@Serializable
data class WirePermission(
    val name: String,
    val granted: Boolean,
    @SerialName("fixed_by_policy") val fixedByPolicy: Boolean,
)

@Serializable
data class WireHealth(
    @SerialName("device_owner") val deviceOwner: Boolean,
    @SerialName("uninstall_blocked") val uninstallBlocked: Boolean? = null,
    @SerialName("battery_exempt") val batteryExempt: Boolean,
    @SerialName("usage_access") val usageAccess: Boolean,
    @SerialName("notifications_shown") val notificationsShown: Boolean,
    val permissions: List<WirePermission>,
    @SerialName("standby_bucket") val standbyBucket: Int,
    @SerialName("background_restricted") val backgroundRestricted: Boolean,
    @SerialName("service_running") val serviceRunning: Boolean,
    @SerialName("test_only") val testOnly: Boolean,
)

@Serializable
data class WireDevice(
    val manufacturer: String,
    val model: String,
    @SerialName("android_release") val androidRelease: String,
    val sdk: Int,
    @SerialName("sdk_full") val sdkFull: String,
    @SerialName("security_patch") val securityPatch: String,
    @SerialName("agent_version_name") val agentVersionName: String,
    @SerialName("agent_version_code") val agentVersionCode: Long,
    @SerialName("boot_count") val bootCount: Int? = null,
    @SerialName("last_boot_at") val lastBootAt: Long,
    val timezone: String,
    @SerialName("device_time") val deviceTime: Long,
    @SerialName("battery_percent") val batteryPercent: Int? = null,
    val charging: Boolean? = null,
    @SerialName("storage_free_bytes") val storageFreeBytes: Long? = null,
    @SerialName("storage_total_bytes") val storageTotalBytes: Long? = null,
    val health: WireHealth,
    /** Phase 2: which policy the phone enforces, and what it couldn't. Null before the first policy. */
    val enforcement: WireEnforcement? = null,
)

/** What the phone enforces now (docs/protocol.md, "Enforcement"). */
@Serializable
data class WireEnforcement(
    /** The policy version the phone has applied. */
    @SerialName("policy_version") val policyVersion: Int,
    @SerialName("applied_at") val appliedAt: Long? = null,
    /** Apps Belay holds suspended or hidden right now (waiting, blocked or paused). */
    @SerialName("suspended_count") val suspendedCount: Int = 0,
    /** Belay's own words for what it couldn't do, like "Private DNS: the host didn't answer". */
    val problems: List<String> = emptyList(),
)

@Serializable
data class EnrollRequest(val code: String, val device: WireDevice)

@Serializable
data class EnrollResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_name") val deviceName: String,
    val token: String,
    @SerialName("server_time") val serverTime: Long,
)

@Serializable
data class CheckinRequest(val status: WireDevice)

// ── Phase 2: the policy the phone enforces (docs/protocol.md, "Policy") ──
// Every field has a default that enforces nothing, so a Phase 1 server's {"version":0}
// still parses, and a field a newer server adds is ignored until the agent knows it.

@Serializable
enum class WireNewApps {
    /** New apps run at once (Phase 1 behavior). */
    @SerialName("allow") ALLOW,

    /** Each new app is suspended the moment it installs, until a parent approves it. */
    @SerialName("ask") ASK,
}

@Serializable
enum class WireAppState {
    @SerialName("allowed") ALLOWED,

    /** Hidden and suspended: a hard block. */
    @SerialName("blocked") BLOCKED,
}

@Serializable
data class WireAppDecision(
    @SerialName("package") val packageName: String,
    val state: WireAppState,
)

@Serializable
data class WireAppPolicy(
    @SerialName("new_apps") val newApps: WireNewApps = WireNewApps.ALLOW,
    /** A parent's decision per package. With new_apps = ask, a user app not listed here is waiting. */
    val decisions: List<WireAppDecision> = emptyList(),
)

/** The phone is paused: every app but the exempt ones (phone, texts, Belay...) is suspended. */
@Serializable
data class WirePause(
    /** Paused until then; null: until a parent resumes it. */
    val until: Long? = null,
    /** The parent's words, shown to the kid. */
    val note: String? = null,
)

/**
 * Settings the kid can't change: true means locked. factory_reset and debugging can lock a
 * phone for good: the server only sets them when a parent turns them on, and debug builds
 * never apply them (docs/protocol.md).
 */
@Serializable
data class WireRestrictions(
    @SerialName("safe_boot") val safeBoot: Boolean = false,
    @SerialName("add_user") val addUser: Boolean = false,
    @SerialName("unknown_sources") val unknownSources: Boolean = false,
    @SerialName("config_vpn") val configVpn: Boolean = false,
    @SerialName("config_private_dns") val configPrivateDns: Boolean = false,
    @SerialName("config_date_time") val configDateTime: Boolean = false,
    @SerialName("config_default_apps") val configDefaultApps: Boolean = false,
    @SerialName("modify_accounts") val modifyAccounts: Boolean = false,
    val sim: Boolean = false,
    @SerialName("factory_reset") val factoryReset: Boolean = false,
    val debugging: Boolean = false,
)

@Serializable
data class WireChromePolicy(
    /** false: no incognito tabs. */
    val incognito: Boolean = false,
    @SerialName("safe_search") val safeSearch: Boolean = true,
    /** off, moderate or strict. */
    @SerialName("youtube_restrict") val youtubeRestrict: String = "strict",
    /** Google's filter for adult sites. */
    @SerialName("safe_sites") val safeSites: Boolean = true,
    @SerialName("allow_downloads") val allowDownloads: Boolean = false,
    /** Non-null: only these sites open (allowlist mode). URL patterns as Chrome takes them. */
    @SerialName("url_allowlist") val urlAllowlist: List<String>? = null,
    @SerialName("url_blocklist") val urlBlocklist: List<String> = emptyList(),
)

@Serializable
data class WireWebPolicy(
    /** A Private DNS host, like family-filter-dns.cleanbrowsing.org; null leaves the phone's setting alone. */
    @SerialName("private_dns") val privateDns: String? = null,
    /** Chrome's managed configuration; null sets none. */
    val chrome: WireChromePolicy? = null,
    /** No browser at all: browsers are hidden. */
    @SerialName("hide_browsers") val hideBrowsers: Boolean = false,
)

@Serializable
enum class WireRequestStatus {
    @SerialName("pending") PENDING,
    @SerialName("approved") APPROVED,
    @SerialName("declined") DECLINED,

    /** "Let's talk": no decision yet, and the kid knows a parent wants to talk about it. */
    @SerialName("talk") TALK,
}

/** A request the kid made, as the server answered it. */
@Serializable
data class WireRequestAnswer(
    val id: String,
    val status: WireRequestStatus,
    /** The parent's words, shown to the kid. */
    val note: String? = null,
    @SerialName("answered_at") val answeredAt: Long? = null,
    /** The parent's name. */
    @SerialName("answered_by") val answeredBy: String? = null,
)

@Serializable
data class WirePolicy(
    val version: Int,
    @SerialName("issued_at") val issuedAt: Long? = null,
    val apps: WireAppPolicy = WireAppPolicy(),
    /** Null: not paused. */
    val pause: WirePause? = null,
    val restrictions: WireRestrictions = WireRestrictions(),
    val web: WireWebPolicy = WireWebPolicy(),
    /** Until then, the debugging restriction is lifted so adb works for repairs. */
    @SerialName("maintenance_until") val maintenanceUntil: Long? = null,
    /** Google account ids allowed to set the phone up after a factory reset; empty: no policy. */
    @SerialName("frp_accounts") val frpAccounts: List<String> = emptyList(),
    /** The parent's short words for blocked-app screens, like "Ask Mom or Dad". */
    @SerialName("support_message") val supportMessage: String? = null,
    /** The kid's requests of the last 30 days, newest first, with their answers. */
    val requests: List<WireRequestAnswer> = emptyList(),
)

@Serializable
data class PolicyResponse(
    @SerialName("server_time") val serverTime: Long,
    val policy: WirePolicy,
)

@Serializable
enum class WireRequestKind {
    /** Let me use this app (a new one waiting, or a blocked one). */
    @SerialName("app") APP,
}

/** Something the kid asks a parent for, from Belay's screen. */
@Serializable
data class WireRequest(
    /** UUID made on the phone; sending it again updates the reason while it's pending. */
    val id: String,
    val kind: WireRequestKind,
    @SerialName("package") val packageName: String,
    /** From the app's developer: untrusted. */
    val label: String,
    /** The kid's own words, at most 500 characters: untrusted. */
    val reason: String? = null,
    @SerialName("asked_at") val askedAt: Long,
)

@Serializable
data class RequestsRequest(val requests: List<WireRequest>)

@Serializable
data class RequestsResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
)

@Serializable
data class CheckinResponse(
    @SerialName("server_time") val serverTime: Long,
    val policy: WirePolicy,
)

@Serializable
data class InventoryRequest(
    @SerialName("snapshot_id") val snapshotId: String,
    @SerialName("taken_at") val takenAt: Long,
    @SerialName("boot_count") val bootCount: Int? = null,
    val device: WireDevice,
    val packages: List<WirePackage>,
)

@Serializable
data class InventoryResponse(
    @SerialName("server_time") val serverTime: Long,
    val duplicate: Boolean = false,
    val backfilled: Int = 0,
)

@Serializable
data class EventsRequest(val events: List<WireEvent>)

@Serializable
data class EventsResponse(
    @SerialName("server_time") val serverTime: Long,
    val accepted: Int,
    val duplicates: Int,
)

@Serializable
data class WireError(
    val error: String,
    @SerialName("error_description") val description: String? = null,
)

/** Limits the server enforces (docs/protocol.md); the agent batches below them. */
object WireLimits {
    const val MAX_PACKAGES = 5000
    const val MAX_EVENTS_PER_REQUEST = 1000
    const val MAX_LABEL = 200
    const val MAX_REQUESTS_PER_REQUEST = 100
    const val MAX_REASON = 500
    const val MAX_PROBLEMS = 20
    const val MAX_PROBLEM = 200
}

fun PackageRecord.toWire(): WirePackage = WirePackage(
    packageName = packageName,
    label = label.take(WireLimits.MAX_LABEL),
    versionName = versionName?.take(WireLimits.MAX_LABEL),
    versionCode = versionCode,
    firstInstallTime = firstInstallTime,
    lastUpdateTime = lastUpdateTime,
    system = system,
    updatedSystem = updatedSystem,
    enabled = enabled,
    launchable = launchable,
    targetSdk = targetSdk,
    category = category,
    source = source.wire,
    installer = WireInstaller(
        installing = installer.installing,
        initiating = installer.initiating,
        originating = installer.originating,
        updateOwner = installer.updateOwner,
        packageSource = installer.packageSource,
    ),
    permissions = permissions,
)

/**
 * [record] is the package as the scan that found this change read it; it becomes the
 * event's `app`, except for a removal, which has none.
 */
fun AppChange.toWire(record: PackageRecord? = null): WireEvent = WireEvent(
    id = id,
    kind = when (kind) {
        ChangeKind.INSTALLED -> WireChangeKind.INSTALLED
        ChangeKind.UPDATED -> WireChangeKind.UPDATED
        ChangeKind.REMOVED -> WireChangeKind.REMOVED
        ChangeKind.REINSTALLED -> WireChangeKind.REINSTALLED
    },
    packageName = packageName,
    label = label.take(WireLimits.MAX_LABEL),
    from = from?.let { WireVersion(it.name?.take(WireLimits.MAX_LABEL), it.code) },
    to = to?.let { WireVersion(it.name?.take(WireLimits.MAX_LABEL), it.code) },
    happenedAt = happenedAt,
    detectedAt = detectedAt,
    detection = when (detection) {
        Detection.BROADCAST -> WireDetection.BROADCAST
        Detection.CHANGED_PACKAGES -> WireDetection.CHANGED_PACKAGES
        Detection.SNAPSHOT -> WireDetection.SNAPSHOT
    },
    app = if (kind == ChangeKind.REMOVED) null else record?.takeIf { it.packageName == packageName }?.toWire(),
)
