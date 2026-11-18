package family.brooker.belay

import android.app.NotificationManager
import android.content.Context
import android.telecom.Call
import android.telecom.Connection
import android.telecom.TelecomManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.calls.CallFlow
import family.brooker.belay.calls.CallNotices
import family.brooker.belay.calls.CallPort
import family.brooker.belay.calls.EndedCall
import family.brooker.belay.calls.InCall
import family.brooker.belay.core.calls.CallRules
import family.brooker.belay.core.calls.CallsNow
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.Ring
import family.brooker.belay.core.calls.RingBecause
import family.brooker.belay.core.calls.WireCallAction
import family.brooker.belay.core.calls.WireCallDirection
import family.brooker.belay.core.calls.WireCallMode
import family.brooker.belay.core.calls.WireCallOutcome
import family.brooker.belay.core.calls.WireCallReason
import family.brooker.belay.core.calls.WireCalls
import family.brooker.belay.core.calls.WireContact
import family.brooker.belay.core.calls.WireOutgoing
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 5 on the phone, without a real call: Belay's in-call flow (calls/CallFlow.kt) driven with a
 * made-up call through its CallPort seam, with core's rules on a made-up policy and the records
 * kept here instead of in the store (nothing reaches the server). It runs on any emulator image:
 * a real incoming call needs the emulator console, which CI's calls block uses
 * (`adb emu gsm call`). Never 911 or 988: those are JVM-tested (AlwaysAllowedTest, CallRulesTest).
 */
