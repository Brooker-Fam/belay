package family.brooker.belay.inventory

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The runtime package receiver: added, replaced and removed are no longer delivered to
 * manifest receivers, only to receivers registered in a live process. It is registered
 * once per process (BelayApp), so it works whatever keeps the process alive: the
 * foreground service, the DeviceAdminService the system keeps bound, or a periodic check.
 */
object PackageWatcher {
    private val registered = AtomicBoolean(false)

    fun register(context: Context) {
        if (!registered.compareAndSet(false, true)) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_FULLY_REMOVED)
            addDataScheme("package")
        }
        // Not exported: only the system can deliver these.
        ContextCompat.registerReceiver(context.applicationContext, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val name = intent.data?.schemeSpecificPart ?: return
            // An update sends REMOVED and ADDED with EXTRA_REPLACING, then REPLACED: act on REPLACED.
            val replacing = intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)
            if (replacing && intent.action != Intent.ACTION_PACKAGE_REPLACED) return
            Agent.handle(context, Trigger.PACKAGE_BROADCAST, setOf(name))
        }
    }
}
