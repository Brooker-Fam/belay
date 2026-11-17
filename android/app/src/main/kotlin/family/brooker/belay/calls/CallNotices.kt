package family.brooker.belay.calls

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import family.brooker.belay.Agent
import family.brooker.belay.R

/**
 * The incoming-call notification (InCallService's "Showing the Incoming Call Notification"): a
 * CallStyle notification in a channel of its own, with Answer and Decline and a full-screen intent
 * to Belay's call screen, which Android shows over the lock screen. The channel makes no sound:
 * Belay rings itself (CallRinger), and only for calls it lets through. An ongoing call has a quiet
 * notification of its own, to get back to it. Names are the family's words or the number, as text.
 */
object CallNotices {
    const val INCOMING_CHANNEL = "incoming_calls"
    const val ONGOING_CHANNEL = "ongoing_call"
    const val INCOMING_ID = 30
    const val ONGOING_ID = 31

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(INCOMING_CHANNEL, context.getString(R.string.calls_channel_incoming), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.calls_channel_incoming_description)
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(ONGOING_CHANNEL, context.getString(R.string.calls_channel_ongoing), NotificationManager.IMPORTANCE_LOW).apply {
                description = context.getString(R.string.calls_channel_ongoing_description)
                setShowBadge(false)
            },
        )
    }

    /** POST_NOTIFICATIONS exists from Android 13; Belay holds it by policy. */
    private fun allowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun screen(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        CallActivity.intent(context).addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** An incoming call that rings: [who] is the contact's name, the number, or "Unknown caller". */
    fun incoming(context: Context, callId: String, who: String) {
        if (!allowed(context)) return
        ensureChannels(context)
        val person = Person.Builder().setName(who).setImportant(true).build()
        val answer = CallActionReceiver.intent(context, CallActionReceiver.ANSWER, callId)
        val decline = CallActionReceiver.intent(context, CallActionReceiver.DECLINE, callId)
        val notice = NotificationCompat.Builder(context, INCOMING_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(who)
            .setContentText(context.getString(R.string.calls_incoming))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setContentIntent(screen(context))
            .setFullScreenIntent(screen(context), true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
            .build()
        post(context, INCOMING_ID, notice)
    }

    /** A call going on (dialing, connected or on hold), to get back to it, with Hang up. */
    fun ongoing(context: Context, callId: String, who: String, text: String) {
        if (!allowed(context)) return
        ensureChannels(context)
        val notice = NotificationCompat.Builder(context, ONGOING_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(who)
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(screen(context))
            .addAction(0, context.getString(R.string.calls_hang_up), CallActionReceiver.intent(context, CallActionReceiver.HANG_UP, callId))
            .build()
        post(context, ONGOING_ID, notice)
    }

    fun cancelIncoming(context: Context) = NotificationManagerCompat.from(context).cancel(INCOMING_ID)

    fun cancelOngoing(context: Context) = NotificationManagerCompat.from(context).cancel(ONGOING_ID)

    private fun post(context: Context, id: Int, notice: android.app.Notification) {
        try {
            NotificationManagerCompat.from(context).notify(id, notice)
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "calls: notification not shown", e)
        }
    }
}
