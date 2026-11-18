package family.brooker.belay.calls

import android.os.Build
import android.os.Bundle
import android.telecom.Call
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountSuggestion
import android.telecom.VideoProfile

/**
 * A call as Belay's in-call code sees it: a seam over android.telecom.Call (final, with no public
 * constructor), so an instrumented test can drive CallFlow with a made-up call.
 */
interface CallPort {
    /** Stable while the call lasts. */
    val id: String
    val incoming: Boolean

    /** android.telecom.Call.STATE_*. */
    val state: Int

    /** The number the network gave or the kid dialed (`tel:` only); null when there's none. */
    val number: String?

    /** TelecomManager.PRESENTATION_*. */
    val presentation: Int

    /** Connection.VERIFICATION_STATUS_*. */
    val verification: Int

    /** Telecom's time of the last emergency call, when it put one on this call. */
    val lastEmergencyCallAt: Long?

    /**
     * Telecom marked this call as part of an emergency: the phone is in emergency callback mode, or
     * the network identified it as an emergency call (docs/platform-notes.md T18).
     */
    val emergency: Boolean

    /** Another call screening app asked for this call not to ring. */
    val silentRingingRequested: Boolean

    /** When it connected (0 before). */
    val connectTimeMillis: Long
    val canHold: Boolean

    fun answer()

    /** [unwanted]: a nuisance (REJECT_REASON_UNWANTED); else declined, toward voicemail (REJECT_REASON_DECLINED). */
    fun reject(unwanted: Boolean)
    fun disconnect()
    fun hold()
    fun unhold()
    fun playDtmf(digit: Char)
    fun stopDtmf()

    /** A phone with two SIMs and no default asks which to use: Belay takes the first Android suggests. */
    fun selectFirstAccount()

    /** [onChange] runs on the main thread whenever the call's state or details change. */
    fun listen(onChange: () -> Unit)
    fun unlisten()
}

/** A real call, from Belay's InCallService. */
class TelecomCallPort(private val call: Call) : CallPort {
    private var callback: Call.Callback? = null

    override val id: String = "call-" + Integer.toHexString(System.identityHashCode(call))
    override val incoming: Boolean get() = call.details.callDirection == Call.Details.DIRECTION_INCOMING
    override val state: Int get() = call.details.state
    override val number: String? get() = call.details.handle?.takeIf { it.scheme == PhoneAccount.SCHEME_TEL }?.schemeSpecificPart
    override val presentation: Int get() = call.details.handlePresentation
    override val verification: Int get() = call.details.callerNumberVerificationStatus
    override val lastEmergencyCallAt: Long?
        get() = call.details.extras?.getLong(Call.EXTRA_LAST_EMERGENCY_CALLBACK_TIME_MILLIS, 0L)?.takeIf { it > 0 }
    override val emergency: Boolean
        get() = call.details.hasProperty(Call.Details.PROPERTY_EMERGENCY_CALLBACK_MODE) ||
            call.details.hasProperty(Call.Details.PROPERTY_NETWORK_IDENTIFIED_EMERGENCY_CALL)
    override val silentRingingRequested: Boolean get() = call.details.extras?.getBoolean(Call.EXTRA_SILENT_RINGING_REQUESTED, false) == true
    override val connectTimeMillis: Long get() = call.details.connectTimeMillis
    override val canHold: Boolean get() = call.details.can(Call.Details.CAPABILITY_HOLD)

    override fun answer() = call.answer(VideoProfile.STATE_AUDIO_ONLY)
    override fun reject(unwanted: Boolean) = call.reject(if (unwanted) Call.REJECT_REASON_UNWANTED else Call.REJECT_REASON_DECLINED)
    override fun disconnect() = call.disconnect()
    override fun hold() = call.hold()
    override fun unhold() = call.unhold()
    override fun playDtmf(digit: Char) = call.playDtmfTone(digit)
    override fun stopDtmf() = call.stopDtmfTone()

    override fun selectFirstAccount() {
        val handle = suggestions(call.details.extras)?.firstOrNull()?.phoneAccountHandle ?: return
        call.phoneAccountSelected(handle, false)
    }

    private fun suggestions(extras: Bundle?): List<PhoneAccountSuggestion>? = when {
        extras == null -> null
        Build.VERSION.SDK_INT >= 33 -> extras.getParcelableArrayList(Call.EXTRA_SUGGESTED_PHONE_ACCOUNTS, PhoneAccountSuggestion::class.java)
        else -> {
            @Suppress("DEPRECATION")
            extras.getParcelableArrayList(Call.EXTRA_SUGGESTED_PHONE_ACCOUNTS)
        }
    }

    override fun listen(onChange: () -> Unit) {
        unlisten()
        val cb = object : Call.Callback() {
            override fun onStateChanged(call: Call, state: Int) = onChange()
            override fun onDetailsChanged(call: Call, details: Call.Details) = onChange()
        }
        callback = cb
        call.registerCallback(cb)
    }

    override fun unlisten() {
        callback?.let { call.unregisterCallback(it) }
        callback = null
    }

    /** The same Telecom call. */
    fun wraps(other: Call): Boolean = other === call
}
