package family.brooker.belay.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.enroll.CameraGate
import family.brooker.belay.enroll.EnrollFlow
import family.brooker.belay.settings.ConnectionStore

/** Connecting this phone to a Belay server (scan or type). Only reachable while not connected. */
class EnrollActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val deviceOwner = DeviceOwnerSetup.isDeviceOwner(this)
        setContent {
            BelayTheme {
                val state = EnrollFlow.state.collectAsStateWithLifecycle().value
                val connection = remember { ConnectionStore.flow(applicationContext) }
                    .collectAsStateWithLifecycle(initialValue = null).value
                EnrollScreen(
                    state = state,
                    alreadyConnected = connection?.connected == true,
                    deviceOwner = deviceOwner,
                    onOpenCamera = { CameraGate.open(this) },
                    onConnect = { server, code -> EnrollFlow.start(this, server, code) },
                    onClose = ::finish,
                )
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) {
            EnrollFlow.reset()
            // Belay's camera access goes off again now (it may restart Belay's process once).
            CameraGate.close(this)
        }
    }
}
