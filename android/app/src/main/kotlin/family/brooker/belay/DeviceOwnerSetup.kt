package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.util.Log
import family.brooker.belay.inventory.packageInfoCompat

/**
 * What Belay does to the phone once it is device owner. Phase 0 and Phase 1 restrict
 * nothing else: no user restrictions, no app suspension, no network settings.
 */
object DeviceOwnerSetup {
    fun admin(context: Context) = ComponentName(context, AdminReceiver::class.java)

    private fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(DevicePolicyManager::class.java)

    fun isDeviceOwner(context: Context): Boolean = dpm(context).isDeviceOwnerApp(context.packageName)

    /**
     * Applies the setup, and is safe to run any number of times: after provisioning, at
     * every boot and service start, so anything lost comes back. Returns problems, if any.
     *
     * - Belay can't be uninstalled (setUninstallBlocked on itself).
     * - Belay's runtime permissions are granted by policy, so they can't be revoked in
     *   Settings: POST_NOTIFICATIONS keeps the managed notice visible.
     */
    fun ensure(context: Context): List<String> {
        val dpm = dpm(context)
        val admin = admin(context)
        val pkg = context.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return listOf("not device owner")
        val problems = mutableListOf<String>()
        try {
            if (!dpm.isUninstallBlocked(admin, pkg)) dpm.setUninstallBlocked(admin, pkg, true)
        } catch (e: RuntimeException) {
            problems += "uninstall block: ${e.message}"
        }
        for (permission in runtimePermissions(context)) {
            try {
                val state = dpm.getPermissionGrantState(admin, pkg, permission)
                if (state != DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED &&
                    !dpm.setPermissionGrantState(admin, pkg, permission, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
                ) {
                    problems += "$permission: refused"
                }
            } catch (e: RuntimeException) {
                problems += "$permission: ${e.message}"
            }
        }
        if (problems.isNotEmpty()) Log.w(Agent.TAG, "device-owner setup: $problems")
        return problems
    }

    /** The runtime ("dangerous") permissions Belay declares in its manifest. */
    fun runtimePermissions(context: Context): List<String> {
        val pm = context.packageManager
        val requested = pm.packageInfoCompat(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions.orEmpty()
        return requested.filter { name ->
            try {
                pm.getPermissionInfo(name, 0).protection == PermissionInfo.PROTECTION_DANGEROUS
            } catch (e: PackageManager.NameNotFoundException) {
                false
            }
        }
    }
}
