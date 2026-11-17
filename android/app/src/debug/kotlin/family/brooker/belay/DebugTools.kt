package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.service.BelayService
import java.io.File

/**
 * Debug builds only (this file is in src/debug). Release builds get
 * src/release/.../DebugTools.kt, which contains none of this, so nothing in a release build
 * can switch Belay off or write the state file.
 */
object DebugTools {
    const val CAN_RELEASE = true

    /** Release device owner without a factory reset. */
    fun releasePhone(context: Context): String {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val pkg = context.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return "Belay isn't the device owner."
        BelayService.stop(context)
        runCatching { dpm.setUninstallBlocked(DeviceOwnerSetup.admin(context), pkg, false) }
        @Suppress("DEPRECATION")
        dpm.clearDeviceOwnerApp(pkg)
        return "Released. Belay is no longer the device owner; you can uninstall it."
    }

    /**
     * After each agent step: no_backup/debug-state.json, which ci-emulator-test.sh reads with
     * `run-as` (heartbeats, changes, outbox counts; never the token).
     */
    fun afterStep(context: Context, dump: () -> String) {
        val file = AtomicFile(File(context.noBackupFilesDir, STATE_FILE))
        val out = try {
            file.startWrite()
        } catch (e: java.io.IOException) {
            Log.w(Agent.TAG, "debug state not written", e)
            return
        }
        try {
            out.write(dump().encodeToByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            Log.w(Agent.TAG, "debug state not written", e)
        }
    }

    private const val STATE_FILE = "debug-state.json"
}
