package family.brooker.belay.calls

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.Agent
import java.io.File
import java.io.IOException

/**
 * The one thing Belay keeps before the phone's first unlock after a restart: when the kid called
 * 911, an emergency number or 988 then (from the lock screen's emergency dialer: OutgoingCallReceiver),
 * in device-protected storage, which Android opens at boot (docs/platform-notes.md T19). Belay's own
 * store is in credential-protected storage, which opens only at the first unlock. Once it has
 * opened, CallsGate and the agent step read this time into the 2-hour callback window, and the step
 * deletes it once the window is over (or calls goes off). Only the time: no number, never sent,
 * never in the debug state.
 */
object LockedCalls {
    private const val FILE = "calls-before-unlock"

    private fun file(context: Context) = AtomicFile(File(context.createDeviceProtectedStorageContext().noBackupFilesDir, FILE))

    /** The kid called an always-allowed number at [at], before Belay's store could open. */
    @Synchronized
    fun record(context: Context, at: Long) {
        val file = file(context)
        if ((read(file) ?: Long.MIN_VALUE) >= at) return
        val out = try {
            file.startWrite()
        } catch (e: IOException) {
            Log.w(Agent.TAG, "calls: the time couldn't be kept before the unlock", e)
            return
        }
        try {
            out.write(at.toString().encodeToByteArray())
            file.finishWrite(out)
        } catch (e: IOException) {
            file.failWrite(out)
            Log.w(Agent.TAG, "calls: the time couldn't be kept before the unlock", e)
        }
    }

    /** The time [record] kept, or null. */
    fun emergencyContactAt(context: Context): Long? = read(file(context))

    @Synchronized
    fun forget(context: Context) = file(context).delete()

    private fun read(file: AtomicFile): Long? = try {
        file.readFully().decodeToString().trim().toLongOrNull()
    } catch (e: IOException) {
        // Not there (FileNotFoundException): nothing kept.
        null
    }
}
