package family.brooker.belay.calls

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.telecom.Connection
import android.telecom.TelecomManager
import android.telephony.PhoneNumberUtils
import android.util.Log
import androidx.annotation.VisibleForTesting
import family.brooker.belay.Agent
import family.brooker.belay.R
import family.brooker.belay.Trigger
import family.brooker.belay.core.calls.CallRules
import family.brooker.belay.core.calls.IncomingCall
import family.brooker.belay.core.calls.IncomingDecision
import family.brooker.belay.core.calls.OutgoingDecision
import family.brooker.belay.core.calls.Presentation
import family.brooker.belay.core.calls.Ring
import family.brooker.belay.core.calls.RingBecause
import family.brooker.belay.core.calls.Verification
import family.brooker.belay.core.calls.WireCallDirection
import family.brooker.belay.core.calls.WireCallOutcome
import family.brooker.belay.core.calls.WireCallReason
import family.brooker.belay.core.calls.WireContact
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executors

/** A call that ended, for Belay's own record and, with `log`, POST /api/v1/calls (Agent.recordCall). */
data class EndedCall(
    val at: Long,
    val direction: WireCallDirection,
    /** As core's PhoneNumbers.key makes it; null for a withheld caller. */
    val number: String?,
    val contact: WireContact?,
    val durationS: Int,
    val outcome: WireCallOutcome,
    val reason: WireCallReason?,
    /** It rang only because of an emergency (the 2-hour window, or Telecom's mark): kept on the phone, never sent (core's CallRecords). */
    val callback: Boolean = false,
    /** The network's check of the caller id failed: a stranger's call, whatever number it shows (core's CallRecords). */
    val unverified: Boolean = false,
)

/**
 * Belay's calls, as its InCallService gets them (docs/platform-notes.md T4, T5), on the main thread:
 * - Incoming: each call is decided off the main thread (CallsGate, core's CallRules) before
 *   anything rings, every time, whether or not the screening service saw it (withheld, unknown and
 *   payphone callers never reach screening, and a call screening app the kid chose replaces
 *   Belay's). "Ring" starts Belay's own ringer and the incoming-call notification; "reject" and
 *   "voicemail" end it at once (as unwanted, or as declined toward voicemail), so it never rings
 *   and Telecom doesn't count it as missed. A decision that takes longer than 2 seconds
 *   (CallRules.DECIDE_WITHIN_MS) lets the call ring, and only names it when it comes. A call
 *   Telecom marks as part of an emergency (emergency callback mode, T18) always rings.
 * - Outgoing: a call Belay didn't place (another app's dial pad) is decided too, and ended before it
 *   connects when the family's rules don't allow the number. A call to 911 or 988 (with a caller-id
 *   code before it or not) opens the 2-hour callback window.
 * - Every call that ends becomes an EndedCall (Agent.recordCall keeps it unless it's with an
 *   emergency number, 988 or a private number), and the agent takes a step (debug builds write
 *   their state for CI then).
 * If anything goes wrong deciding, the call rings or goes through: calls fail open. The log says
 * what Belay did with a call, never why (why is in the debug state, only in debug builds).
 */
object CallFlow {
    /** What the call screen shows for one call. */
    data class CallUi(
        val id: String,
        val incoming: Boolean,
        /** android.telecom.Call.STATE_*. */
        val state: Int,
        /** The approved contact's name (the family's words), if it's one. */
        val name: String?,
        /** The number, formatted for the phone's country; null when withheld. */
        val number: String?,
        val connectedAt: Long?,
        val canHold: Boolean,
    )

    /** The call's audio, from the InCallService. */
    data class AudioUi(val muted: Boolean = false, val speaker: Boolean = false, val bluetooth: Boolean = false, val canBluetooth: Boolean = false)

    /**
     * An incoming call as decided, for the debug state: no numbers. [late]: the decision took longer
     * than CallRules.DECIDE_WITHIN_MS, so the call rang whatever it said.
     */
    data class Decided(
        val at: Long,
        val action: Ring,
        val because: RingBecause?,
        val reason: WireCallReason?,
        val contactId: String?,
        val rang: Boolean,
        val screened: Boolean,
        val unverified: Boolean = false,
        val late: Boolean = false,
    )

