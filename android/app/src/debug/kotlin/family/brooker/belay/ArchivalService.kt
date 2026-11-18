package family.brooker.belay

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import family.brooker.belay.archival.ArchivalVia
import family.brooker.belay.service.ManagedNotice

/**
 * Debug builds only (this file and its manifest entries are in src/debug; release builds have neither,
 * and CI checks the release APK): the archival service Google Messages' docs describe for its archival
 * app (developer.android.com/work/dpc/rcs-messages-archival): exported, a short foreground service,
 * protected by WRITE_SMS, for GOOGLE_MESSAGES_ARCHIVAL_UPDATE. Disabled in the manifest; ArchivalTest
 * enables it only while the test is on (docs/phase5-checklist.md, T8).
 *
 * WRITE_SMS doesn't keep other apps out, whatever the docs hope: Android 17 keeps it as a removed
 * permission, which any app that asks for it holds (docs/platform-notes.md T8). So an update is only
 * counted, never trusted, and a message URI is read only in the phone's own message store, and only
 * for its rows' ids, to count them.
 */
class ArchivalService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // First, within Android's few seconds: Google Messages starts it as a foreground service.
        try {
            ManagedNotice.ensureChannel(this)
            val notice = NotificationCompat.Builder(this, ManagedNotice.CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notice_title))
                .setContentText(getString(R.string.archival_counting))
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setSilent(true)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
                .build()
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE else 0
            ServiceCompat.startForeground(this, NOTICE_ID, notice, type)
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "archival test: the short foreground service didn't start", e)
        }
        ArchivalTest.update(this, ArchivalVia.SERVICE, intent) { stopSelf(startId) }
        return START_NOT_STICKY
    }

    /** A short service's time (about 3 minutes) is up: it stops, or Android calls it not responding. */
    override fun onTimeout(startId: Int) {
        Log.w(Agent.TAG, "archival test: an update took too long")
        stopSelf(startId)
    }

    companion object {
        /** Its own notification id: the managed notice (1) stays when this service stops. */
        const val NOTICE_ID = 90
    }
}

/**
 * The same update as a broadcast, since the docs also say Google Messages "sends an explicit broadcast"
 * to the archival app: protected by WRITE_SMS like the service, and disabled except during the test.
 * Which one Google Messages uses is one of the things the Pixel test shows (ArchivalVia).
 */
class ArchivalUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        ArchivalTest.update(context, ArchivalVia.BROADCAST, intent) { pending.finish() }
    }
}
