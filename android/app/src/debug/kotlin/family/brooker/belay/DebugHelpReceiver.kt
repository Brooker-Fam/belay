package family.brooker.belay

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only (this file and its manifest entry are in src/debug; release builds have
 * neither, and CI checks the release manifest): ci-emulator-test.sh taps "I need help" the way the
 * kid would, through Agent.askHelp, optionally with words and sharing where the phone is:
 *
 *     adb shell am broadcast -a family.brooker.belay.DEBUG_HELP -n family.brooker.belay/.DebugHelpReceiver \
 *         [--es reason "made-up words"] [--ez share true]
 *
 * Exported only to senders holding WRITE_SECURE_SETTINGS, like EnrollReceiver: the adb shell.
 * The answer (`am broadcast` prints it) is RESULT_OK and "help: <request id>", or 1 and "failed".
 */
class DebugHelpReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val reason = intent.getStringExtra(EXTRA_REASON)
        val share = intent.getBooleanExtra(EXTRA_SHARE, false)
        val pending = goAsync()
        Agent.askHelp(context, reason, share) { id ->
            if (id != null) pending.setResult(Activity.RESULT_OK, "help: $id", null) else pending.setResult(RESULT_FAILED, "failed", null)
            pending.finish()
        }
    }

    companion object {
        const val ACTION = "family.brooker.belay.DEBUG_HELP"
        const val EXTRA_REASON = "reason"
        const val EXTRA_SHARE = "share"
        const val RESULT_FAILED = 1
    }
}
