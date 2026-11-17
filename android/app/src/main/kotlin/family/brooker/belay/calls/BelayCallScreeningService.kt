package family.brooker.belay.calls

import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.telecom.CallScreeningService
import android.telecom.Connection
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.calls.IncomingCall
import family.brooker.belay.core.calls.IncomingDecision
import family.brooker.belay.core.calls.Presentation
import family.brooker.belay.core.calls.Ring
import family.brooker.belay.core.calls.RingBecause
import family.brooker.belay.core.calls.Verification
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Belay's call screening, which Telecom asks about each incoming call with a caller id while Belay is
 * the default dialer and no other call screening app is chosen (docs/platform-notes.md T4), within 5
 * seconds and before anything rings. Refused calls are blocked here, so they never reach any in-call
 * service (a Bluetooth car's either): "reject" ends it, "voicemail" leaves it unanswered for the
 * network to send to voicemail; neither shows a notification. Withheld, unknown and payphone callers
 * never get here: Belay's InCallService decides those, and every other call again (CallFlow). If the
 * decision isn't ready in 4 seconds, the call is let through to the InCallService.
 */
class BelayCallScreeningService : CallScreeningService() {
    private val main = Handler(Looper.getMainLooper())

    override fun onScreenCall(callDetails: Call.Details) {
        if (callDetails.callDirection != Call.Details.DIRECTION_INCOMING) {
            respondToCall(callDetails, CallResponse.Builder().build())
            return
        }
        val app = applicationContext
        val at = System.currentTimeMillis()
        val raw = callDetails.handle?.schemeSpecificPart
        val verification = when (callDetails.callerNumberVerificationStatus) {
            Connection.VERIFICATION_STATUS_PASSED -> Verification.PASSED
            Connection.VERIFICATION_STATUS_FAILED -> Verification.FAILED
            else -> Verification.NOT_VERIFIED
        }
        val answered = AtomicBoolean(false)
        main.postDelayed({
            if (answered.compareAndSet(false, true)) {
                Log.w(Agent.TAG, "calls: screening took too long; the in-call service decides")
                respondToCall(callDetails, CallResponse.Builder().build())
            }
        }, TIMEOUT_MS)
        worker.execute {
            val (key, decision) = try {
                val key = AndroidCalls.key(app, raw)
                val presentation = if (key == null) Presentation.WITHHELD else Presentation.NUMBER
                key to CallsGate.incoming(app, IncomingCall(key, presentation, verification), at)
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "calls: screening failed; the in-call service decides", e)
                null to IncomingDecision(Ring.RING, because = RingBecause.CALLS_OFF)
            }
            if (!answered.compareAndSet(false, true)) return@execute
            val response = when (decision.action) {
                Ring.RING -> CallResponse.Builder().build()
                Ring.REJECT -> CallResponse.Builder().setDisallowCall(true).setRejectCall(true).setSkipNotification(true).build()
                Ring.VOICEMAIL -> CallResponse.Builder().setDisallowCall(true).setRejectCall(false).setSkipNotification(true).build()
            }
            respondToCall(callDetails, response)
            if (decision.action != Ring.RING) {
                Log.i(Agent.TAG, "calls: screened out an incoming call: ${decision.action.name.lowercase()} (${decision.reason?.name?.lowercase()})")
                main.post { CallFlow.screened(app, at, key, decision) }
            }
        }
    }

    private companion object {
        const val TIMEOUT_MS = 4_000L
        val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-screening") }
    }
}