    private class Tracked(val port: CallPort, val addedAt: Long) {
        var key: String? = null
        var contact: WireContact? = null
        var incoming: IncomingDecision? = null
        var outgoing: OutgoingDecision? = null

        /** On Belay's screen: an incoming call that rings, or an outgoing one that goes through. */
        var shown = false

        /** Belay started ringing for it (once: a volume key that silenced it isn't undone). */
        var rang = false

        /** Its decision took too long, so it rang whatever the decision says when it comes. */
        var late = false
        var connectedAt: Long? = null
        var declinedByKid = false
        var notPlaced = false

        /** Telecom removed it, at [endedAt]; recorded once it's also decided. */
        var endedAt: Long? = null
        var recorded = false

        val decided: Boolean get() = incoming != null || outgoing != null
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-calls") }
    private val tracked = LinkedHashMap<String, Tracked>()
    private var service: BelayInCallService? = null

    private val _calls = MutableStateFlow<List<CallUi>>(emptyList())
    val calls: StateFlow<List<CallUi>> = _calls.asStateFlow()

    private val _audio = MutableStateFlow(AudioUi())
    val audio: StateFlow<AudioUi> = _audio.asStateFlow()

    private val decided = ArrayDeque<Decided>()

    /** The last incoming decisions, newest last (debug state). */
    fun decisions(): List<Decided> = synchronized(decided) { decided.toList() }

    /** Whether Belay is ringing for a call now (debug state, tests). */
    val ringing: Boolean get() = CallRinger.ringing

    // Seams, so an instrumented test can drive a made-up call without the store or the server.
    @VisibleForTesting
    internal var incomingRules: (Context, IncomingCall, Long) -> IncomingDecision = CallsGate::incoming

    @VisibleForTesting
    internal var outgoingRules: (Context, String?, Long) -> OutgoingDecision = CallsGate::outgoing

    @VisibleForTesting
    internal var record: (Context, EndedCall) -> Unit = Agent::recordCall

    @VisibleForTesting
    internal var stepAfter: (Context) -> Unit = { Agent.handle(it, Trigger.CALL) }

    fun bound(service: BelayInCallService) {
        this.service = service
    }

    /** Telecom unbound Belay (every call ended, or the preloaded dialer took over an emergency call). */
    fun unbound(service: BelayInCallService) {
        if (this.service !== service) return
        this.service = null
        if (tracked.isEmpty()) return
        Log.i(Agent.TAG, "calls: Telecom unbound Belay with ${tracked.size} calls still on")
        tracked.values.forEach { it.port.unlisten() }
        tracked.clear()
        CallRinger.stop()
        CallNotices.cancelIncoming(service)
        CallNotices.cancelOngoing(service)
        publish()
    }

    fun added(context: Context, port: CallPort) {
        val app = context.applicationContext
        val t = Tracked(port, System.currentTimeMillis())
        tracked[port.id] = t
        port.listen { changed(app, port.id) }
        if (port.incoming) decideIncoming(app, t) else decideOutgoing(app, t)
        publish()
    }

    private fun decideIncoming(app: Context, t: Tracked) {
        val port = t.port
        val raw = port.number
        val presentation = if (port.presentation == TelecomManager.PRESENTATION_ALLOWED && !raw.isNullOrBlank()) Presentation.NUMBER else Presentation.WITHHELD
        val verification = when (port.verification) {
            Connection.VERIFICATION_STATUS_PASSED -> Verification.PASSED
            Connection.VERIFICATION_STATUS_FAILED -> Verification.FAILED
            else -> Verification.NOT_VERIFIED
        }
        val callbackAt = port.lastEmergencyCallAt
        val emergency = port.emergency
        // Calls fail open: if the decision isn't here in 2 seconds, the call rings anyway.
        main.postDelayed({ late(app, t) }, CallRules.DECIDE_WITHIN_MS)
        worker.execute {
            val decision = try {
                val key = if (presentation == Presentation.NUMBER) AndroidCalls.key(app, raw) else null
                key to incomingRules(app, IncomingCall(key, presentation, verification, callbackAt, emergency), t.addedAt)
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "calls: deciding an incoming call failed, so it rings", e)
                null to IncomingDecision(Ring.RING, because = RingBecause.CALLS_OFF)
            }
            main.post { applyIncoming(app, t, decision.first, decision.second) }
        }
    }

