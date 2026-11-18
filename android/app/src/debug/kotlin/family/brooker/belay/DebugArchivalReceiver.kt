package family.brooker.belay

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only (this file and its manifest entry are in src/debug; release builds have neither,
 * and CI checks the release APK): the archival test for the Pixel (docs/phase5-checklist.md, T8;
 * ArchivalTest), switched over adb:
 *
 *     adb shell am broadcast -a family.brooker.belay.DEBUG_ARCHIVAL -n family.brooker.belay/.DebugArchivalReceiver \
 *         --es command start [--ei minutes 60]
 *     adb shell am broadcast -a family.brooker.belay.DEBUG_ARCHIVAL -n family.brooker.belay/.DebugArchivalReceiver --es command status
 *     adb shell am broadcast -a family.brooker.belay.DEBUG_ARCHIVAL -n family.brooker.belay/.DebugArchivalReceiver --es command stop
 *
 * `start` runs for 1 to 120 minutes (60 unless asked), and goes off by itself when its time is up;
 * `stop` takes back everything it set. Exported only to senders holding WRITE_SECURE_SETTINGS, like
 * EnrollReceiver: the adb shell. The answer (`am broadcast` prints it) is RESULT_OK and one line: on
 * or off, the counts, and what's set (Google Messages' version and configuration, the default SMS app,
 * READ_SMS, the restricted-messages app-op), never a value from a message; or 1 and why not, like
 * "Google Messages isn't installed." or "Belay isn't the device owner.".
 */
class DebugArchivalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val what = intent.getStringExtra(EXTRA_COMMAND)
        val minutes = if (intent.hasExtra(EXTRA_MINUTES)) intent.getIntExtra(EXTRA_MINUTES, 0) else null
        val pending = goAsync()
        ArchivalTest.command(context, what, minutes) { answer ->
            pending.setResult(if (answer.ok) Activity.RESULT_OK else RESULT_FAILED, answer.text, null)
            pending.finish()
        }
    }

    companion object {
        const val ACTION = "family.brooker.belay.DEBUG_ARCHIVAL"
        const val EXTRA_COMMAND = "command"
        const val EXTRA_MINUTES = "minutes"
        const val RESULT_FAILED = 1
    }
}
