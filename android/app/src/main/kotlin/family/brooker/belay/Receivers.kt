package family.brooker.belay

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * The device admin component: `dpm set-device-owner family.brooker.belay/.AdminReceiver`.
 *
 * `dpm set-device-owner` first makes Belay an active admin (DEVICE_ADMIN_ENABLED, which can
 * arrive before device ownership is set), then sets it as device owner. So onEnabled never
 * assumes device owner: OwnerChangedReceiver gets the broadcast that follows.
 */
class AdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        val pending = goAsync()
        Agent.handle(context, Trigger.ADMIN_ENABLED) { pending.finish() }
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        val pending = goAsync()
        Agent.handle(context, Trigger.PROVISIONED) { pending.finish() }
    }

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence =
        context.getString(R.string.admin_disable_warning)

    override fun onDisabled(context: Context, intent: Intent) {
        Log.w(Agent.TAG, "device admin disabled")
    }
}

/** DEVICE_OWNER_CHANGED (a protected broadcast): set, changed or cleared. */
class OwnerChangedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != DevicePolicyManager.ACTION_DEVICE_OWNER_CHANGED) return
        val pending = goAsync()
        Agent.handle(context, Trigger.OWNER_CHANGED) { pending.finish() }
    }
}

/** Starts everything after a boot, and after Belay itself is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val trigger = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> Trigger.BOOT
            Intent.ACTION_MY_PACKAGE_REPLACED -> Trigger.AGENT_UPDATED
            else -> return
        }
        val pending = goAsync()
        Agent.handle(context, trigger) { pending.finish() }
    }
}