    /** The decision didn't come in time: the call rings, as if the rules let it. */
    private fun late(app: Context, t: Tracked) {
        if (t.incoming != null || t.late || tracked[t.port.id] !== t || t.port.state == Call.STATE_DISCONNECTED) return
        t.late = true
        t.shown = true
        if (t.port.state == Call.STATE_RINGING) ring(app, t)
        Log.w(Agent.TAG, "calls: deciding an incoming call took too long, so it rings")
        publish()
    }

    private fun applyIncoming(app: Context, t: Tracked, key: String?, decision: IncomingDecision) {
        t.key = key
        t.contact = decision.contact
        t.incoming = decision
        val live = tracked[t.port.id] === t && t.port.state != Call.STATE_DISCONNECTED
        // A late decision only names the call: it already rings, and a call that rings isn't refused.
        if (live && !t.late) {
            when (decision.action) {
                Ring.RING -> {
                    t.shown = true
                    if (t.port.state == Call.STATE_RINGING) ring(app, t)
                }
                Ring.REJECT -> t.port.reject(unwanted = true)
                Ring.VOICEMAIL -> t.port.reject(unwanted = false)
            }
        }
        remember(Decided(t.addedAt, decision.action, decision.because, decision.reason, decision.contact?.id, t.rang, screened = false, decision.unverified, t.late))
        // It ended while it was being decided: recorded now, with what the decision knows.
        if (t.endedAt != null) recordOnce(app, t)
        // What Belay did, never why: the reason would say that the kid called 911 or 988.
        Log.i(Agent.TAG, "calls: incoming call: ${if (t.late) "rang (decided late)" else decision.action.name.lowercase()}")
        publish()
        stepAfter(app)
    }

    /** Rings for [t], once; quietly (vibration only) while another call is on, or when a screening app asked. */
    private fun ring(app: Context, t: Tracked) {
        if (t.rang) return
        t.rang = true
        val busy = tracked.values.any { it !== t && it.shown && it.port.state in ON_CALL }
        CallRinger.start(app, quiet = busy || t.port.silentRingingRequested)
        CallNotices.incoming(app, t.port.id, who(app, t))
    }

