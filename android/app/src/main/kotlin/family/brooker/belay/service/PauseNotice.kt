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
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.kid.Caregivers
import family.brooker.belay.ui.Screen
import family.brooker.belay.ui.Screens

/**
 * Phase 7: while a parent (or Phase 12's caregiver, named) has the phone paused, a quiet notice
 * says so, with until when, and "I need help" (the help screen is never blocked). Shown once per pause (its end and note), taken
 * away when the pause ends; Android also takes it away at the pause's end (setTimeoutAfter).
 */
object PauseNotice {
    private const val NOTIFICATION_ID = 8

    @Volatile
    private var shownFor: String? = null

    /** [until] is the pause's end in the kid's words, or null when only a parent ends it. */
    fun apply(context: Context, pause: WirePause?, until: String?, now: Long) {
        if (pause == null) {
            if (shownFor != null) NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
            shownFor = null
            return
        }
        // Phase 12: a caregiver's pause names them ("Paused by Grandma").
        val by = Caregivers.who(pause.caregiver)
        val key = "${pause.until}:${pause.note}:$by"
        if (key == shownFor) return
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        ScreenTimeNotice.ensureChannel(context)
        val text = when {
            by != null && until != null -> context.getString(R.string.pause_notice_by_until, by, until)
            by != null -> context.getString(R.string.pause_notice_by, by)
            until != null -> context.getString(R.string.pause_notice_until, until)
            else -> context.getString(R.string.pause_notice)
        }
        val title = by?.let { context.getString(R.string.pause_notice_title_by, it) } ?: context.getString(R.string.pause_notice_title)
        val builder = NotificationCompat.Builder(context, ScreenTimeNotice.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open(context, Screen.HOME, 0))
            .addAction(0, context.getString(R.string.help_button), open(context, Screen.HELP, 1))
            .setOnlyAlertOnce(true)
        pause.until?.let { if (it > now) builder.setTimeoutAfter(it - now) }
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
            shownFor = key
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "pause notice not shown", e)
        }
    }

    private fun open(context: Context, screen: Screen, code: Int): PendingIntent = PendingIntent.getActivity(
        context,
        NOTIFICATION_ID * 10 + code,
        Screens.open(context, screen),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
