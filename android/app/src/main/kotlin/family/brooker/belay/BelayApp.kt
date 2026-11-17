package family.brooker.belay

import android.app.Application
import family.brooker.belay.inventory.PackageWatcher
import family.brooker.belay.screentime.ScreenWatcher
import family.brooker.belay.service.ManagedNotice

class BelayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ManagedNotice.ensureChannel(this)
        PackageWatcher.register(this)
        // Phase 3: screen on and off, unlocking, and usage access, for screen time.
        ScreenWatcher.register(this)
    }
}
