package family.brooker.belay

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import family.brooker.belay.core.RecoveryOutcome

/**
 * Debug builds only (this file and its manifest entry are in src/debug; release builds have
 * neither, and CI checks the release manifest): ci-emulator-test.sh types the recovery key
 * the way a parent would on the Recovery screen, through Agent.recover:
 *
 *     adb shell am broadcast -a family.brooker.belay.DEBUG_RECOVER -n family.brooker.belay/.DebugRecoveryReceiver \
 *         --es key 7KD2M-8Q4ZX-1HNP3-RT6VW-B9CF0G
 *
 * Exported only to senders holding WRITE_SECURE_SETTINGS, like EnrollReceiver: the adb shell.
 * The answer (`am broadcast` prints it) is RESULT_OK and "opened: version <v> until <millis>",
 * or 1 and what the try did ("wrong", "wait", "used", ...). It never repeats the key.
 */
class DebugRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val key = intent.getStringExtra(EXTRA_KEY).orEmpty()
        val pending = goAsync()
        Agent.recover(context, key) { outcome ->
            when (outcome) {
                is RecoveryOutcome.Opened ->
                    pending.setResult(Activity.RESULT_OK, "opened: version ${outcome.use.version} until ${outcome.use.until}", null)
                else -> pending.setResult(RESULT_NOT_OPENED, outcome?.javaClass?.simpleName?.lowercase() ?: "failed", null)
            }
            pending.finish()
        }
    }

    companion object {
        const val ACTION = "family.brooker.belay.DEBUG_RECOVER"
        const val EXTRA_KEY = "key"
        const val RESULT_NOT_OPENED = 1
    }
}
