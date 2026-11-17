package family.brooker.belay.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.R
import family.brooker.belay.Trigger
import family.brooker.belay.calls.CallFlow
import family.brooker.belay.screentime.UsageAccess
import family.brooker.belay.service.ScreenTimeNotice
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.store.AgentStore

class MainActivity : ComponentActivity() {
    /** Phase 3: a limit to ask more time for at once, from a time's-up notification. */
    private var askFor by mutableStateOf<String?>(null)

    /** Phase 7: the screen showing; Home unless a notice opened another. Kept across rotations. */
    private var screen by mutableStateOf(Screen.HOME)

    /** Phase 7: the help request the kid just sent, for the Help screen. */
    private var helpId by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) {
            askFor = intent.getStringExtra(EXTRA_ASK_LIMIT)
            screen = Screens.of(intent) ?: Screen.HOME
        } else {
            screen = Screens.named(savedInstanceState.getString(STATE_SCREEN)) ?: Screen.HOME
            helpId = savedInstanceState.getString(STATE_HELP)
        }
        val screenTime = ScreenTimeActions(
            askMoreTime = { limitId, minutes, packageName, reason ->
                Agent.askMoreTime(applicationContext, limitId, minutes, packageName, reason)
            },
            takeMinutes = { limitId, packageName, id -> Agent.takeMinutes(applicationContext, limitId, packageName, id) },
            answerAgreement = { version, answer, reason -> Agent.answerAgreement(applicationContext, version, answer, reason) },
            openUsageAccess = ::openUsageAccess,
        )
        val kid = KidActions(
            askHelp = { reason, share, done -> Agent.askHelp(applicationContext, reason, share) { id -> runOnUiThread { done(id) } } },
            shareLocation = { id -> Agent.shareWhereThePhoneIs(applicationContext, id) },
            talk = { reason -> Agent.talk(applicationContext, reason) },
            edit = { id, reason -> Agent.editRequest(applicationContext, id, reason) },
            withdraw = { id -> Agent.withdraw(applicationContext, id) },
            call = { number -> Emergency.call(this, number) },
            text = { number -> Emergency.text(this, number) },
            emergencyInfo = if (Emergency.infoApp(this) != null) ({ Emergency.info(this) }) else null,
            navigate = { screen = it },
            openCalls = ::openCalls,
        )
        setContent {
            BelayTheme {
                val view = Agent.view.collectAsStateWithLifecycle().value
                val connection = remember { ConnectionStore.flow(applicationContext) }
                    .collectAsStateWithLifecycle(initialValue = null).value
                val waiting = remember { AgentStore.get(applicationContext).pendingCountFlow }
                    .collectAsStateWithLifecycle(initialValue = 0).value
                val unsent = remember { AgentStore.get(applicationContext).unsentRequestsFlow }
                    .collectAsStateWithLifecycle(initialValue = emptySet()).value
                BackHandler(enabled = screen != Screen.HOME) { screen = Screen.HOME }
                MainScreen(
                    view = view,
                    connection = connection,
                    waiting = waiting,
                    unsentRequests = unsent,
                    onAsk = { packageName, reason -> Agent.ask(applicationContext, packageName, reason) },
                    screenTime = screenTime,
                    kidActions = kid,
                    navigation = Navigation(screen, { screen = it }, helpId) { helpId = it },
                    askFor = askFor,
                    onAsked = { askFor = null },
                    onConnect = { startActivity(Intent(this, EnrollActivity::class.java)) },
                    onAllowBattery = ::requestBatteryExemption,
                    onRelease = if (DebugTools.CAN_RELEASE) ::releasePhone else null,
                    onRecovery = { startActivity(Intent(this, RecoveryActivity::class.java)) },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_ASK_LIMIT)?.let {
            askFor = it
            screen = Screen.HOME
        }
        Screens.of(intent)?.let { screen = it }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_SCREEN, screen.name)
        helpId?.let { outState.putString(STATE_HELP, it) }
    }

    override fun onStart() {
        super.onStart()
        Agent.screens(this, visible = true)
    }

    override fun onStop() {
        // Phase 7: a help fix's location grant waits for Belay's screens to close.
        Agent.screens(this, visible = false)
        super.onStop()
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

    /** Phase 3: Settings' usage access switch, for "Turn usage access back on". */
    private fun openUsageAccess() {
        try {
            startActivity(UsageAccess.settings(this))
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    /** Phase 5: Belay's dialer, which is enabled only while the policy has calls. */
    private fun openCalls() {
        try {
            startActivity(CallFlow.dialer(this))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, getString(R.string.calls_off_now), Toast.LENGTH_LONG).show()
        }
    }

    private fun releasePhone() {
        Toast.makeText(this, DebugTools.releasePhone(this), Toast.LENGTH_LONG).show()
        Agent.handle(this, Trigger.APP_OPENED)
    }

    private companion object {
        /** Phase 3: a time's-up notification's "Ask for more time" (ScreenTimeNotice.askMoreTime). */
        const val EXTRA_ASK_LIMIT = ScreenTimeNotice.EXTRA_ASK_LIMIT
        const val STATE_SCREEN = "screen"
        const val STATE_HELP = "help"
    }
}
