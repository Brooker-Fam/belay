package family.brooker.belay

import android.app.Application
import android.content.Context
import android.os.UserManager
import family.brooker.belay.calls.DialerWatcher
import family.brooker.belay.inventory.PackageWatcher
import family.brooker.belay.screentime.ScreenWatcher
import family.brooker.belay.service.ManagedNotice

class BelayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ManagedNotice.ensureChannel(this)
        watch(this)
    }

    companion object {
        /**
         * Registers what wakes the agent between steps, once per process (each one checks). Before the
         * first unlock after a restart, Android starts Belay only for its one direct-boot aware part
         * (calls/OutgoingCallReceiver.kt), and Belay's store can't open yet: the watchers, which run
         * agent steps, wait for the first step after the unlock (Agent.step).
         */
        fun watch(context: Context) {
            val unlocked = try {
                context.getSystemService(UserManager::class.java)?.isUserUnlocked != false
            } catch (e: RuntimeException) {
                true
            }
            if (!unlocked) return
            PackageWatcher.register(context)
            // Phase 3: screen on and off, unlocking, and usage access, for screen time.
            ScreenWatcher.register(context)
            // Phase 5: the default dialer changed, while Belay should be it.
            DialerWatcher.register(context)
        }
    }
}
