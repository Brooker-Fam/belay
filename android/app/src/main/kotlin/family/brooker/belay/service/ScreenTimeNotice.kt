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
import family.brooker.belay.core.screentime.Notice
import family.brooker.belay.core.screentime.NoticePlan
import family.brooker.belay.core.screentime.NoticeSlot
import family.brooker.belay.screentime.UsageAccess
import family.brooker.belay.ui.KidWords
import family.brooker.belay.ui.MainActivity
import family.brooker.belay.ui.Screen
import family.brooker.belay.ui.Screens

/**
 * Phase 3: screen time's notifications, as core's Notices plans them: a warning before a limit
 * runs out or a schedule starts, time's up (with "Ask for more time"), a schedule starting
 * (bedtime says what still works), and "Belay can't count" (with "Turn usage access back on").
 * One notification per slot (its tag), each shown once; Android takes one away when it no
 * longer holds (setTimeoutAfter), and Belay takes back the others. Each opens Belay.
 */
object ScreenTimeNotice {
    const val CHANNEL_ID = "screen_time"
    private const val NOTIFICATION_ID = 5

    /** The limit "Ask for more time" opens Belay for (MainActivity reads it). */
    const val EXTRA_ASK_LIMIT = "family.brooker.belay.extra.ASK_LIMIT"

    /** Opens Belay asking for more time for [limitId]: a time's-up notification's action. */
    fun askMoreTime(context: Context, limitId: String): Intent = Intent(context, MainActivity::class.java)
        .putExtra(EXTRA_ASK_LIMIT, limitId)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.screen_time_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.screen_time_channel_description)
            setShowBadge(true)
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** Shows and takes back what [plan] says, in [words]. */
    fun apply(context: Context, plan: NoticePlan, words: KidWords, now: Long) {
        cancel(context, plan.cancel)
        if (plan.show.isEmpty()) return
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        ensureChannel(context)
        plan.show.forEach { show(context, it, words, now) }
    }

    fun cancel(context: Context, tags: List<String>) {
        if (tags.isEmpty()) return
        val manager = NotificationManagerCompat.from(context)
        tags.forEach { manager.cancel(it, NOTIFICATION_ID) }
    }

    private fun show(context: Context, notice: Notice, words: KidWords, now: Long) {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val text = words.text(notice.text)
        val tag = notice.slot.tag
        // One request code per slot, so each notification keeps its own intents.
        val code = tag.hashCode()
        val open = PendingIntent.getActivity(
            context,
            code,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.screen_time_notice_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
        notice.until?.let { until -> if (until > now) builder.setTimeoutAfter(until - now) }
        when (val slot = notice.slot) {
            is NoticeSlot.TimesUp -> builder.addAction(
                0,
                context.getString(R.string.ask_more_time),
                PendingIntent.getActivity(
                    context,
                    code + 1,
                    askMoreTime(context, slot.limitId),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            NoticeSlot.Unmeasured -> builder.addAction(
                0,
                context.getString(R.string.usage_access_button),
                PendingIntent.getActivity(
                    context,
                    code + 1,
                    UsageAccess.settings(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            else -> {}
        }
        // Phase 7: "I need help" from time's up and a schedule starting (bedtime): Belay is never blocked.
        if (notice.slot is NoticeSlot.TimesUp || notice.slot is NoticeSlot.Schedule) {
            builder.addAction(
                0,
                context.getString(R.string.help_button),
                PendingIntent.getActivity(
                    context,
                    code + 2,
                    Screens.open(context, Screen.HELP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        }
        try {
            NotificationManagerCompat.from(context).notify(tag, NOTIFICATION_ID, builder.build())
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "screen time notice not shown", e)
        }
    }
}