@RunWith(AndroidJUnit4::class)
class CallFlowInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context = instrumentation.targetContext
    private val records = CopyOnWriteArrayList<EndedCall>()
    private val android = EmergencyNumbers { it == "911" }
    private val rules = WireCalls(mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.VOICEMAIL, outgoing = WireOutgoing.CONTACTS)

    @Before
    fun seams() {
        val now = CallsNow(calls = rules, contacts = listOf(SAM), now = System.currentTimeMillis())
        CallFlow.incomingRules = { _, call, _ -> CallRules.incoming(call, now, android) }
        CallFlow.outgoingRules = { _, number, _ -> CallRules.outgoing(number, now, android) }
        CallFlow.record = { _, call -> records += call }
        CallFlow.stepAfter = {}
    }

    @After
    fun putBack() {
        CallFlow.incomingRules = family.brooker.belay.calls.CallsGate::incoming
        CallFlow.outgoingRules = family.brooker.belay.calls.CallsGate::outgoing
        CallFlow.record = Agent::recordCall
        CallFlow.stepAfter = { Agent.handle(it, Trigger.CALL) }
        instrumentation.runOnMainSync { CallFlow.silence() }
    }

    @Test
    fun anIncomingCallFromAnApprovedContactRingsBelaysScreen() {
        val call = FakeCall(incoming = true, number = SAM.numbers.single())
        val decided = add(call)
        assertEquals(Ring.RING, decided.action)
        assertEquals(SAM.id, decided.contactId)
        assertTrue("Belay didn't ring for an approved contact", decided.rang)
        assertTrue("the call isn't on Belay's screen", CallFlow.calls.value.any { it.id == call.id && it.name == "Sam" })
        // NotificationManager posts and cancels asynchronously: wait for each, don't sample once.
        if (notificationsAllowed()) await("no incoming-call notification") { incomingShown() }
        assertFalse(call.rejected)
        // The caller gives up: a missed call from Sam, and nothing rings any more.
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        val record = records.single()
        assertEquals(WireCallOutcome.MISSED, record.outcome)
        assertEquals(SAM.id, record.contact?.id)
        assertFalse(CallFlow.ringing)
        await("the incoming-call notification stayed after the caller gave up") { !incomingShown() }
    }

    @Test
    fun anIncomingCallFromAnUnknownNumberIsRejectedAndNeverRings() {
        val call = FakeCall(incoming = true, number = "+15555550199")
        val decided = add(call)
        assertEquals(Ring.REJECT, decided.action)
        assertEquals(WireCallReason.UNKNOWN, decided.reason)
        assertFalse("a refused call rang", decided.rang)
        assertTrue("it wasn't rejected", call.rejected && call.unwanted)
        assertFalse(CallFlow.ringing)
        assertFalse(incomingShown())
        assertTrue(CallFlow.calls.value.none { it.id == call.id })
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        val record = records.single()
        assertEquals(WireCallOutcome.REJECTED, record.outcome)
        assertEquals(WireCallReason.UNKNOWN, record.reason)
        assertEquals("+15555550199", record.number)
    }

    @Test
    fun aWithheldCallerGoesToVoicemailWithoutRinging() {
        val call = FakeCall(incoming = true, number = null, presentation = TelecomManager.PRESENTATION_RESTRICTED)
        val decided = add(call)
        assertEquals(Ring.VOICEMAIL, decided.action)
        assertTrue("declined toward voicemail", call.rejected && !call.unwanted)
        assertFalse(decided.rang)
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        assertEquals(WireCallOutcome.VOICEMAIL, records.single().outcome)
        assertEquals(WireCallReason.WITHHELD, records.single().reason)
    }

    @Test
    fun aSpoofedContactNumberCountsAsUnknown() {
        val call = FakeCall(incoming = true, number = SAM.numbers.single(), verification = Connection.VERIFICATION_STATUS_FAILED)
        assertEquals(Ring.REJECT, add(call).action)
        assertTrue(call.rejected)
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
    }

    @Test
    fun aCallOnBelaysScreenHoldsScreenLocksUntilItEnds() {
        val call = FakeCall(incoming = true, number = SAM.numbers.single())
        assertEquals(Ring.RING, add(call).action)
        assertTrue("a ringing call should hold a screen lock", InCall.now(context).telecom)
        assertTrue("a ringing call should hold a screen lock", InCall.lockWaits(context, System.currentTimeMillis()))
        call.state = Call.STATE_ACTIVE
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        await("Belay still counts a call that ended") { !CallFlow.callOn }
    }

    @Test
    fun aSpoofed988CallerIdIsRefusedAndRecordedAsAStrangersCall() {
        // A made-up stranger showing 988's number with a failed check (CallerNumberVerification FAILED).
        val call = FakeCall(incoming = true, number = "988", verification = Connection.VERIFICATION_STATUS_FAILED)
        val decided = add(call)
        assertEquals(Ring.REJECT, decided.action)
        assertTrue(decided.unverified)
        assertFalse(decided.rang)
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        val record = records.single()
        assertTrue("the record says the caller id failed the check", record.unverified)
        assertFalse(record.callback)
        assertEquals(WireCallOutcome.REJECTED, record.outcome)
    }

    @Test
    fun aCallTelecomMarksAsPartOfAnEmergencyRingsFromANumberTheRulesRefuse() {
        // Emergency callback mode: a dispatcher calling back from a number that isn't a contact.
        val call = FakeCall(incoming = true, number = "+15555550160", emergency = true)
        val decided = add(call)
        assertEquals(Ring.RING, decided.action)
        assertEquals(RingBecause.EMERGENCY_MODE, decided.because)
        assertTrue("Belay didn't ring", decided.rang)
        assertFalse(call.rejected)
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        assertTrue("it rang only for the emergency: never sent", records.single().callback)
    }

    @Test
    fun aDecisionThatTakesTooLongLetsTheCallRing() {
        // The rules take 4 seconds (a cold store, say): the call rings after about 2, and the late
        // "reject" only names it.
        val gate = CountDownLatch(1)
        CallFlow.incomingRules = { _, call, _ ->
            gate.await(10, TimeUnit.SECONDS)
            CallRules.incoming(call, CallsNow(calls = rules, contacts = listOf(SAM), now = System.currentTimeMillis()), android)
        }
        val call = FakeCall(incoming = true, number = "+15555550199")
        val from = System.currentTimeMillis()
        instrumentation.runOnMainSync { CallFlow.added(context, call) }
        // On Belay's screen, ringing (whatever the phone's ringer mode lets it play).
        await("it didn't ring after the decision took too long") { CallFlow.calls.value.any { it.id == call.id } }
        val waited = System.currentTimeMillis() - from
        assertTrue("it rang after $waited ms, not about 2 s", waited in 1_500..6_000)
        gate.countDown()
        var decided: CallFlow.Decided? = null
        await("the late decision never came") {
            decided = CallFlow.decisions().lastOrNull { it.at >= from && !it.screened }
            decided != null
        }
        assertTrue(checkNotNull(decided).late)
        assertFalse("a late reject doesn't end a call that rings", call.rejected)
        // The kid doesn't answer: a missed call from a stranger, sent like any other.
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        val record = records.single()
        assertEquals(WireCallOutcome.MISSED, record.outcome)
        assertEquals("+15555550199", record.number)
        assertFalse(record.callback)
    }

    @Test
    fun anOutgoingCallBelayDidntPlaceToANumberItDoesntAllowIsEndedBeforeItConnects() {
        val call = FakeCall(incoming = false, number = "+15555550199", state = Call.STATE_DIALING)
        instrumentation.runOnMainSync { CallFlow.added(context, call) }
        await("the call wasn't ended") { call.disconnected }
        call.state = Call.STATE_DISCONNECTED
        instrumentation.runOnMainSync { CallFlow.removed(context, call) }
        val record = records.single()
        assertEquals(WireCallDirection.OUT, record.direction)
        assertEquals(WireCallOutcome.NOT_PLACED, record.outcome)
        assertEquals(WireCallReason.NOT_ALLOWED, record.reason)
    }

    /** Gives [call] to CallFlow as Telecom would, and waits for its decision. */
    private fun add(call: FakeCall): CallFlow.Decided {
        val from = System.currentTimeMillis()
        instrumentation.runOnMainSync { CallFlow.added(context, call) }
        var found: CallFlow.Decided? = null
        await("the call was never decided") {
            found = CallFlow.decisions().lastOrNull { it.at >= from && !it.screened }
            found != null
        }
        return checkNotNull(found)
    }

    private fun await(what: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < until) {
            var ok = false
            instrumentation.runOnMainSync { ok = condition() }
            if (ok) return
            Thread.sleep(50)
        }
        throw AssertionError(what)
    }

    private fun notificationsAllowed(): Boolean = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    private fun incomingShown(): Boolean =
        context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == CallNotices.INCOMING_ID }

    private companion object {
        /** A made-up contact (555-01xx). */
        val SAM = WireContact("c-sam", "Sam", listOf("+15555550123"))
    }

    /** A made-up call: what CallFlow did to it is recorded here. */
    private class FakeCall(
        override val incoming: Boolean,
        override val number: String?,
        override val presentation: Int = TelecomManager.PRESENTATION_ALLOWED,
        override val verification: Int = Connection.VERIFICATION_STATUS_NOT_VERIFIED,
        @Volatile override var state: Int = Call.STATE_RINGING,
        override val emergency: Boolean = false,
    ) : CallPort {
        override val id: String = "fake-" + System.nanoTime()
        override val lastEmergencyCallAt: Long? = null
        override val silentRingingRequested: Boolean = false
        override val connectTimeMillis: Long = 0
        override val canHold: Boolean = false

        @Volatile var rejected = false

        @Volatile var unwanted = false

        @Volatile var disconnected = false
        private var onChange: (() -> Unit)? = null

        override fun answer() {
            state = Call.STATE_ACTIVE
            onChange?.invoke()
        }

        override fun reject(unwanted: Boolean) {
            rejected = true
            this.unwanted = unwanted
        }

        override fun disconnect() {
            disconnected = true
        }

        override fun hold() {}
        override fun unhold() {}
        override fun playDtmf(digit: Char) {}
        override fun stopDtmf() {}
        override fun selectFirstAccount() {}

        override fun listen(onChange: () -> Unit) {
            this.onChange = onChange
        }

        override fun unlisten() {
            onChange = null
        }
    }
}
