package family.brooker.belay.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Telecom's broadcast when the default dialer changes (someone picked another phone app in
 * Settings, or Android dropped Belay from the role), registered once per process like the package
 * watcher: the step that follows makes Belay the dialer again while the policy has calls, and
 * reports "Calls are going through the phone's own app" until it is.
 */
object DialerWatcher {
    private val registered = AtomicBoolean(false)

    fun register(context: Context) {
        if (!registered.compareAndSet(false, true)) return
        // Not exported: only the system delivers it.
        ContextCompat.registerReceiver(
            context.applicationContext,
            receiver,
            IntentFilter(TelecomManager.ACTION_DEFAULT_DIALER_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == TelecomManager.ACTION_DEFAULT_DIALER_CHANGED) Agent.handle(context, Trigger.DIALER_CHANGED)
        }
    }
}
