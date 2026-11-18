package family.brooker.belay.enforce

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.ConnectivityManager
import android.net.Uri
import android.provider.AlarmClock
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.PackagePresence
import family.brooker.belay.core.PhoneRoles
import family.brooker.belay.core.SimSeen
import family.brooker.belay.inventory.packageInfoCompat
import family.brooker.belay.inventory.queryActivitiesCompat
import family.brooker.belay.inventory.resolveActivityCompat

/**
 * Which packages fill the roles Belay never blocks (core's NeverBlocked), read fresh at
 * every step with public APIs only. Each read is on its own: one failing never stops the
 * others, and an empty answer only means fewer protections from that role, while the fixed
 * names and "system app without a launcher icon" still apply.
 */
object PhoneFacts {
    /**
     * Android's emergency role requires an activity for this action (PermissionController
     * roles.xml, AOSP 17); the constant is a system API, so it's spelled out here.
     */
    private const val ACTION_EMERGENCY_ASSISTANCE = "android.telephony.action.EMERGENCY_ASSISTANCE"

    fun roles(context: Context): PhoneRoles {
        val pm = context.packageManager
        val keyboard = read("keyboard") { currentKeyboard(context) }
        return PhoneRoles(
            self = context.packageName,
            dialers = read("dialer") {
                val telecom = context.getSystemService(TelecomManager::class.java)
                setOfNotNull(telecom?.defaultDialerPackage, telecom?.systemDialerPackage)
            }.orEmpty(),
            texting = read("texting app") { setOfNotNull(Telephony.Sms.getDefaultSmsPackage(context)) }.orEmpty(),
            emergency = read("emergency apps") { systemHandlers(pm, Intent(ACTION_EMERGENCY_ASSISTANCE)) }.orEmpty(),
            home = read("home screen") { homeScreens(pm) }.orEmpty(),
            settings = read("Settings") { systemHandlers(pm, Intent(Settings.ACTION_SETTINGS)) }.orEmpty(),
            keyboards = setOfNotNull(keyboard?.takeIf { isSystem(pm, it) }),
            browsers = read("browsers") { browsers(pm) }.orEmpty() - context.packageName,
            pauseExempt = read("clock") { systemHandlers(pm, Intent(AlarmClock.ACTION_SHOW_ALARMS)) }.orEmpty() + setOfNotNull(keyboard),
        )
    }

    /**
     * Users and profiles besides the phone's own, as the device owner sees them
     * (DevicePolicyManager.getSecondaryUsers: every user but the system user and managed
     * profiles). Android 17's own Parental Controls make a hidden supervising profile even
     * with DISALLOW_ADD_USER set; public APIs can't tell its type from another user's, so
     * Belay reports any of them, and removes them only when a parent asks (Phase 10's
     * remove_other_users, CommandRunner). 0 when Belay isn't device owner.
     */
    fun otherUsers(context: Context): Int = read("other users") {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        if (dpm.isDeviceOwnerApp(context.packageName)) dpm.getSecondaryUsers(DeviceOwnerSetup.admin(context)).size else 0
    } ?: 0

    /**
     * The SIM, for noticing a change: its state, the default subscription's id and the
     * carrier's id, none of which needs a permission (AOSP 17 TelephonyManager,
     * SubscriptionManager). Null while the state is in between (starting up, PIN-locked) or
     * the phone can't say.
     */
    fun sim(context: Context): SimSeen? = read("SIM") {
        val telephony = context.getSystemService(TelephonyManager::class.java) ?: return@read null
        when (telephony.simState) {
            TelephonyManager.SIM_STATE_ABSENT -> SimSeen(present = false, subscriptionId = -1, carrierId = -1)
            TelephonyManager.SIM_STATE_READY ->
                SimSeen(present = true, subscriptionId = SubscriptionManager.getDefaultSubscriptionId(), carrierId = telephony.simCarrierId)
            else -> null
        }
    }

    /**
     * Whether the phone's default network has a proxy (platform notes H2): ConnectivityManager's
     * default proxy is the global one if there is one (set over adb), otherwise the network's own:
     * a Wi-Fi network's manual proxy or proxy script, or the mobile network's APN proxy. It needs
     * no permission (ConnectivityService.getProxyForNetwork, AOSP 17). Only whether, never where.
     */
    fun proxy(context: Context): Boolean = read("proxy") {
        val proxy = context.getSystemService(ConnectivityManager::class.java)?.defaultProxy
        proxy != null && (!proxy.host.isNullOrEmpty() || proxy.pacFileUrl != Uri.EMPTY)
    } ?: false