    private fun decideOutgoing(app: Context, t: Tracked) {
        val raw = t.port.number
        worker.execute {
            val result = try {
                val key = AndroidCalls.key(app, raw)
                key to (CallPlacer.placedRecently(key, t.addedAt) ?: outgoingRules(app, key, t.addedAt))
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "calls: deciding an outgoing call failed, so it goes through", e)
                null to OutgoingDecision(true)
            }
            main.post { applyOutgoing(app, t, result.first, result.second) }
        }
    }

    private fun applyOutgoing(app: Context, t: Tracked, key: String?, decision: OutgoingDecision) {
        t.key = key
        t.contact = decision.contact
        t.outgoing = decision
        if (decision.alwaysAllowed != null) CallsGate.emergencyContact(app, t.addedAt)
        if (tracked[t.port.id] !== t || t.port.state == Call.STATE_DISCONNECTED) {
            if (t.endedAt != null) recordOnce(app, t)
            return
        }
        if (!decision.allowed) {
            t.notPlaced = true
            t.port.disconnect()
            Log.i(Agent.TAG, "calls: an outgoing call the family's rules don't allow was ended before it connected")
        } else {
            t.shown = true
            // A phone with two SIMs and no default asks which one: only once the call is allowed.
            if (t.port.state == Call.STATE_SELECT_PHONE_ACCOUNT) t.port.selectFirstAccount()
            CallNotices.ongoing(app, t.port.id, who(app, t), app.getString(R.string.calls_dialing))
            openScreen(app)
        }
        publish()
        stepAfter(app)
    }

    private fun changed(app: Context, id: String) {
        val t = tracked[id] ?: return
        val state = t.port.state
        if (state == Call.STATE_SELECT_PHONE_ACCOUNT && t.outgoing?.allowed == true) t.port.selectFirstAccount()
        // An incoming call let through that only now rings (it was decided before it got there).
        if (state == Call.STATE_RINGING && t.port.incoming && t.shown) ring(app, t)
        if (state == Call.STATE_ACTIVE && t.connectedAt == null) {
            t.connectedAt = t.port.connectTimeMillis.takeIf { it > 0 } ?: System.currentTimeMillis()
        }
        stopRingingUnlessNeeded(app)
        if (t.shown && state in ON_CALL) {
            CallNotices.ongoing(app, t.port.id, who(app, t), app.getString(if (state == Call.STATE_HOLDING) R.string.calls_on_hold else R.string.calls_in_call))
        }
        publish()
    }

    fun removed(context: Context, port: CallPort) {
        val app = context.applicationContext
        val t = tracked.remove(port.id) ?: return
        port.unlisten()
        t.endedAt = System.currentTimeMillis()
        stopRingingUnlessNeeded(app)
        if (tracked.values.none { it.shown && it.port.state in ON_CALL }) CallNotices.cancelOngoing(app)
        // Not decided yet: its decision records it when it comes (with the number it found).
        if (t.decided) recordOnce(app, t)
        publish()
        stepAfter(app)
    }

    private fun recordOnce(app: Context, t: Tracked) {
        if (t.recorded) return
        t.recorded = true
        record(app, ended(t))
    }

    /** A call Belay's screening service refused, which never reached the InCallService: recorded here. */
    fun screened(context: Context, at: Long, key: String?, decision: IncomingDecision) {
        val app = context.applicationContext
        remember(Decided(at, decision.action, decision.because, decision.reason, decision.contact?.id, rang = false, screened = true, decision.unverified))
        val outcome = if (decision.action == Ring.REJECT) WireCallOutcome.REJECTED else WireCallOutcome.VOICEMAIL
        record(app, EndedCall(at, WireCallDirection.IN, key, decision.contact, 0, outcome, decision.reason, unverified = decision.unverified))
        stepAfter(app)
    }

    private fun stopRingingUnlessNeeded(app: Context) {
        val ringingCall = tracked.values.any { it.shown && it.port.incoming && it.port.state == Call.STATE_RINGING }
        if (!ringingCall) {
            CallRinger.stop()
            CallNotices.cancelIncoming(app)
        }
    }

    private fun ended(t: Tracked): EndedCall {
        val now = t.endedAt ?: System.currentTimeMillis()
        val duration = t.connectedAt?.let { ((now - it) / 1000).toInt() } ?: 0
        val answered = t.connectedAt != null
        val (outcome, reason) = if (t.port.incoming) {
            // A late decision didn't refuse the call: it rang.
            val d = t.incoming?.takeUnless { t.late }
            when {
                d?.action == Ring.REJECT -> WireCallOutcome.REJECTED to d.reason
                d?.action == Ring.VOICEMAIL -> WireCallOutcome.VOICEMAIL to d.reason
                answered -> WireCallOutcome.ANSWERED to null
                t.declinedByKid -> WireCallOutcome.REJECTED to null
                else -> WireCallOutcome.MISSED to null
            }
        } else {
            when {
                t.notPlaced -> WireCallOutcome.NOT_PLACED to WireCallReason.NOT_ALLOWED
                answered -> WireCallOutcome.ANSWERED to null
                else -> WireCallOutcome.MISSED to null
            }
        }
        val direction = if (t.port.incoming) WireCallDirection.IN else WireCallDirection.OUT
        val callback = t.port.incoming && t.incoming?.callback == true
        val unverified = t.port.incoming && t.incoming?.unverified == true
        return EndedCall(t.addedAt, direction, t.key, t.contact, duration, outcome, reason, callback, unverified)
    }

    // What the kid does, from the call screen and the notifications.

    fun answer(context: Context, id: String) {
        val t = tracked[id] ?: return
        CallRinger.stop()
        CallNotices.cancelIncoming(context)
        t.port.answer()
        openScreen(context.applicationContext)
    }

    fun decline(context: Context, id: String) {
        val t = tracked[id] ?: return
        t.declinedByKid = true
        CallRinger.stop()
        CallNotices.cancelIncoming(context)
        t.port.reject(unwanted = false)
    }

    fun hangUp(id: String) {
        tracked[id]?.port?.disconnect()
    }

    fun hold(id: String, on: Boolean) {
        val port = tracked[id]?.port ?: return
        if (on) port.hold() else port.unhold()
    }

    /** A key on the in-call keypad: its tone, for a moment. */
    fun dtmf(id: String, digit: Char) {
        val port = tracked[id]?.port ?: return
        port.playDtmf(digit)
        main.postDelayed({ port.stopDtmf() }, DTMF_MS)
    }

    /** A volume key while ringing (InCallService.onSilenceRinger). */
    fun silence() = CallRinger.stop()

    fun mute(on: Boolean) = service?.mute(on)

    fun speaker(on: Boolean) = service?.speaker(on)

    fun bluetooth(on: Boolean) = service?.bluetooth(on)

    /** From the InCallService. */
    fun audioChanged(audio: AudioUi) {
        _audio.value = audio
    }

    fun openScreen(context: Context) {
        try {
            context.startActivity(CallActivity.intent(context))
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "calls: the call screen didn't open", e)
        }
    }

    private fun who(context: Context, t: Tracked): String =
        t.contact?.name?.takeIf { it.isNotBlank() } ?: display(context, t.port.number) ?: context.getString(R.string.calls_unknown_caller)

    /** [number] formatted for the phone's country, or null for none. */
    fun display(context: Context, number: String?): String? {
        if (number.isNullOrBlank()) return null
        val country = AndroidCalls.country(context) ?: return number
        return try {
            PhoneNumberUtils.formatNumber(number, country) ?: number
        } catch (e: RuntimeException) {
            number
        }
    }

    private fun remember(d: Decided) = synchronized(decided) {
        decided.addLast(d)
        while (decided.size > MAX_DECIDED) decided.removeFirst()
    }

    @Volatile
    private var summaryNow: List<Map<String, String?>> = emptyList()

    /** For the debug state: the calls on now, without numbers (as the main thread last published them). */
    fun summary(): List<Map<String, String?>> = summaryNow

    @Volatile
    private var callOnNow = false

    /**
     * A call is on in Belay's own in-call service: ringing, being placed or going on (as the main
     * thread last published it, so any thread may ask). A screen lock waits for it (enforce/InCall.kt).
     */
    val callOn: Boolean get() = callOnNow

    private fun publish() {
        callOnNow = tracked.values.any { it.port.state != Call.STATE_DISCONNECTED }
        summaryNow = tracked.values.map { t ->
            mapOf(
                "direction" to if (t.port.incoming) "in" else "out",
                "state" to t.port.state.toString(),
                "shown" to t.shown.toString(),
                "action" to (t.incoming?.action?.name?.lowercase() ?: if (t.outgoing?.allowed == false) "not_allowed" else null),
                "contact_id" to t.contact?.id,
            )
        }
        _calls.value = tracked.values.filter { it.shown && it.port.state != Call.STATE_DISCONNECTED }.map { t ->
            CallUi(
                id = t.port.id,
                incoming = t.port.incoming,
                state = t.port.state,
                name = t.contact?.name?.takeIf { it.isNotBlank() },
                number = t.port.number.takeIf { t.port.presentation == TelecomManager.PRESENTATION_ALLOWED },
                connectedAt = t.connectedAt,
                canHold = t.port.canHold,
            )
        }
    }

    /** States of a call going on, or being placed. */
    private val ON_CALL = setOf(Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_ACTIVE, Call.STATE_HOLDING, Call.STATE_PULLING_CALL)

    private const val DTMF_MS = 200L
    private const val MAX_DECIDED = 10

    /** An intent that opens Belay's dialer. */
    fun dialer(context: Context): Intent = Intent(context, DialerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
