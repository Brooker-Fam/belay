package family.brooker.belay.calls

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.CategoryPermissions
import family.brooker.belay.inventory.installedPackagesCompat

/**
 * CALL_PHONE for other apps while calls is on (docs/platform-notes.md T14): denied by policy to every
 * app that asks for it but Belay and the apps Belay never blocks (core's NeverBlocked: the preloaded
 * and default dialers, the phone and telecom services, emergency apps, the texting app, Android's
 * own packages), so another dialer can't place a call around Belay's rules. Emergency calling
 * doesn't depend on it: Telecom lets the default and the preloaded dialer place any call whatever
 * their permissions, and raises another app's call to an emergency number to the preloaded dialer
 * (NewOutgoingCallIntentBroadcaster, AOSP 17). When calls goes off, each app Belay denied gets the
 * default state back (core's CallsPlan.callPhone).
 */
object CallPhoneGuard {
    /** Installed packages (hidden ones too) that ask for CALL_PHONE. */
    fun requesters(context: Context): Set<String> = try {
        context.packageManager.installedPackagesCompat(PackageManager.GET_PERMISSIONS or PackageManager.MATCH_UNINSTALLED_PACKAGES)
            .filter { asks(it) }
            .mapTo(HashSet()) { it.packageName }
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "calls: couldn't list the apps that ask for CALL_PHONE", e)
        emptySet()
    }

    private fun asks(info: PackageInfo): Boolean = info.requestedPermissions?.contains(CategoryPermissions.CALL_PHONE) == true

    /** Denies CALL_PHONE to [packageName] by policy. True when it took. */
    fun deny(context: Context, packageName: String): Boolean = set(context, packageName, DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED)

    /** Hands CALL_PHONE back: the grant state Android had before Belay (default: the kid decides again). */
    fun restore(context: Context, packageName: String): Boolean = set(context, packageName, DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT)

    private fun set(context: Context, packageName: String, state: Int): Boolean = try {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(context)
        dpm.getPermissionGrantState(admin, packageName, CategoryPermissions.CALL_PHONE) == state ||
            dpm.setPermissionGrantState(admin, packageName, CategoryPermissions.CALL_PHONE, state)
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "calls: couldn't set CALL_PHONE for $packageName: ${e.javaClass.simpleName}")
        false
    }
}
