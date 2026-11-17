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

@Serializable
data class WirePolicy(val version: Int)

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

fun AppChange.toWire(): WireEvent = WireEvent(
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
)