    /**
     * Whether wireless debugging is on (platform notes H6): Settings.Global's adb_wifi_enabled,
     * which apps may read (it's @Readable in AOSP 17; USB debugging's adb_enabled reads as 0 for
     * apps, so Belay can't tell that one).
     */
    fun wirelessDebugging(context: Context): Boolean = read("wireless debugging") {
        Settings.Global.getInt(context.contentResolver, ADB_WIFI_ENABLED, 0) == 1
    } ?: false

    /** Settings.Global.ADB_WIFI_ENABLED, a hidden constant. */
    private const val ADB_WIFI_ENABLED = "adb_wifi_enabled"

    private fun <T> read(what: String, block: () -> T): T? = try {
        block()
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "couldn't read the $what", e)
        null
    }

    /** System apps with an activity for [intent], hidden ones included. */
    private fun systemHandlers(pm: PackageManager, intent: Intent): Set<String> =
        pm.queryActivitiesCompat(intent, PackageManager.MATCH_SYSTEM_ONLY or PackageManager.MATCH_UNINSTALLED_PACKAGES)
            .filter { installed(it) }
            .mapNotNullTo(HashSet()) { it.activityInfo?.packageName }

    /** The default home screen (unless none is chosen yet), and the system's own. */
    private fun homeScreens(pm: PackageManager): Set<String> {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val default = pm.resolveActivityCompat(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
        // With no default chosen, the resolver ("android") answers instead.
        return systemHandlers(pm, home) + setOfNotNull(default?.takeIf { it != "android" })
    }

    /** The keyboard in use. Settings.Secure.DEFAULT_INPUT_METHOD is @Readable in AOSP 17. */
    private fun currentKeyboard(context: Context): String? =
        Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
            ?.let { ComponentName.unflattenFromString(it)?.packageName }

    private fun isSystem(pm: PackageManager, name: String): Boolean = try {
        val info = pm.packageInfoCompat(name, PackageManager.MATCH_UNINSTALLED_PACKAGES).applicationInfo
        info != null && info.flags and ApplicationInfo.FLAG_SYSTEM != 0
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    /**
     * Apps that open any web address: the test Android's browser role uses
     * (PermissionController BrowserRoleBehavior, AOSP 17), with IntentFilter's public methods
     * in place of the hidden ResolveInfo.handleAllWebDataURI. Hidden browsers included.
     */
    private fun browsers(pm: PackageManager): Set<String> {
        val intent = Intent(Intent.ACTION_VIEW, Uri.fromParts("http", "", null)).addCategory(Intent.CATEGORY_BROWSABLE)
        val flags = PackageManager.MATCH_ALL or PackageManager.MATCH_DEFAULT_ONLY or
            PackageManager.MATCH_DIRECT_BOOT_AWARE or PackageManager.MATCH_DIRECT_BOOT_UNAWARE or
            PackageManager.GET_RESOLVED_FILTER or PackageManager.MATCH_UNINSTALLED_PACKAGES
        return pm.queryActivitiesCompat(intent, flags)
            .filter { it.activityInfo?.exported == true && installed(it) && opensAnyWebAddress(it.filter) }
            .mapNotNullTo(HashSet()) { it.activityInfo?.packageName }
    }

    /** IntentFilter.handleAllWebDataURI (hidden), from its public parts. */
    private fun opensAnyWebAddress(filter: IntentFilter?): Boolean {
        if (filter == null) return false
        if (filter.hasCategory(Intent.CATEGORY_APP_BROWSER)) return true
        return filter.hasAction(Intent.ACTION_VIEW) && filter.hasCategory(Intent.CATEGORY_BROWSABLE) &&
            (filter.hasDataScheme("http") || filter.hasDataScheme("https")) && filter.countDataAuthorities() == 0
    }

    private fun installed(info: ResolveInfo): Boolean {
        val app = info.activityInfo?.applicationInfo ?: return false
        return PackagePresence.installed(app.flags)
    }
}
