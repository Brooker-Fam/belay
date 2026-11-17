package family.brooker.belay.calls

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import family.brooker.belay.Agent

/**
 * Belay rings for the calls it lets through, itself: its InCallService declares
 * IN_CALL_SERVICE_RINGING, so Telecom plays no ringtone and no vibration for any call while Belay is
 * the dialer (docs/platform-notes.md T5), and a call Belay refuses never rings. The phone's own
 * ringtone, on the ring stream (USAGE_NOTIFICATION_RINGTONE), so the ring volume and the silent and
 * vibrate modes apply; Do Not Disturb's verdict on a caller needs READ_CONTACTS, which Belay doesn't
 * hold (what it does to this sound is on the Pixel checklist). It vibrates too unless the phone is
 * silent. Main thread only.
 */
object CallRinger {
    @Volatile
    private var ringtone: Ringtone? = null

    @Volatile
    private var vibrator: Vibrator? = null

    val ringing: Boolean get() = ringtone != null || vibrator != null

    /** [quiet]: vibrate only (another call is going on, or a screening app asked for silence). */
    fun start(context: Context, quiet: Boolean = false) {
        if (ringing) return
        val app = context.applicationContext
        val audio = app.getSystemService(AudioManager::class.java)
        val mode = audio?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
        if (!quiet && mode == AudioManager.RINGER_MODE_NORMAL) {
            try {
                val uri = RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_RINGTONE)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ringtone = RingtoneManager.getRingtone(app, uri)?.apply {
                    audioAttributes = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                    isLooping = true
                    play()
                }
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "calls: the ringtone didn't play", e)
                ringtone = null
            }
        }
        if (mode != AudioManager.RINGER_MODE_SILENT) {
            try {
                val v = app.getSystemService(VibratorManager::class.java)?.defaultVibrator
                if (v != null && v.hasVibrator()) {
                    val effect = VibrationEffect.createWaveform(PATTERN, 0)
                    if (Build.VERSION.SDK_INT >= 33) {
                        v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_RINGTONE))
                    } else {
                        @Suppress("DEPRECATION")
                        v.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
                    }
                    vibrator = v
                }
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "calls: couldn't vibrate", e)
            }
        }
        Log.i(Agent.TAG, "calls: ringing${if (ringtone == null) " (no sound)" else ""}")
    }

    fun stop() {
        if (!ringing) return
        try {
            ringtone?.stop()
            vibrator?.cancel()
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "calls: couldn't stop ringing", e)
        }
        ringtone = null
        vibrator = null
        Log.i(Agent.TAG, "calls: stopped ringing")
    }

    /** A second on, a second off. */
    private val PATTERN = longArrayOf(0, 1000, 1000)
}
