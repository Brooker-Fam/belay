package family.brooker.belay.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.util.Log
import family.brooker.belay.Agent
import java.io.File
import java.io.IOException

/**
 * Installs an APK with a PackageInstaller session, as device owner (AOSP 17,
 * docs/platform-notes.md I2): PackageInstallerSession.computeUserActionRequirement lets a
 * device owner install with nobody confirming, so the kid sees no prompt, only Android's own
 * "Updated by your admin" afterwards. The session asks for no user action and gives the reason
 * as policy. Android refuses a lower version code (no downgrade flag outside debuggable
 * Android builds), a different signing key, and any test-only APK (only the shell may install
 * those, I5). Its answer comes to [InstallStatusReceiver], with Android's status message.
 */
object SelfInstaller {
    const val EXTRA_SHA256 = "family.brooker.belay.extra.SHA256"

    fun sessionParams(packageName: String, size: Long) = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(packageName)
        setSize(size)
        setInstallReason(PackageManager.INSTALL_REASON_POLICY)
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }

    /**
     * Writes [file] into a new session for [packageName] and commits it, answering [status].
     * Returns the session id; throws what Android threw (the session is abandoned).
     */
    fun commit(context: Context, file: File, packageName: String, status: (sessionId: Int) -> IntentSender): Int {
        val installer = context.packageManager.packageInstaller
        val sessionId = installer.createSession(sessionParams(packageName, file.length()))
        try {
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("base.apk", 0, file.length()).use { out ->
                        input.copyTo(out, BUFFER)
                        session.fsync(out)
                    }
                }
                session.commit(status(sessionId))
            }
        } catch (e: IOException) {
            runCatching { installer.abandonSession(sessionId) }
            throw e
        } catch (e: RuntimeException) {
            runCatching { installer.abandonSession(sessionId) }
            throw e
        }
        return sessionId
    }

    /** Belay's own update: Android's answer goes to InstallStatusReceiver, with the offer's SHA-256. */
    fun commitSelf(context: Context, file: File, sha256: String): Int = commit(context, file, context.packageName) { sessionId ->
        val intent = Intent(context, InstallStatusReceiver::class.java).setPackage(context.packageName).putExtra(EXTRA_SHA256, sha256)
        // Mutable: Android adds the status to it. Explicit, so only Belay's receiver gets it.
        PendingIntent.getBroadcast(context, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE).intentSender
    }

    fun abandon(context: Context, sessionId: Int) {
        try {
            context.packageManager.packageInstaller.abandonSession(sessionId)
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "update: session $sessionId not abandoned", e)
        }
    }

    private const val BUFFER = 64 * 1024
}

/**
 * Android's answer to Belay's own update session (not exported: only Belay's PendingIntent
 * reaches it). On success Android kills this Belay to install the new one, and starts it with
 * MY_PACKAGE_REPLACED, so the answer may never come or come to the new Belay: the update thread
 * records it, and the new Belay sees by its own version code that the update is done.
 */
class InstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val sha256 = intent.getStringExtra(SelfInstaller.EXTRA_SHA256)
        Log.i(Agent.TAG, "update: Android's answer: status $status" + (message?.let { ": $it" } ?: ""))
        val pending = goAsync()
        AgentUpdater.installed(context, sha256, status, message, sessionId) { pending.finish() }
    }
}
