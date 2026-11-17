package family.brooker.belay.service

import android.Manifest
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
import family.brooker.belay.R
import family.brooker.belay.ui.MainActivity

/**
 * A quiet notification when a new app starts waiting for a parent. Android's own screen for
 * a suspended app ("Blocked by work policy" with Belay's short support message) can't name
 * the app, so this one does, and opens Belay, where the kid can say why they want it. It
 * goes away when no app is waiting. The app's name comes from its developer: shown as text.
 */
object WaitingNotice {
    const val CHANNEL_ID = "waiting"
    private const val NOTIFICATION_ID = 2
    private const val MAX_NAME = 60

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.waiting_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.waiting_channel_description)
            setShowBadge(true)
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** [labels]: the apps that just started waiting. */
    fun show(context: Context, labels: List<String>) {
        if (labels.isEmpty()) return
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        ensureChannel(context)
        val open = PendingIntent.getActivity(
            context,
            1,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = if (labels.size == 1) {
            context.getString(R.string.waiting_notice_one, labels.single().take(MAX_NAME))
        } else {
            context.resources.getQuantityString(R.plurals.waiting_notice_many, labels.size, labels.size)
        }
        val notice = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.waiting_notice_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notice)
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "waiting notice not shown", e)
        }
    }

    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
}
