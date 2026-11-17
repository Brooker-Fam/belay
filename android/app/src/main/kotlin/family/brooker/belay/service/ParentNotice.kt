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
 * Quiet notifications for changes a parent makes to Belay itself, so the kid is never left
 * guessing: Belay was updated (Phase 6; Android also posts its own "Updated by your admin"),
 * and Android's own Parental Controls are about to be removed (Phase 10). Each opens Belay.
 */
object ParentNotice {
    const val CHANNEL_ID = "parent"
    private const val UPDATED_ID = 3
    private const val REMOVING_USERS_ID = 4

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.parent_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = context.getString(R.string.parent_channel_description) }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** After Belay installed the version a parent chose; [versionName] is the one now running. */
    fun updated(context: Context, versionName: String) =
        show(context, UPDATED_ID, context.getString(R.string.parent_updated, versionName))

    /** Right before remove_other_users removes another user or profile. */
    fun removingOtherUsers(context: Context) =
        show(context, REMOVING_USERS_ID, context.getString(R.string.parent_removing_other_users))

    private fun show(context: Context, id: Int, text: String) {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        ensureChannel(context)
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notice = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.parent_notice_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, notice)
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "notice not shown", e)
        }
    }
}
