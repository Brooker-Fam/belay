package family.brooker.belay

import android.app.Application
import family.brooker.belay.inventory.PackageWatcher
import family.brooker.belay.service.ManagedNotice

class BelayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ManagedNotice.ensureChannel(this)
        PackageWatcher.register(this)
    }
}
