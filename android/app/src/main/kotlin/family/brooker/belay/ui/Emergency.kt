package family.brooker.belay.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Telephony
import android.telecom.TelecomManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.inventory.queryActivitiesCompat

/**
 * Phase 7: the emergency card's buttons, which work while every other app is paused
 * (docs/platform-notes.md K6 and K7):
 * - calls go to the default dialer with ACTION_DIAL and the number filled in, so the kid taps Call
 *   there: no CALL_PHONE permission, and Android sends an emergency number to the preloaded dialer
 *   anyway (T2). Texts go to the default SMS app with ACTION_SENDTO `smsto:`. Belay never suspends
 *   either (core's NeverBlocked), and naming the package keeps a chooser, or another app that may
 *   be paused, out of the way;
 * - "Medical information and emergency contacts" opens Android's own emergency information: the
 *   system app with an activity for `android.telephony.action.EMERGENCY_ASSISTANCE` (the emergency
 *   role's required activity; AOSP's is `com.android.emergency`, shown over the lock screen too).
 *   Belay never copies medical details.
 */
object Emergency {
    /** TelephonyManager.ACTION_EMERGENCY_ASSISTANCE, a system API: spelled out, as in PhoneFacts. */
    private const val ACTION_EMERGENCY_ASSISTANCE = "android.telephony.action.EMERGENCY_ASSISTANCE"

    fun call(context: Context, number: String): Boolean {
        val dialer = runCatching { context.getSystemService(TelecomManager::class.java)?.defaultDialerPackage }.getOrNull()
        return start(context, Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)), dialer)
    }

    fun text(context: Context, number: String): Boolean {
        val sms = runCatching { Telephony.Sms.getDefaultSmsPackage(context) }.getOrNull()
        return start(context, Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", number, null)), sms)
    }

    /** The system app that shows the phone's emergency information, if there is one. */
    fun infoApp(context: Context): String? = runCatching {
        context.packageManager.queryActivitiesCompat(Intent(ACTION_EMERGENCY_ASSISTANCE), PackageManager.MATCH_SYSTEM_ONLY)
            .mapNotNull { it.activityInfo?.packageName }
            .firstOrNull()
    }.getOrNull()

    fun info(context: Context): Boolean {
        val app = infoApp(context) ?: return false
        return start(context, Intent(ACTION_EMERGENCY_ASSISTANCE), app)
    }

    /** Starts [intent] in [preferred] if it takes it, else wherever Android sends it. */
    private fun start(context: Context, intent: Intent, preferred: String?): Boolean {
        val targeted = preferred?.let { Intent(intent).setPackage(it) }
        for (candidate in listOfNotNull(targeted, intent)) {
            try {
                context.startActivity(candidate.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (e: ActivityNotFoundException) {
                Log.w(Agent.TAG, "emergency card: nothing takes ${candidate.action} in ${candidate.`package` ?: "any app"}")
            } catch (e: SecurityException) {
                Log.w(Agent.TAG, "emergency card: ${candidate.action} refused", e)
            }
        }
        return false
    }
}
