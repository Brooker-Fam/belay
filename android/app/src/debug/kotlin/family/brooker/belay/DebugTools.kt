package family.brooker.belay

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.core.DataCategory
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.enforce.Enforcer
import family.brooker.belay.service.BelayService
import family.brooker.belay.store.AgentStore
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Debug builds only (this file is in src/debug). Release builds get
 * src/release/.../DebugTools.kt, which contains none of this, so nothing in a release build
 * can switch Belay off, talk plain http, write the state file, take a policy from
 * anywhere but the family's server, or run a test like Phase 5's archival test (ArchivalTest).
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

    private val usageUpload = AtomicBoolean(false)

    /**
     * Phase 3, for ci-emulator-test.sh (DebugUsageReceiver): the next step sends today's usage
     * at once, instead of within 15 minutes. Only what the policy's measure allows is sent.
     */
    fun askUsageUpload() = usageUpload.set(true)

    /** Whether the step should send today's usage now; asking once sends once. */
    fun takeUsageUpload(): Boolean = usageUpload.getAndSet(false)

    /**
     * Runtime permissions only a debug test holds (DeviceOwnerSetup): READ_SMS, for Phase 5's archival
     * test (ArchivalTest). Each is granted by policy while its test is on, and denied by policy otherwise.
     */
    val TESTED_PERMISSIONS: Set<String> = setOf(ArchivalTest.READ_SMS)

    /** The ones a test that's on holds now. */
    fun testing(context: Context): Set<String> = if (ArchivalTest.isOn(context)) TESTED_PERMISSIONS else emptySet()

    /** The managed notice's line while a test is on (ManagedNotice): the kid sees it's on. */
    fun noticeLine(context: Context): String? = ArchivalTest.noticeLine(context)

    /** "What your parent can see" while a test is on: what it collects, in the kid's words (MainScreen). */
    fun canSee(context: Context): StateFlow<List<DataCategory>> = ArchivalTest.canSee(context)

    /** Release device owner without a factory reset. */
    fun releasePhone(context: Context): String {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val pkg = context.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return "Belay isn't the device owner."
        // The archival test takes back what it set while Belay is still device owner.
        ArchivalTest.stopForRelease(context)
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
     * kid's words), with the archival test's own state as `archival_test` (its counts and names,
     * never a value from a message). And the archival test's time box: off once its time is up.
     */
    fun afterStep(context: Context, dump: () -> String) {
        try {
            ArchivalTest.afterStep(context)
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "archival test: not checked after the step", e)
        }
        val file = AtomicFile(File(context.noBackupFilesDir, STATE_FILE))
        val out = try {
            file.startWrite()
        } catch (e: java.io.IOException) {
            Log.w(Agent.TAG, "debug state not written", e)
            return
        }
        try {
            val state = Json.parseToJsonElement(dump()).jsonObject
            out.write(JsonObject(state + (ARCHIVAL_TEST to ArchivalTest.json(context))).toString().encodeToByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            Log.w(Agent.TAG, "debug state not written", e)
        }
    }

    private const val STATE_FILE = "debug-state.json"
    private const val ARCHIVAL_TEST = "archival_test"
}
