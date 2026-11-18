package family.brooker.belay.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserManager
import family.brooker.belay.core.calls.AlwaysAllowed

/**
 * Telecom's outgoing-call broadcast (ACTION_NEW_OUTGOING_CALL, to apps holding
 * PROCESS_OUTGOING_CALLS, which Belay holds by policy only while calls is on). Telecom sends it for
 * emergency calls too (NewOutgoingCallIntentBroadcaster, AOSP 17), and those go to the preloaded
 * dialer, not to Belay: this is how Belay learns that the kid called 911 from the lock screen or the
 * preloaded dialer (also with a caller-id code before it, "*67 911"), so every caller rings for the
 * next 2 hours. Only that is kept, on the phone; the number isn't. Enabled only while Belay's dialer
 * is (calls/Dialer.kt).
 *
 * The one part of Belay that's direct-boot aware (docs/platform-notes.md T19): 911 dialed from the
 * lock screen before the first unlock after a restart reaches it too. Belay's store can't open then,
 * so the time goes in device-protected storage (LockedCalls), which CallsGate and the agent step
 * read once the phone is unlocked.
 */
class OutgoingCallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        if (intent.action != Intent.ACTION_NEW_OUTGOING_CALL) return
        val number = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER) ?: return
        if (!AlwaysAllowed.opensCallbackWindow(number, AndroidCalls.emergencyNumbers(context))) return
        val now = System.currentTimeMillis()
        val unlocked = try {
            context.getSystemService(UserManager::class.java)?.isUserUnlocked != false
        } catch (e: RuntimeException) {
            false
        }
        if (unlocked) {
            CallsGate.emergencyContact(context.applicationContext, now)
        } else {
            LockedCalls.record(context, now)
        }
    }
}
