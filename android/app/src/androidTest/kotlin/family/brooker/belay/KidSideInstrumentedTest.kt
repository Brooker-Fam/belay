package family.brooker.belay

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Telephony
import android.telecom.TelecomManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.WireRequest
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.store.AgentStore
import family.brooker.belay.ui.Emergency
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 7 on the phone: the kid takes a request back and changes its words through the agent
 * (Agent.withdraw, Agent.editRequest), and, as device owner, the emergency card's dialer, texting
 * app and emergency information stay open while a pause holds every other app. Made-up words only;
 * the requests go to the server like any other.
 */
@RunWith(AndroidJUnit4::class)
class KidSideInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val store = AgentStore.get(context)
    private val pm = context.packageManager

    @After
    fun putBack() {
        DebugTools.policyOverride = null
        agentStep()
    }

    @Test
    fun aPendingRequestCanBeTakenBack() {
        val id = talk("Made-up words to take back ${UUID.randomUUID()}")
        val withdrawn = CountDownLatch(1)
        var ok = false
        Agent.withdraw(context, id) {
            ok = it
            withdrawn.countDown()
        }
        assertTrue(withdrawn.await(30, TimeUnit.SECONDS))
        assertTrue("withdraw sent nothing", ok)
        val request = store.requests().first { it.id == id }
        assertNotNull(request.withdrawnAt)
        val sends = store.requestsQueuedFor("").filter { it.itemId == "request:$id:1" }
        val wire = Wire.json.decodeFromString(WireRequest.serializer(), sends.single().payload)
        assertEquals(request.withdrawnAt, wire.withdrawnAt)
        // Once is enough: a request taken back isn't open any more.
        val again = CountDownLatch(1)
        var twice = true
        Agent.withdraw(context, id) {
            twice = it
            again.countDown()
        }
        assertTrue(again.await(30, TimeUnit.SECONDS))
        assertFalse("a request was taken back twice", twice)
    }

    @Test
    fun aPendingRequestsWordsCanChange() {
        val id = talk("Made-up words ${UUID.randomUUID()}")
        val edited = CountDownLatch(1)
        Agent.editRequest(context, id, "  Different made-up words  ") { edited.countDown() }
        assertTrue(edited.await(30, TimeUnit.SECONDS))
        val request = store.requests().first { it.id == id }
        assertEquals("Different made-up words", request.reason)
        assertEquals(1, request.revision)
    }

    @Test
    fun theEmergencyCardStaysOpenWhileThePhoneIsPaused() {
        assumeTrue("not device owner", DeviceOwnerSetup.isDeviceOwner(context))
        val real = store.policy() ?: WirePolicy(version = 0)
        DebugTools.policyOverride = real.copy(version = real.version + VERSION_OFFSET, pause = WirePause(until = System.currentTimeMillis() + 120_000))
        agentStep()
        assertFalse("Belay paused itself", pm.isPackageSuspended(context.packageName))
        val dialer = context.getSystemService(TelecomManager::class.java)?.defaultDialerPackage
        val sms = Telephony.Sms.getDefaultSmsPackage(context)
        for (name in listOfNotNull(dialer, sms, Emergency.infoApp(context)).filter(::installed)) {
            assertFalse("$name is paused", pm.isPackageSuspended(name))
        }
        if (dialer != null) {
            val call = Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", "911", null)).setPackage(dialer)
            assertNotNull("the dialer doesn't take ACTION_DIAL", call.resolveActivity(pm))
        }
        if (sms != null) {
            val text = Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", "988", null)).setPackage(sms)
            assertNotNull("the texting app doesn't take smsto:", text.resolveActivity(pm))
        }
    }

    /** "Talk to my parent" with [words]; the new request's id. */
    private fun talk(words: String): String {
        val sent = CountDownLatch(1)
        Agent.talk(context, words) { sent.countDown() }
        assertTrue("talk wasn't sent", sent.await(30, TimeUnit.SECONDS))
        return store.requests().first { it.kind == WireRequestKind.TALK && it.reason == words }.id
    }

    private fun installed(name: String): Boolean = try {
        pm.getPackageInfo(name, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    private companion object {
        const val VERSION_OFFSET = 4_000_000
    }
}
