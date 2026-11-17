package family.brooker.belay.health

import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import family.brooker.belay.BuildConfig
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.DataCategories
import family.brooker.belay.service.BelayService
import family.brooker.belay.service.ManagedNotice

/** [fixedByPolicy]: granted or denied by Belay's own device-owner policy, so Settings can't change it. */
data class PermissionHealth(val name: String, val granted: Boolean, val fixedByPolicy: Boolean)

data class PhoneFacts(
    val manufacturer: String,
    val model: String,
    val androidRelease: String,
    /** "37" or "37.2" (minor SDK versions exist from API 36). */
    val sdk: String,
    val securityPatch: String,
)

/** The agent's own health, and basic phone facts (data category [DataCategories.DEVICE_STATUS]). */
data class Health(
    val deviceOwner: Boolean,
    /** Null when Belay isn't device owner: only an admin can ask. */
    val uninstallBlocked: Boolean?,
    val notificationsShown: Boolean,
    val permissions: List<PermissionHealth>,
    val batteryExempt: Boolean,
    val usageAccess: Boolean,
    /** UsageStatsManager standby bucket: 5 is "exempted", 10 "active" ... 45 "restricted". */
    val standbyBucket: Int,
    val backgroundRestricted: Boolean,
    val serviceRunningSince: Long?,
    val testOnly: Boolean,
    val bootCount: Int?,
    val lastBootAt: Long,
    val phone: PhoneFacts,
    val agentVersion: String,
)

class HealthReader(context: Context) {
    private val app = context.applicationContext

    fun read(): Health {
        val pkg = app.packageName
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(app)
        val owner = dpm.isDeviceOwnerApp(pkg)
        val nm = app.getSystemService(NotificationManager::class.java)
        val channel = nm.getNotificationChannel(ManagedNotice.CHANNEL_ID)
        val ops = app.getSystemService(AppOpsManager::class.java)
        return Health(
            deviceOwner = owner,
            uninstallBlocked = if (owner) dpm.isUninstallBlocked(admin, pkg) else null,
            notificationsShown = nm.areNotificationsEnabled() &&
                channel != null && channel.importance != NotificationManager.IMPORTANCE_NONE,
            // Every runtime permission Belay declares, CAMERA included: it is never granted by
            // policy, and denied by policy except while the enrollment screen scans.
            permissions = DeviceOwnerSetup.declaredRuntimePermissions(app).map { name ->
                PermissionHealth(
                    name = name.substringAfterLast('.'),
                    granted = app.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED,
                    fixedByPolicy = owner && dpm.getPermissionGrantState(admin, pkg, name) !=
                        DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT,
                )
            },
            batteryExempt = app.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(pkg),
            usageAccess = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), pkg) ==
                AppOpsManager.MODE_ALLOWED,
            standbyBucket = app.getSystemService(UsageStatsManager::class.java).appStandbyBucket,
            backgroundRestricted = app.getSystemService(ActivityManager::class.java).isBackgroundRestricted,
            serviceRunningSince = BelayService.runningSince,
            testOnly = app.applicationInfo.flags and ApplicationInfo.FLAG_TEST_ONLY != 0,
            bootCount = Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 },
            lastBootAt = System.currentTimeMillis() - SystemClock.elapsedRealtime(),
            phone = PhoneFacts(
                manufacturer = Build.MANUFACTURER,
                model = Build.MODEL,
                androidRelease = Build.VERSION.RELEASE,
                sdk = sdkString(),
                securityPatch = Build.VERSION.SECURITY_PATCH,
            ),
            agentVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
        )
    }

    private fun sdkString(): String {
        if (Build.VERSION.SDK_INT < 36) return Build.VERSION.SDK_INT.toString()
        val full = Build.VERSION.SDK_INT_FULL
        val minor = Build.getMinorSdkVersion(full)
        return if (minor == 0) "${Build.getMajorSdkVersion(full)}" else "${Build.getMajorSdkVersion(full)}.$minor"
    }

    companion object {
        fun bucketName(bucket: Int): String = when (bucket) {
            5 -> "exempted"
            UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "active"
            UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "working set"
            UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "frequent"
            UsageStatsManager.STANDBY_BUCKET_RARE -> "rare"
            UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> "restricted"
            else -> "bucket $bucket"
        }
    }
}
