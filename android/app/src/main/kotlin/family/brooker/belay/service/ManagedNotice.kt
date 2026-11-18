package family.brooker.belay.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.R
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.screentime.LocalTimes
import family.brooker.belay.ui.KidWords
import family.brooker.belay.ui.MainActivity

/**
 * The always-visible "This phone is managed by your parent" notice: the foreground
 * service's notification. Android 14 lets users dismiss most ongoing notifications, but
 * not a device policy controller's. Tapping it opens Belay's Home. From Phase 4 it also says when
 * Belay shares where the phone is on a schedule ("Shares where this phone is every 30 minutes,
 * 7:00 AM to 9:00 PM"). On a debug build, a test that's on says so too (DebugTools.noticeLine:
 * Phase 5's archival test); release builds have none.
 */
object ManagedNotice {
    const val CHANNEL_ID = "managed"
    const val NOTIFICATION_ID = 1

    /** The line the notice shows now; null for the plain notice. */
    @Volatile
    private var line: String? = null

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.channel_managed_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.channel_managed_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun build(context: Context): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = context.getString(R.string.notice_text)
        val lines = listOfNotNull(line, DebugTools.noticeLine(context))
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notice_title))
            .setContentText(lines.firstOrNull() ?: text)
            .apply { if (lines.isNotEmpty()) setStyle(NotificationCompat.BigTextStyle().bigText((lines + text).joinToString("\n"))) }
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    /** Shows [next] as the notice's line (null: none), when it changed and the service is running. */
    fun update(context: Context, next: String?) {
        if (next == line) return
        line = next
        refresh(context)
    }

    /** Shows the notice again as it is now, while the service is running (a debug build's test started or ended). */
    fun refresh(context: Context) {
        if (BelayService.runningSince == null) return
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, build(context))
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "managed notice not updated", e)
        }
    }

    /** Periodic mode's line, in the kid's words; null in any other mode. */
    fun locationLine(context: Context, location: WireLocation?, words: KidWords): String? {
        if (!LocationRules.periodic(location)) return null
        val every = LocationRules.everyMinutes(location)
        val start = location?.hours?.start?.let(LocalTimes::clock)
        val end = location?.hours?.end?.let(LocalTimes::clock)
        return if (start == null || end == null || start == end) {
            context.resources.getQuantityString(R.plurals.notice_location_every, every, every)
        } else {
            context.resources.getQuantityString(R.plurals.notice_location_hours, every, every, words.time(start), words.time(end))
        }
    }
}
