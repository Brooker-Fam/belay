package family.brooker.belay

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import family.brooker.belay.enroll.Enroller
import family.brooker.belay.sync.Sync

/**
 * Enrollment over adb, for `provision.sh --server <url> --code <code>`:
 *
 *     adb shell am broadcast -a family.brooker.belay.ENROLL -n family.brooker.belay/.EnrollReceiver \
 *         --es server https://belay.example.org --es code 7KQ2M9XA
 *
 * The receiver is exported, but only to senders holding WRITE_SECURE_SETTINGS: the adb shell
 * does, ordinary apps can't (signature|privileged|development|role|installer in Android 17;
 * "development" can only be granted over adb). So this is a parent's path, like adb itself,
 * and it may replace an existing connection. The idea of a receiver guarded this way comes
 * from kidctl (MIT, github.com/kidctl/kidctl); the code is Belay's own.
 *
 * The result (`am broadcast` prints it) is RESULT_OK and "enrolled: …", or 1 and
 * "failed: <problem>[: <server's words>]". It never contains the token.
 */
class EnrollReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val server = intent.getStringExtra(EXTRA_SERVER).orEmpty()
        val code = intent.getStringExtra(EXTRA_CODE).orEmpty()
        // Android gives a background broadcast 60 s; enrolling allows itself 40 (DeviceApi).
        val pending = goAsync()
        Sync.enroll(context, server, code, replace = true) { outcome ->
            when (outcome) {
                is Enroller.Outcome.Enrolled ->
                    pending.setResult(Activity.RESULT_OK, "enrolled: \"${outcome.deviceName}\" on ${outcome.host}", null)
                is Enroller.Outcome.Failed ->
                    pending.setResult(RESULT_FAILED, "failed: ${outcome.problem.code}" + (outcome.detail?.let { ": $it" } ?: ""), null)
            }
            pending.finish()
        }
    }

    companion object {
        const val ACTION = "family.brooker.belay.ENROLL"
        const val EXTRA_SERVER = "server"
        const val EXTRA_CODE = "code"
        const val RESULT_FAILED = 1
    }
}
