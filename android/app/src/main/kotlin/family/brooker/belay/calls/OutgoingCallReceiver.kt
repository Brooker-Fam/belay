package family.brooker.belay.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import family.brooker.belay.core.calls.AlwaysAllowed

/**
 * Telecom's outgoing-call broadcast (ACTION_NEW_OUTGOING_CALL, to apps holding
 * PROCESS_OUTGOING_CALLS, which Belay holds by policy only while calls is on). Telecom sends it for
 * emergency calls too (NewOutgoingCallIntentBroadcaster, AOSP 17), and those go to the preloaded
 * dialer, not to Belay: this is how Belay learns that the kid called 911 from the lock screen or the
 * preloaded dialer, so every caller rings for the next 2 hours. Only that is kept, on the phone; the
 * number isn't. Enabled only while Belay's dialer is (calls/Dialer.kt).
 */
class OutgoingCallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        if (intent.action != Intent.ACTION_NEW_OUTGOING_CALL) return
        val number = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER) ?: return
        if (AlwaysAllowed.opensCallbackWindow(number, AndroidCalls.emergencyNumbers(context))) {
            CallsGate.emergencyContact(context.applicationContext, System.currentTimeMillis())
        }
    }
}
