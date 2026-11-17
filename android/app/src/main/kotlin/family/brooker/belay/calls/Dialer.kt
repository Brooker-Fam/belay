package family.brooker.belay.calls

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.TelecomManager
import android.util.Log
import family.brooker.belay.Agent

/**
 * Belay as the phone's dialer (docs/platform-notes.md T1): the role, and the components that make
 * Belay qualify for it. Those are disabled in the manifest and enabled only while the policy has
 * calls, so with calls off Belay isn't a dialer at all: not in Settings' list of phone apps, never
 * bound by Telecom, never asked about a call. Disabling them again when calls goes off also makes
 * Android drop Belay from the role when there's no other dialer to give it back to (the role
 * controller removes a holder that no longer qualifies). Changing them never kills Belay
 * (DONT_KILL_APP), and losing the role doesn't either: Belay's call permissions are fixed by policy,
 * which the role can't revoke.
 */
object Dialer {
    /** Belay's dialer: the in-call and screening services, the dial pad, its launcher icon, the outgoing-call receiver. */
    private val COMPONENTS = listOf(
        "family.brooker.belay.calls.BelayInCallService",
        "family.brooker.belay.calls.BelayCallScreeningService",
        "family.brooker.belay.calls.DialerActivity",
        "family.brooker.belay.calls.DialerLauncher",
        "family.brooker.belay.calls.OutgoingCallReceiver",
    )

    private fun telecom(context: Context): TelecomManager? = context.getSystemService(TelecomManager::class.java)

    /** The default dialer now (no permission needed); null when there's none or Android can't say. */
    fun defaultDialer(context: Context): String? = try {
        telecom(context)?.defaultDialerPackage
    } catch (e: RuntimeException) {
        null
    }

    /** The preloaded dialer, which takes every emergency call (T2). */
    fun systemDialer(context: Context): String? = try {
        telecom(context)?.systemDialerPackage
    } catch (e: RuntimeException) {
        null
    }

    fun isDialer(context: Context): Boolean = defaultDialer(context) == context.packageName

    /** Whether the phone can make calls at all (setDefaultDialerApplication does nothing without it). */
    fun hasTelephony(context: Context): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)

    fun componentsEnabled(context: Context): Boolean {
        val pm = context.packageManager
        return COMPONENTS.all { pm.getComponentEnabledSetting(ComponentName(context.packageName, it)) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED }
    }

    /** Enables or disables Belay's dialer, without stopping Belay. False if Android refused one. */
    fun setComponents(context: Context, enabled: Boolean): Boolean {
        val pm = context.packageManager
        val state = if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        var ok = true
        for (name in COMPONENTS) {
            try {
                pm.setComponentEnabledSetting(ComponentName(context.packageName, name), state, PackageManager.DONT_KILL_APP)
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "calls: couldn't ${if (enabled) "enable" else "disable"} $name", e)
                ok = false
            }
        }
        Log.i(Agent.TAG, "calls: Belay's dialer ${if (enabled) "enabled" else "disabled"}")
        return ok
    }

    /**
     * Makes [packageName] the default dialer, as device owner (setDefaultDialerApplication, API 34).
     * Blocks up to 20 seconds, so only on the agent thread. Null when it worked; else Belay's words
     * for Android's refusal (it throws IllegalArgumentException when the app can't be the dialer).
     */
    fun makeDefault(context: Context, packageName: String): String? {
        if (!hasTelephony(context)) return "This phone can't make calls, so Belay can't be its calling app."
        if (Build.VERSION.SDK_INT < 34) return "This version of Android can't let Belay choose the phone's calling app (Android 14 and up can)."
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        if (!dpm.isDeviceOwnerApp(context.packageName)) return "Belay isn't the device owner, so it can't choose the phone's calling app."
        return try {
            dpm.setDefaultDialerApplication(packageName)
            if (defaultDialer(context) == packageName) {
                Log.i(Agent.TAG, "calls: the default dialer is now $packageName")
                null
            } else {
                "Android didn't make $packageName the phone's calling app."
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "calls: setDefaultDialerApplication($packageName) refused", e)
            "Android didn't make ${if (packageName == context.packageName) "Belay" else packageName} the phone's calling app: ${e.message ?: e.javaClass.simpleName}"
        }
    }
}
