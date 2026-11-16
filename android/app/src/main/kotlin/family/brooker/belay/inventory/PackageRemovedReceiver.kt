package family.brooker.belay.inventory

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import family.brooker.belay.Agent
import family.brooker.belay.Trigger

/**
 * PACKAGE_FULLY_REMOVED is one of the two package broadcasts still delivered to manifest
 * receivers, so a removal is seen even if the service isn't running at that moment.
 */
class PackageRemovedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_PACKAGE_FULLY_REMOVED) return
        val name = intent.data?.schemeSpecificPart ?: return
        val pending = goAsync()
        Agent.handle(context, Trigger.PACKAGE_BROADCAST, setOf(name)) { pending.finish() }
    }
}
