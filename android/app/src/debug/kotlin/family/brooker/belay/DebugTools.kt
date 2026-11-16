package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.content.Context
import family.brooker.belay.service.BelayService

/**
 * Debug builds only (this file is in src/debug): release device owner without a factory
 * reset. Release builds get src/release/.../DebugTools.kt, which contains no such code,
 * so nothing in a release build can switch Belay off.
 */
object DebugTools {
    const val CAN_RELEASE = true

    fun releasePhone(context: Context): String {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val pkg = context.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return "Belay isn't the device owner."
        BelayService.stop(context)
        runCatching { dpm.setUninstallBlocked(DeviceOwnerSetup.admin(context), pkg, false) }
        @Suppress("DEPRECATION")
        dpm.clearDeviceOwnerApp(pkg)
        return "Released. Belay is no longer the device owner; you can uninstall it."
    }
}
