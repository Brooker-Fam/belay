package family.brooker.belay.service

import android.app.admin.DeviceAdminService
import family.brooker.belay.Agent
import family.brooker.belay.Trigger

/**
 * Android keeps a device owner's DeviceAdminService bound, and binds it again if the
 * process dies, so Belay's process counts as foreground even without the foreground
 * service. That keeps the runtime package receiver (PackageWatcher) alive. Binding is
 * the whole point; it only also checks that the foreground service is running.
 */
class BelayAdminService : DeviceAdminService() {
    override fun onCreate() {
        super.onCreate()
        Agent.handle(this, Trigger.ADMIN_SERVICE_BOUND)
    }
}
