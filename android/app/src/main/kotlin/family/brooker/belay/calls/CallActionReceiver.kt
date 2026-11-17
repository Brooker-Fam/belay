package family.brooker.belay.calls

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Answer, Decline and Hang up from the call notifications. Not exported: only Belay's own
 * PendingIntents reach it.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_CALL) ?: return
        when (intent.action) {
            ANSWER -> CallFlow.answer(context, id)
            DECLINE -> CallFlow.decline(context, id)
            HANG_UP -> CallFlow.hangUp(id)
        }
    }

    companion object {
        const val ANSWER = "family.brooker.belay.calls.ANSWER"
        const val DECLINE = "family.brooker.belay.calls.DECLINE"
        const val HANG_UP = "family.brooker.belay.calls.HANG_UP"
        private const val EXTRA_CALL = "call"

        fun intent(context: Context, action: String, callId: String): PendingIntent = PendingIntent.getBroadcast(
            context,
            action.hashCode(),
            Intent(context, CallActionReceiver::class.java).setAction(action).putExtra(EXTRA_CALL, callId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
