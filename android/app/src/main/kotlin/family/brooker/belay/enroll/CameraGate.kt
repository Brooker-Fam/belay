package family.brooker.belay.enroll

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger

/**
 * Belay only ever uses the camera to read the enrollment QR code, on the enrollment screen.
 *
 * As device owner it keeps its own CAMERA permission denied by policy the rest of the time
 * ([DeviceOwnerSetup.ensure]), which Settings shows as set by the admin: a visible sign that
 * Belay can't use the camera. CAMERA is never granted by policy. Before scanning, the screen
 * sets the grant state back to the default, so Android can ask the person holding the phone.
 *
 * Android kills an app's processes when one of its granted runtime permissions is revoked
 * (AOSP 17, services/permission/.../PermissionService.kt), so the lock waits until the
 * enrollment screen has closed: locking during the enrollment would cut it off.
 */
object CameraGate {
    /** True from "Scan the QR code" until the enrollment screen is gone. */
    @Volatile
    var inUse: Boolean = false
        private set

    /**
     * Before scanning: lets Android ask for the camera. Returns false when Belay is device
     * owner and the policy couldn't be lifted, so there's no point asking.
     */
    fun open(context: Context): Boolean {
        inUse = true
        if (!DeviceOwnerSetup.isDeviceOwner(context)) return true
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = DeviceOwnerSetup.admin(context)
        return try {
            dpm.getPermissionGrantState(admin, context.packageName, Manifest.permission.CAMERA) ==
                DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT ||
                dpm.setPermissionGrantState(
                    admin, context.packageName, Manifest.permission.CAMERA, DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT,
                )
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "camera: couldn't lift the policy", e)
            false
        }
    }

    /**
     * The enrollment screen is gone: the next agent step denies CAMERA again. If it was
     * granted, Android restarts Belay's processes once; the service comes back by itself.
     */
    fun close(context: Context) {
        if (!inUse) return
        inUse = false
        Agent.handle(context, Trigger.CAMERA_DONE)
    }
}
