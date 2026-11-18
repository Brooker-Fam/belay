package family.brooker.belay.calls

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.telecom.TelecomManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Whether a call is on now, for the screen locks that wait for one (core's ScreenLocks), from what
 * Belay may read on Android 17 (docs/platform-notes.md T20):
 * - Belay's own in-call service's calls (CallFlow.callOn), while it's the dialer;
 * - TelecomManager.isInCall, which Telecom answers for the default dialer without a permission (any
 *   other app needs READ_PHONE_STATE, which Belay doesn't hold): every managed call, an emergency
 *   call the preloaded dialer took included;
 * - Android's audio mode (AudioManager.getMode, no permission): ringing, a carrier call, or a call
 *   in an app, whoever placed it.
 * While a lock waits, Belay listens for the audio mode to go back to normal and takes a step then;
 * the policy timer looks again every minute too (ScreenLocks.RECHECK_MS). From any thread.
 */
object InCall {
    private val CALL_MODES: Set<Int> = buildSet {
        add(AudioManager.MODE_RINGTONE)
        add(AudioManager.MODE_IN_CALL)
        add(AudioManager.MODE_IN_COMMUNICATION)
        add(AudioManager.MODE_CALL_SCREENING)
        if (Build.VERSION.SDK_INT >= 33) {
            add(AudioManager.MODE_CALL_REDIRECT)
            add(AudioManager.MODE_COMMUNICATION_REDIRECT)
        }
    }

    private val listening = AtomicBoolean(false)

    /** A call is ringing or on, in Belay's dialer, the preloaded one or another app. */
    fun now(context: Context): Boolean {
        if (CallFlow.callOn) return true
        val app = context.applicationContext
        if (telecomInCall(app) == true) return true
        val mode = try {
            app.getSystemService(AudioManager::class.java)?.mode
        } catch (e: RuntimeException) {
            null
        }
        return mode in CALL_MODES
    }

    /** Telecom's answer, only while Belay is the default dialer (then Telecom lets it ask); else null. */
    @SuppressLint("MissingPermission")
    private fun telecomInCall(app: Context): Boolean? {
        if (!Dialer.isDialer(app)) return null
        return try {
            app.getSystemService(TelecomManager::class.java)?.isInCall
        } catch (e: SecurityException) {
            null
        }
    }

    /** A screen lock waits for a call to end: one step once Android's audio mode is back to normal. */
    fun lockWaits(context: Context) {
        if (!listening.compareAndSet(false, true)) return
        val app = context.applicationContext
        val audio = app.getSystemService(AudioManager::class.java)
        if (audio == null) {
            listening.set(false)
            return
        }
        val listener = object : AudioManager.OnModeChangedListener {
            override fun onModeChanged(mode: Int) {
                if (mode in CALL_MODES) return
                audio.removeOnModeChangedListener(this)
                listening.set(false)
                Agent.handle(app, Trigger.CALL)
            }
        }
        try {
            audio.addOnModeChangedListener(app.mainExecutor, listener)
        } catch (e: RuntimeException) {
            listening.set(false)
            Log.w(Agent.TAG, "calls: can't hear when the call ends; the policy timer looks again", e)
        }
    }
}
