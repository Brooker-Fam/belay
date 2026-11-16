package family.brooker.belay.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger

/**
 * The always-on foreground service, type systemExempted (allowed for device owners). Its
 * notification is the managed notice. It keeps a live process for the runtime package
 * receiver (PackageWatcher, registered per process), as BelayAdminService also does.
 * Started at boot, right after provisioning, and by the periodic check if it ever stops.
 */
class BelayService : Service() {
    override fun onCreate() {
        super.onCreate()
        if (!DeviceOwnerSetup.isDeviceOwner(this)) {
            // Only reached through a sticky restart after device owner was released (debug builds).
            Log.w(Agent.TAG, "not device owner: service not started")
            stopSelf()
            return
        }
        ManagedNotice.ensureChannel(this)
        try {
            val notice = ManagedNotice.build(this)
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(ManagedNotice.NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
            } else {
                // Foreground service types (and systemExempted) arrived in their current form in API 34.
                startForeground(ManagedNotice.NOTIFICATION_ID, notice)
            }
        } catch (e: RuntimeException) {
            Log.e(Agent.TAG, "startForeground failed", e)
            stopSelf()
            return
        }
        runningSince = System.currentTimeMillis()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (runningSince == null) return START_NOT_STICKY
        Agent.handle(this, Trigger.SERVICE_STARTED)
        return START_STICKY
    }

    override fun onDestroy() {
        runningSince = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        /** When this process's service went to the foreground; null when it isn't running. */
        @Volatile
        var runningSince: Long? = null
            private set

        /** Device owners are exempt from the limits on starting a foreground service from the background. */
        fun start(context: Context) {
            if (runningSince == null) {
                context.startForegroundService(Intent(context, BelayService::class.java))
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, BelayService::class.java))
        }
    }
}
