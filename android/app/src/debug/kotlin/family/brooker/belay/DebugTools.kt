package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.enforce.Enforcer
import family.brooker.belay.service.BelayService
import family.brooker.belay.store.AgentStore
import java.io.File

/**
 * Debug builds only (this file is in src/debug). Release builds get
 * src/release/.../DebugTools.kt, which contains none of this, so nothing in a release build
 * can switch Belay off, talk plain http, write the state file, or take a policy from
 * anywhere but the family's server.
 */
object DebugTools {
    const val CAN_RELEASE = true

    /**
     * Plain http is allowed to these hosts only (with src/debug/res/xml/network_security_config.xml):
     * the emulator's host and the phone itself, for an end-to-end test against a local server.
     */
    val CLEARTEXT_HOSTS: Set<String> = setOf("10.0.2.2", "127.0.0.1")

    /**
     * For instrumented tests, which run in Belay's own process: while set, the agent enforces
     * this policy instead of the server's, so a test isn't undone by the long-poll. Memory
     * only; a test clears it and runs a step to put the phone back as it was. Debug builds
     * never apply factory_reset, debugging or reset protection, whatever this says.
     */
    @Volatile
    var policyOverride: WirePolicy? = null

    /** Release device owner without a factory reset. */
    fun releasePhone(context: Context): String {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val pkg = context.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return "Belay isn't the device owner."
        BelayService.stop(context)
        // Take back what Belay enforces (releasing device owner leaves Private DNS as it is).
        runCatching {
            val store = AgentStore.get(context)
            Enforcer(context).release(store.applied(), store.privateDns()?.setHost)
        }
        runCatching { dpm.setUninstallBlocked(DeviceOwnerSetup.admin(context), pkg, false) }
        @Suppress("DEPRECATION")
        dpm.clearDeviceOwnerApp(pkg)
        return "Released. Belay is no longer the device owner; you can uninstall it."
    }

    /**
     * After each agent step: no_backup/debug-state.json, which ci-emulator-test.sh reads with
     * `run-as` (heartbeats, changes, outbox counts, enforcement; never the token or the
     * kid's words).
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
