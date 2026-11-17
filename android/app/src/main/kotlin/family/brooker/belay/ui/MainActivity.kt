package family.brooker.belay.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.Trigger
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.store.AgentStore

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            BelayTheme {
                val view = Agent.view.collectAsStateWithLifecycle().value
                val connection = remember { ConnectionStore.flow(applicationContext) }
                    .collectAsStateWithLifecycle(initialValue = null).value
                val waiting = remember { AgentStore.get(applicationContext).pendingCountFlow }
                    .collectAsStateWithLifecycle(initialValue = 0).value
                val unsent = remember { AgentStore.get(applicationContext).unsentRequestsFlow }
                    .collectAsStateWithLifecycle(initialValue = emptySet()).value
                MainScreen(
                    view = view,
                    connection = connection,
                    waiting = waiting,
                    unsentRequests = unsent,
                    onAsk = { packageName, reason -> Agent.ask(applicationContext, packageName, reason) },
                    onConnect = { startActivity(Intent(this, EnrollActivity::class.java)) },
                    onAllowBattery = ::requestBatteryExemption,
                    onRelease = if (DebugTools.CAN_RELEASE) ::releasePhone else null,
                    onRecovery = { startActivity(Intent(this, RecoveryActivity::class.java)) },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        Agent.handle(this, Trigger.APP_OPENED)
    }

    /** The fallback when provision.sh couldn't add the exemption over adb. */
    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:$packageName".toUri()),
        )
    }

    private fun releasePhone() {
        Toast.makeText(this, DebugTools.releasePhone(this), Toast.LENGTH_LONG).show()
        Agent.handle(this, Trigger.APP_OPENED)
    }
}
