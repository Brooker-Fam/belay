package family.brooker.belay

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only (this file and its manifest entry are in src/debug; release builds have
 * neither, and CI checks the release manifest): ci-emulator-test.sh has Belay send today's usage
 * at once instead of within 15 minutes, so it doesn't wait:
 *
 *     adb shell am broadcast -a family.brooker.belay.DEBUG_UPLOAD_USAGE -n family.brooker.belay/.DebugUsageReceiver
 *
 * A step runs, and queues today's usage only if the policy measures; the sync that follows sends
 * it. Exported only to senders holding WRITE_SECURE_SETTINGS, like EnrollReceiver: the adb shell.
 * The answer is RESULT_OK and "asked" once the step has run.
 */
class DebugUsageReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        DebugTools.askUsageUpload()
        val pending = goAsync()
        Agent.handle(context, Trigger.SCREEN_TIME_TICK) {
            pending.setResult(Activity.RESULT_OK, "asked", null)
            pending.finish()
        }
    }

    companion object {
        const val ACTION = "family.brooker.belay.DEBUG_UPLOAD_USAGE"
    }
}
