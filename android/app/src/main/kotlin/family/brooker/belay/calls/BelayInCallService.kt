package family.brooker.belay.calls

import android.os.Build
import android.os.OutcomeReceiver
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.CallEndpointException
import android.telecom.InCallService
import android.util.Log
import family.brooker.belay.Agent
import java.util.concurrent.Executor

/**
 * Belay's in-call service, which Telecom binds while Belay is the default dialer (its manifest entry
 * has IN_CALL_SERVICE_UI and IN_CALL_SERVICE_RINGING, docs/platform-notes.md T1 and T5). It never
 * returns a null binding: if it dies, Telecom carries on with the preloaded dialer (T2), with no
 * filtering, on purpose. The calls themselves are CallFlow's; this class is the binding, and the
 * call audio: mute, the speaker, Bluetooth (CallEndpoint on Android 14 and up, CallAudioState before).
 */
class BelayInCallService : InCallService() {
    private val ports = mutableListOf<TelecomCallPort>()
    private var endpoint: CallEndpoint? = null
    private var endpoints: List<CallEndpoint> = emptyList()
    private var muted = false
    private val direct = Executor { it.run() }

    override fun onCreate() {
        super.onCreate()
        CallNotices.ensureChannels(this)
        CallFlow.bound(this)
    }

    override fun onDestroy() {
        CallFlow.unbound(this)
        super.onDestroy()
    }

    override fun onCallAdded(call: Call) {
        val port = TelecomCallPort(call)
        ports += port
        CallFlow.added(this, port)
    }

    override fun onCallRemoved(call: Call) {
        val port = ports.firstOrNull { it.wraps(call) } ?: return
        ports -= port
        CallFlow.removed(this, port)
    }

    /** A volume key while a call rings: Belay plays the ringtone, so Belay stops it. */
    override fun onSilenceRinger() = CallFlow.silence()

    @Deprecated("CallAudioState is deprecated from Android 14; CallEndpoint below is used there")
    override fun onCallAudioStateChanged(audioState: CallAudioState) {
        if (Build.VERSION.SDK_INT >= 34) return
        muted = audioState.isMuted
        CallFlow.audioChanged(
            CallFlow.AudioUi(
                muted = audioState.isMuted,
                speaker = audioState.route == CallAudioState.ROUTE_SPEAKER,
                bluetooth = audioState.route == CallAudioState.ROUTE_BLUETOOTH,
                canBluetooth = audioState.supportedRouteMask and CallAudioState.ROUTE_BLUETOOTH != 0,
            ),
        )
    }

    override fun onCallEndpointChanged(callEndpoint: CallEndpoint) {
        endpoint = callEndpoint
        publishEndpoints()
    }

    override fun onAvailableCallEndpointsChanged(availableEndpoints: List<CallEndpoint>) {
        endpoints = availableEndpoints
        publishEndpoints()
    }

    override fun onMuteStateChanged(isMuted: Boolean) {
        muted = isMuted
        publishEndpoints()
    }

    private fun publishEndpoints() {
        if (Build.VERSION.SDK_INT < 34) return
        val type = endpoint?.endpointType
        CallFlow.audioChanged(
            CallFlow.AudioUi(
                muted = muted,
                speaker = type == CallEndpoint.TYPE_SPEAKER,
                bluetooth = type == CallEndpoint.TYPE_BLUETOOTH,
                canBluetooth = endpoints.any { it.endpointType == CallEndpoint.TYPE_BLUETOOTH },
            ),
        )
    }

    fun mute(on: Boolean) = setMuted(on)

    /** The speaker on; off: back to the earpiece (or a wired headset). */
    fun speaker(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 34) {
            val want = if (on) listOf(CallEndpoint.TYPE_SPEAKER) else listOf(CallEndpoint.TYPE_WIRED_HEADSET, CallEndpoint.TYPE_EARPIECE)
            endpointOf(want)?.let(::change)
        } else {
            @Suppress("DEPRECATION")
            setAudioRoute(if (on) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_WIRED_OR_EARPIECE)
        }
    }

    /** A Bluetooth headset or car, when one is there; off: back to the earpiece. */
    fun bluetooth(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 34) {
            val want = if (on) listOf(CallEndpoint.TYPE_BLUETOOTH) else listOf(CallEndpoint.TYPE_WIRED_HEADSET, CallEndpoint.TYPE_EARPIECE)
            endpointOf(want)?.let(::change)
        } else {
            @Suppress("DEPRECATION")
            setAudioRoute(if (on) CallAudioState.ROUTE_BLUETOOTH else CallAudioState.ROUTE_WIRED_OR_EARPIECE)
        }
    }

    private fun endpointOf(types: List<Int>): CallEndpoint? =
        if (Build.VERSION.SDK_INT >= 34) types.firstNotNullOfOrNull { type -> endpoints.firstOrNull { it.endpointType == type } } else null

    private fun change(target: CallEndpoint) {
        if (Build.VERSION.SDK_INT < 34) return
        requestCallEndpointChange(
            target,
            direct,
            object : OutcomeReceiver<Void, CallEndpointException> {
                override fun onResult(result: Void?) {}

                override fun onError(error: CallEndpointException) {
                    Log.w(Agent.TAG, "calls: the audio route didn't change: ${error.code}")
                }
            },
        )
    }
}
