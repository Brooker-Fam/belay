package family.brooker.belay.calls

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.telecom.TelecomManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import family.brooker.belay.core.CallNow
import family.brooker.belay.core.ScreenLocks
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Whether a call is on now, for the screen locks that wait for one (core's ScreenLocks), from what
 * Belay may read on Android 17 (docs/platform-notes.md T20) and what an app can't make up:
 * - Belay's own in-call service's calls (CallFlow.callOn), while it's the dialer;
 * - TelecomManager.isInCall, which Telecom answers for the default dialer without a permission (any
 *   other app needs READ_PHONE_STATE, which Belay doesn't hold): every managed and self-managed
 *   call, an emergency call the preloaded dialer took included. While Belay is the dialer, that's
 *   all Belay trusts;
 * - while Belay isn't the dialer, only Android's audio mode MODE_IN_CALL (AudioManager.getMode, no
 *   permission), which only holders of MODIFY_PHONE_STATE (the phone's own services) can set: a
 *   carrier call. A wait for it alone lasts at most 30 minutes (ScreenLocks.CARRIER_WAIT_MS), from
 *   the step it began, kept here while a lock waits (a restart of Belay, which the kid can't cause,
 *   would start it again). Any other mode, which any app may set (MODE_IN_COMMUNICATION, even from
 *   a paused app, or MODE_RINGTONE), holds no lock off.
 * While a lock waits, Belay listens for the audio mode to change and takes a step then (only a
 * step: what it decides is from the above); the policy timer looks again every minute too
 * (ScreenLocks.RECHECK_MS). From any thread.
 */
object InCall {
    /** Modes that come and go with a call, whoever set them: a change from one of them is worth a step. */
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

    /** When a lock began waiting for a call only the audio mode shows (core's ScreenLocks.wait). */
    @Volatile
    private var carrierSince: Long? = null

    /** What Belay can tell about a call now (core's CallNow). */
    fun now(context: Context): CallNow {
        if (CallFlow.callOn) return CallNow(telecom = true)
        val app = context.applicationContext
        telecomInCall(app)?.let { return CallNow(telecom = it) }
        val mode = try {
            app.getSystemService(AudioManager::class.java)?.mode
        } catch (e: RuntimeException) {
            null
        }
        return CallNow(carrier = mode == AudioManager.MODE_IN_CALL)
    }

    /**
     * Whether a lock_now or a schedule's lock waits for a call now (core's ScreenLocks.wait), asked
     * only when one is due. On the agent thread.
     */
    fun lockWaits(context: Context, at: Long): Boolean {
        val wait = ScreenLocks.wait(now(context), carrierSince, at)
        carrierSince = wait.carrierSince
        return wait.waits
    }

    /** No lock waited at this step: a later wait for the audio mode starts its 30 minutes afresh. */
    fun noLockWaits() {
        carrierSince = null
    }

    /**
     * Telecom has a call that Belay's own in-call service doesn't: one the phone's own app took (an
     * emergency call, or one that rang before the unlock and is still on). Only while Belay is the
     * dialer; false when Belay can't tell.
     */
    fun elsewhere(context: Context): Boolean = !CallFlow.callOn && telecomInCall(context.applicationContext) == true

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

    /** A screen lock waits for a call to end: one step once Android's audio mode leaves a call's. */
    fun listenForTheEnd(context: Context) {
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
