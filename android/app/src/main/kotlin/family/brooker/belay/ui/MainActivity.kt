package family.brooker.belay.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.Trigger

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            BelayTheme {
                val view = Agent.view.collectAsStateWithLifecycle().value
                MainScreen(
                    view = view,
                    onAllowBattery = ::requestBatteryExemption,
                    onRelease = if (DebugTools.CAN_RELEASE) ::releasePhone else null,
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
