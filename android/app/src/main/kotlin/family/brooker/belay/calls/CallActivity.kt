package family.brooker.belay.calls

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.PowerManager
import android.telecom.Call
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.ui.BelayTheme
import family.brooker.belay.ui.CallActions
import family.brooker.belay.ui.CallScreen

/**
 * The incoming-call and in-call screen, over the lock screen (the incoming-call notification's
 * full-screen intent opens it). It shows CallFlow's calls and closes when there are none. While a
 * call is on the earpiece, the proximity sensor turns the screen off at the kid's ear.
 */
class CallActivity : ComponentActivity() {
    private var proximity: PowerManager.WakeLock? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        val actions = CallActions(
            answer = { CallFlow.answer(this, it) },
            decline = { CallFlow.decline(this, it) },
            hangUp = CallFlow::hangUp,
            hold = CallFlow::hold,
            dtmf = CallFlow::dtmf,
            mute = { CallFlow.mute(it) },
            speaker = { CallFlow.speaker(it) },
            bluetooth = { CallFlow.bluetooth(it) },
            display = { CallFlow.display(this, it) },
        )
        setContent {
            BelayTheme {
                val calls = CallFlow.calls.collectAsStateWithLifecycle().value
                val audio = CallFlow.audio.collectAsStateWithLifecycle().value
                LaunchedEffect(calls.isEmpty()) { if (calls.isEmpty()) finish() }
                val onEar = calls.any { it.state == Call.STATE_ACTIVE } && !audio.speaker && !audio.bluetooth
                LaunchedEffect(onEar) { proximity(onEar) }
                CallScreen(calls, audio, actions)
            }
        }
    }

    override fun onDestroy() {
        proximity(false)
        super.onDestroy()
    }

    private fun proximity(on: Boolean) {
        if (on) {
            if (proximity?.isHeld == true) return
            val pm = getSystemService(PowerManager::class.java)
            if (pm?.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) != true) return
            proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "belay:call").apply {
                setReferenceCounted(false)
                acquire(MAX_CALL_MS)
            }
        } else {
            proximity?.takeIf { it.isHeld }?.release()
            proximity = null
        }
    }

    companion object {
        fun intent(context: Context): Intent = Intent(context, CallActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        /** The proximity lock lets go by itself after this long, whatever happens. */
        private const val MAX_CALL_MS = 4L * 60 * 60 * 1000
    }
}
