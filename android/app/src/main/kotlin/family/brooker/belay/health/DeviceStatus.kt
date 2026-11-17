package family.brooker.belay.health

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import family.brooker.belay.BuildConfig
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireHealth
import family.brooker.belay.core.WirePermission
import java.util.TimeZone

/**
 * The device-status collector (data category [DataCategories.DEVICE_STATUS]): what
 * [HealthReader] reads, plus the battery, the storage of /data, the time zone and the
 * clock. The phone's facts and Belay's own health only: no location, no content.
 */
object DeviceStatus {
    fun read(context: Context, health: Health): WireDevice {
        val battery = context.getSystemService(BatteryManager::class.java)
        // Integer.MIN_VALUE when the phone can't say.
        val percent = battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
        val storage = try {
            StatFs(Environment.getDataDirectory().path)
        } catch (e: IllegalArgumentException) {
            null
        }
        val phone = health.phone
        return WireDevice(
            manufacturer = phone.manufacturer,
            model = phone.model,
            androidRelease = phone.androidRelease,
            sdk = Build.VERSION.SDK_INT,
            sdkFull = phone.sdk,
            securityPatch = phone.securityPatch,
            agentVersionName = BuildConfig.VERSION_NAME,
            agentVersionCode = BuildConfig.VERSION_CODE.toLong(),
            bootCount = health.bootCount,
            lastBootAt = health.lastBootAt,
            timezone = TimeZone.getDefault().id,
            deviceTime = System.currentTimeMillis(),
            batteryPercent = percent,
            charging = battery?.isCharging,
            storageFreeBytes = storage?.availableBytes,
            storageTotalBytes = storage?.totalBytes,
            health = WireHealth(
                deviceOwner = health.deviceOwner,
                uninstallBlocked = health.uninstallBlocked,
                batteryExempt = health.batteryExempt,
                usageAccess = health.usageAccess,
                notificationsShown = health.notificationsShown,
                permissions = health.permissions.map { WirePermission(it.name, it.granted, it.fixedByPolicy) },
                standbyBucket = health.standbyBucket,
                backgroundRestricted = health.backgroundRestricted,
                serviceRunning = health.serviceRunningSince != null,
                testOnly = health.testOnly,
            ),
        )
    }
}
