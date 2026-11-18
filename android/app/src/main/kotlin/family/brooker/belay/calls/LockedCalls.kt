package family.brooker.belay.calls

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.calls.CallsPlan
import java.io.File
import java.io.IOException

/**
 * The one thing Belay keeps before the phone's first unlock after a restart: when the kid called
 * 911, an emergency number or 988 then (from the lock screen's emergency dialer: OutgoingCallReceiver),
 * in device-protected storage, which Android opens at boot (docs/platform-notes.md T19). Belay's own
 * store is in credential-protected storage, which opens only at the first unlock. Every such time,
 * at most 20 (core's CallsPlan.lockedRecord; the sixth review's G1: each call that rang in the
 * phone's own app then is decided by the window of the call before it, the first of two 911 calls
 * hours apart included). Once the store has opened, the agent step reads them all into the
 * restart's reads of Android's call log, and into the 2-hour callback window with CallsGate (the
 * newest), and drops each once its window is over (all of them, if calls goes off). Only the
 * times, one per line: no number, never sent, never in the debug state.
 */
object LockedCalls {
    private const val FILE = "calls-before-unlock"

    private fun file(context: Context) = AtomicFile(File(context.createDeviceProtectedStorageContext().noBackupFilesDir, FILE))

    /** The kid called an always-allowed number at [at], before Belay's store could open. */
    @Synchronized
    fun record(context: Context, at: Long) {
        val file = file(context)
        val kept = read(file)
        val next = CallsPlan.lockedRecord(kept, at)
        if (next != kept) write(file, next)
    }

    /** Only those whose 2-hour window is still open at [now] stay (core's CallsPlan.lockedOpen); none: the file goes. */
    @Synchronized
    fun keepOpen(context: Context, now: Long) {
        val file = file(context)
        val kept = read(file)
        val open = CallsPlan.lockedOpen(kept, now)
        when {
            open.isEmpty() -> file.delete()
            open != kept -> write(file, open)
        }
    }

    private fun write(file: AtomicFile, times: List<Long>) {
        val out = try {
            file.startWrite()
        } catch (e: IOException) {
            failed(e)
            return
        }
        try {
            out.write(times.joinToString("\n").encodeToByteArray())
            file.finishWrite(out)
        } catch (e: IOException) {
            file.failWrite(out)
            failed(e)
        }
    }

    /**
     * The same neutral words as the agent's (Agent.emergencyContact), and only the exception's
     * class: its message would name this file, which exists only after such a call.
     */
    private fun failed(e: IOException) = Log.w(Agent.TAG, "calls: calls' state couldn't be saved: ${e.javaClass.simpleName}")

    /** Every time [record] kept, oldest first; none: empty. For the restart's reads. */
    fun emergencyContactsAt(context: Context): List<Long> = read(file(context))

    /** The newest time [record] kept, or null: for the callback window now (CallsGate). */
    fun emergencyContactAt(context: Context): Long? = emergencyContactsAt(context).maxOrNull()

    @Synchronized
    fun forget(context: Context) = file(context).delete()

    /** One time per line; an older Belay's file has one. */
    private fun read(file: AtomicFile): List<Long> = try {
        file.readFully().decodeToString().lines().mapNotNull { it.trim().toLongOrNull() }.distinct().sorted()
    } catch (e: IOException) {
        // Not there (FileNotFoundException): nothing kept.
        emptyList()
    }
}
