package family.brooker.belay

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserHandle
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

    /**
     * Device owners hear when a user or profile is added or removed (API 28). A Belay phone
     * has none, but Android 17's own Parental Controls make a hidden profile even when adding
     * users is locked: the step reports it, and checks again what Belay holds.
     */
    override fun onUserAdded(context: Context, intent: Intent, addedUser: UserHandle) {
        val pending = goAsync()
        Agent.handle(context, Trigger.USERS_CHANGED) { pending.finish() }
    }

    override fun onUserRemoved(context: Context, intent: Intent, removedUser: UserHandle) {
        val pending = goAsync()
        Agent.handle(context, Trigger.USERS_CHANGED) { pending.finish() }
    }

    /**
     * Phase 3: a batch of network logs is ready, only while Belay has network logging on (an
     * explicit broadcast to the device owner's admin component, AOSP 17 DevicePolicyManagerService).
     * Belay takes it at once, on the agent thread.
     */
    override fun onNetworkLogsAvailable(context: Context, intent: Intent, batchToken: Long, networkLogsCount: Int) {
        val pending = goAsync()
        Agent.networkLogs(context, batchToken) { pending.finish() }
    }

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
