package family.brooker.belay.service

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import family.brooker.belay.Agent
import family.brooker.belay.R
import family.brooker.belay.ui.Screen
import family.brooker.belay.ui.Screens
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Phase 4: Belay's own notices for location, so the kid always knows (principle 4): each time a
 * parent (or their AI app, named) checked where the phone is, and lost mode while it's on. Android
 * adds its own: the status bar's location icon while GPS is used (platform notes L6), "Belay has
 * location access" when Belay grants itself location (L1), and "Apps can access your location"
 * when Belay turns location on (L2). Each opens "What Belay told your parent".
 */
object LocationNotice {
    const val CHANNEL_ID = "location"
    private const val CHECK_ID = 6
    private const val LOST_ID = 7

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.location_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = context.getString(R.string.location_channel_description) }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /**
     * "Your parent checked where this phone is (8:15 PM)", or "…, using Claude" when [via] names
     * the AI app (its name, from its registration, shown as text). One notice per check ([id]).
     */
    fun checked(context: Context, id: String, at: String, via: String?) {
        val text = if (via == null) {
            context.getString(R.string.location_checked, at)
        } else {
            context.getString(R.string.location_checked_via, at, via)
        }
        show(context, id, CHECK_ID, text, ongoing = false)
    }

    /** The lost-mode notice's text now up; null when none (this process's view: a restart shows it again). */
    @Volatile
    private var lostShown: String? = null

    /** Lost mode is on: an ongoing notice, with the last check's time once there is one. */
    fun lost(context: Context, lastCheck: String?) {
        val text = context.getString(R.string.location_lost_notice) +
            (lastCheck?.let { " " + context.getString(R.string.location_lost_last_check, it) } ?: "")
        if (text == lostShown) return
        show(context, null, LOST_ID, text, ongoing = true)
        lostShown = text
    }

    /** Lost mode ended (or was never on in this process): the notice goes. */
    fun cancelLost(context: Context) {
        if (lostShown == null && !firstCancel.compareAndSet(false, true)) return
        NotificationManagerCompat.from(context).cancel(LOST_ID)
        lostShown = null
    }

    /** The first step in a process cancels once, in case a lost-mode notice outlived the last one. */
    private val firstCancel = AtomicBoolean(false)

    private fun show(context: Context, tag: String?, id: Int, text: String, ongoing: Boolean) {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        ensureChannel(context)
        val open = PendingIntent.getActivity(
            context,
            id,
            Screens.open(context, Screen.TOLD),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notice = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.location_notice_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setOnlyAlertOnce(ongoing)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(tag, id, notice)
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "location notice not shown", e)
        }
    }
}
