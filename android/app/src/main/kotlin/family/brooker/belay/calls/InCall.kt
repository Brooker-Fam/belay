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
 * Whether a call is on now, for the screen locks that wait for one (core's ScreenLocks and
 * CallNow.of), from what Belay may read on Android 17 (docs/platform-notes.md T20) and what an app
 * can't make up:
 * - Belay's own in-call service's calls (CallFlow.callOn), while it's the dialer;
 * - TelecomManager.isInManagedCall, which Telecom answers for the default dialer without a
 *   permission (any other app needs READ_PHONE_STATE, which Belay doesn't hold): every managed
 *   call, carrier calls and an emergency call the preloaded dialer took included, and none of an
 *   app's self-managed calls, which any app may place (MANAGE_OWN_CALLS is a normal permission:
 *   the fifth review's F3). While Belay is the dialer, that's all Belay trusts;
 * - while Belay isn't the dialer, only Android's audio mode MODE_IN_CALL (AudioManager.getMode, no
 *   permission), which only holders of MODIFY_PHONE_STATE (the phone's own services) can set: a
 *   carrier call. A wait for it alone lasts at most 30 minutes (ScreenLocks.CARRIER_WAIT_MS), from
 *   the step it began, kept here while a lock waits (a restart of Belay, which the kid can't cause,
 *   would start it again). Any other mode, which any app may set (MODE_IN_COMMUNICATION, even from
 *   a paused app, or MODE_RINGTONE), holds no lock off.
 * A lock a call held off waits 2 minutes more once none is on (core's ScreenLocks.waits, the sixth
 * review's I1), counted from the first step with none, in memory only: never stored, sent, logged
 * or in the debug state (a restart of Belay counts them again). While a lock waits, Belay listens
 * for the audio mode to change, into a call's or out of one, and takes a step then (only a step:
 * what it decides is from the above); the policy timer looks again every minute too
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

    /** What the waits keep from step to step (core's ScreenLocks.Waiting): since when, for the audio mode's call and after one. */
    @Volatile
    private var waiting = ScreenLocks.Waiting()

    /** What Belay can tell about a call now (core's CallNow.of). */
    fun now(context: Context): CallNow {
        val app = context.applicationContext
        return CallNow.of(belays = CallFlow.callOn, managed = { managedCall(app) }) {
            val mode = try {
                app.getSystemService(AudioManager::class.java)?.mode
            } catch (e: RuntimeException) {
                null
            }
            mode == AudioManager.MODE_IN_CALL
        }
    }

    /**
     * Whether the screen locks wait for a call at this step (core's ScreenLocks.waits): a lock_now's
     * or a schedule's, and lost mode's. Asked once a step, and only when a lock is due. [heldOff]: a
     * lock_now's lock is due in this boot, which only a call makes. On the agent thread.
     */
    fun waits(context: Context, at: Long, heldOff: Boolean): ScreenLocks.Waits {
        val waits = ScreenLocks.waits(now(context), waiting, at, heldOff)
        waiting = waits.next
        return waits
    }

    /** No lock waited at this step: a later wait for the audio mode starts its 30 minutes afresh, and nothing held one off. */
    fun noLockWaits() {
        waiting = ScreenLocks.Waiting()
    }

    /**
     * Telecom has a managed call that Belay's own in-call service doesn't: one the phone's own app
     * took (an emergency call, or one that rang before the unlock and is still on). Only while
     * Belay is the dialer; false when Belay can't tell.
     */
    fun elsewhere(context: Context): Boolean = !CallFlow.callOn && managedCall(context.applicationContext) == true

    /**
     * Telecom's answer whether it has a managed call (TelecomManager.isInManagedCall: an app's
     * self-managed call isn't one), only while Belay is the default dialer (then Telecom lets it
     * ask); else null, as when Telecom refuses.
     */
    @SuppressLint("MissingPermission")
    private fun managedCall(app: Context): Boolean? {
        if (!Dialer.isDialer(app)) return null
        return try {
            app.getSystemService(TelecomManager::class.java)?.isInManagedCall
        } catch (e: SecurityException) {
            null
        }
    }

    /**
     * A screen lock waits for a call to end (or for the 2 minutes after one): a step whenever
     * Android's audio mode goes into a call's, so a call in those 2 minutes holds the lock off
     * again, and one once it leaves them, which ends the listening (the step listens again while a
     * lock still waits).
     */
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
                if (mode !in CALL_MODES) {
                    audio.removeOnModeChangedListener(this)
                    listening.set(false)
                }
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
