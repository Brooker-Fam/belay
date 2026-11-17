package family.brooker.belay.enforce

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.WireLimits

/**
 * Phase 3: locks the screen now, for a `lock_now` command or a schedule that locks when it
 * starts (DevicePolicyManager.lockNow; docs/platform-notes.md S5). With no screen lock set it
 * only turns the screen off, and the kid knows their own PIN: a nudge, not a lock.
 *
 * Android 17's first release checks the admin's `<force-lock/>` (res/xml/device_admin.xml) unless
 * the flag lock_now_coexistence is on, and reads a device owner's policies from its APK again only
 * at the next boot: a Belay updated to this version can lock the screen once the phone restarts.
 */
object ScreenLock {
    /** Locks the screen; null when it worked, otherwise what went wrong, for the parent. */
    fun lock(context: Context, owner: Boolean): String? {
        if (!owner) return "Belay isn't the device owner, so it can't lock the screen."
        return try {
            context.getSystemService(DevicePolicyManager::class.java).lockNow()
            Log.i(Agent.TAG, "screen locked")
            null
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "lockNow refused", e)
            if (e.message.orEmpty().contains("force-lock")) {
                NEEDS_RESTART
            } else {
                "Android didn't let Belay lock the screen: ${e.message.orEmpty()}".take(WireLimits.MAX_PROBLEM)
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "lockNow failed", e)
            "Belay couldn't lock the screen: ${e.javaClass.simpleName}.".take(WireLimits.MAX_PROBLEM)
        }
    }

    /** Android reads Belay's new force-lock policy only when the phone starts (platform notes S5). */
    const val NEEDS_RESTART =
        "Android lets Belay lock the screen only after the phone restarts once with this version of Belay."
}
