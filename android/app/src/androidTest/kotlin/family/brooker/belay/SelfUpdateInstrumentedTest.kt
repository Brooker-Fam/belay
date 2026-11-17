package family.brooker.belay

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.ParcelFileDescriptor
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.AgentUpdates
import family.brooker.belay.core.DownloadFacts
import family.brooker.belay.core.UpdateCheck
import family.brooker.belay.core.WireAgentUpdate
import family.brooker.belay.update.Apks
import family.brooker.belay.update.SelfInstaller
import family.brooker.belay.update.UpdateDownload
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Phase 6, the parts of Belay's self-update that can run on the made-up fixture app instead
 * of Belay: what PackageManager reads from an APK for core's check, and a PackageInstaller
 * session as device owner, which installs the fixture's v2 over v1 with nobody confirming
 * (Android answers STATUS_SUCCESS, never STATUS_PENDING_USER_ACTION). As device owner (skipped
 * otherwise), with the fixture APKs pushed like FixtureEventsInstrumentedTest's. Belay's own
 * update runs end to end in ci-emulator-test.sh. The fixture is removed afterwards.
 */
@RunWith(AndroidJUnit4::class)
class SelfUpdateInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val copy = File(context.cacheDir, "fixture-v2.apk")

    @Before
    fun deviceOwnerAndFixtures() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        val listed = shell("ls $V1 $V2")
        assumeTrue("fixture APKs not in /data/local/tmp", V1 in listed && V2 in listed)
    }

    @After
    fun removeTheFixture() {
        shell("pm uninstall $FIXTURE")
        copy.delete()
    }

    @Test
    fun aDeviceOwnersSessionInstallsAnUpdateWithNobodyConfirming() {
        shell("pm uninstall $FIXTURE")
        assertTrue(shell("pm install -r -t $V1").contains("Success"))
        copyFromShell(V2, copy)

        // What Belay's check reads from a downloaded APK.
        val archive = Apks.archive(context, copy)
        assertNotNull("Android couldn't read the fixture APK", archive)
        archive!!
        assertEquals(FIXTURE, archive.packageName)
        assertEquals(2L, archive.versionCode)
        val v1 = Apks.installed(context, FIXTURE)
        assertEquals(1L, v1.versionCode)
        assertTrue(archive.signers.isNotEmpty() && archive.signers.all { it.matches(Regex("[0-9a-f]{64}")) })
        assertEquals("v1 and v2 are signed with the same debug key", v1.signers, archive.signers)

        // Core's check passes it as an update of v1, and refuses it as an update of Belay.
        val offer = WireAgentUpdate(versionCode = 2, sha256 = UpdateDownload.sha256(copy), size = copy.length())
        val download = DownloadFacts(offer.sha256, offer.size)
        assertEquals(UpdateCheck.Ok, AgentUpdates.check(offer, download, archive, v1))
        assertEquals(
            UpdateCheck.Refused("The update is the app $FIXTURE, not Belay.", final = true),
            AgentUpdates.check(offer, download, archive, Apks.self(context)),
        )
        val otherKey = AgentUpdates.check(offer, download, archive, v1.copy(signers = setOf("00".repeat(32))))
        assertTrue("$otherKey", otherKey is UpdateCheck.Refused && otherKey.final)

        // The session, as Belay commits its own: Android answers success, without asking anyone.
        val (status, message) = installAndWait(copy)
        assertEquals("Android's answer: $message", PackageInstaller.STATUS_SUCCESS, status)
        assertEquals(2L, Apks.installed(context, FIXTURE).versionCode)
    }

    /** Commits [apk] for the fixture with SelfInstaller and waits for Android's status and message. */
    private fun installAndWait(apk: File): Pair<Int, String?> {
        val action = "family.brooker.belay.test.INSTALL_STATUS.${System.nanoTime()}"
        val answers = LinkedBlockingQueue<Pair<Int, String?>>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                answers.offer(
                    intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) to
                        intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                )
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
            SelfInstaller.commit(context, apk, FIXTURE) { sessionId ->
                val intent = Intent(action).setPackage(context.packageName)
                PendingIntent.getBroadcast(context, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE).intentSender
            }
            val answer = answers.poll(2, TimeUnit.MINUTES)
            assertNotNull("Android didn't answer the session within 2 minutes", answer)
            return answer!!
        } finally {
            context.unregisterReceiver(receiver)
        }
    }

    /** The shell can read /data/local/tmp; Belay can't. */
    private fun copyFromShell(path: String, to: File) {
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat $path")).use { input ->
            to.outputStream().use { input.copyTo(it) }
        }
        assertTrue("$path wasn't copied", to.length() > 0)
    }

    /** As the shell user; its standard output. */
    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private companion object {
        const val FIXTURE = "family.brooker.belay.fixture"
        const val V1 = "/data/local/tmp/belay-fixture-v1.apk"
        const val V2 = "/data/local/tmp/belay-fixture-v2.apk"
    }
}
