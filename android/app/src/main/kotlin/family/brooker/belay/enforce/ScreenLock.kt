package family.brooker.belay.enforce

import android.app.admin.DeviceAdminInfo
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.WireLimits

/**
 * Phase 3: locks the screen now, for a `lock_now` command, a schedule that locks when it starts,
 * or lost mode (DevicePolicyManager.lockNow; docs/platform-notes.md S5). With no screen lock set it
 * only turns the screen off, and the kid knows their own PIN: a nudge, not a lock.
 *
 * Android 17's first release checks the admin's `<force-lock/>` (res/xml/device_admin.xml) unless
 * the flag lock_now_coexistence is on, and reads a device owner's policies from its APK again only
 * at the next boot: a Belay updated to this version can lock the screen once the phone restarts.
 * Whether Belay can lock is decided before any lock, from what a call doesn't change ([cannotLock],
 * the sixth review's G2), so a lock that would wait for a call is decided the same way.
 */
object ScreenLock {
    /**
     * Android refused a lock for force-lock since Belay started (S5 lasts until the phone restarts,
     * and Belay's process doesn't outlive it): in case Android's record and lockNow ever disagree.
     */
    @Volatile
    private var refusedForceLock = false

    /**
     * Why Belay can't lock the screen now, or null when it can: it isn't the device owner, or
     * Android's record of its policies has no force-lock (DevicePolicyManager.hasGrantedPolicy with
     * USES_POLICY_FORCE_LOCK: "whether the administrator was activated under an earlier set of
     * policies, but requires additional policies after an upgrade"), which AOSP 17's lockNow
     * checks without the flag, until the phone restarts (platform notes S5). With the flag on,
     * Android would lock anyway; Belay goes by that record all the same, so a lock is decided the
     * same way whether or not it would have waited for a call.
     */
    fun cannotLock(context: Context, owner: Boolean): String? {
        if (!owner) return NOT_OWNER
        if (refusedForceLock) return NEEDS_RESTART
        val granted = try {
            context.getSystemService(DevicePolicyManager::class.java)
                .hasGrantedPolicy(DeviceOwnerSetup.admin(context), DeviceAdminInfo.USES_POLICY_FORCE_LOCK)
        } catch (e: RuntimeException) {
            // SecurityException: not an active admin, which a device owner always is. lockNow says.
            Log.w(Agent.TAG, "couldn't ask whether Belay may lock the screen", e)
            true
        }
        return if (granted) null else NEEDS_RESTART
    }

    /** Locks the screen; null when it worked, otherwise what went wrong, for the parent. Never tries when Belay can't ([cannotLock]). */
    fun lock(context: Context, owner: Boolean): String? {
        cannotLock(context, owner)?.let { return it }
        return try {
            context.getSystemService(DevicePolicyManager::class.java).lockNow()
            Log.i(Agent.TAG, "screen locked")
            null
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "lockNow refused", e)
            if (e.message.orEmpty().contains("force-lock")) {
                refusedForceLock = true
                NEEDS_RESTART
            } else {
                "Android didn't let Belay lock the screen: ${e.message.orEmpty()}".take(WireLimits.MAX_PROBLEM)
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "lockNow failed", e)
            "Belay couldn't lock the screen: ${e.javaClass.simpleName}.".take(WireLimits.MAX_PROBLEM)
        }
    }

    const val NOT_OWNER = "Belay isn't the device owner, so it can't lock the screen."

    /** Android reads Belay's new force-lock policy only when the phone starts (platform notes S5). */
    const val NEEDS_RESTART =
        "Android lets Belay lock the screen only after the phone restarts once with this version of Belay."
}
