package family.brooker.belay.calls

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.Agent
import family.brooker.belay.Trigger
import family.brooker.belay.core.calls.AlwaysAllowed
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.calls.PrivateCall
import family.brooker.belay.core.calls.PhoneNumbers
import family.brooker.belay.ui.BelayTheme
import family.brooker.belay.ui.DialerActions
import family.brooker.belay.ui.DialerScreen
import family.brooker.belay.ui.Emergency
import java.util.concurrent.Executors

/**
 * Belay's dialer (Phase 5), enabled only while the policy has calls: the dial pad (and what an
 * ACTION_DIAL or `tel:` link from another app fills in), the approved contacts, recent calls, "Ask
 * to add a contact", and the two buttons that are always there: "Emergency (911)" and "988: Call or
 * text for crisis support". The default dialer role needs it (it handles ACTION_DIAL).
 */
class DialerActivity : ComponentActivity() {
    private var typed by mutableStateOf("")

    /** Calls with 911, 988 and private numbers from Android's own call log, read when the screen opens. */
    private var privateCalls by mutableStateOf<List<PrivateCall>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        typed = savedInstanceState?.getString(STATE_TYPED) ?: numberOf(intent)
        val actions = DialerActions(
            call = { number, done -> CallPlacer.place(this, number, done) },
            emergency = { CallPlacer.place(this, AlwaysAllowed.EMERGENCY_911) },
            call988 = { CallPlacer.place(this, AlwaysAllowed.CRISIS_988) },
            text988 = {
                CallsGate.emergencyContact(applicationContext, System.currentTimeMillis())
                Emergency.text(this, AlwaysAllowed.CRISIS_988)
            },
            askContact = { name, number, reason, done -> Agent.askContact(applicationContext, name, AndroidCalls.key(this, number), reason) { sent -> runOnUiThread { done(sent) } } },
            display = { CallFlow.display(this, it) },
            removeCall = { id -> Agent.removeCall(applicationContext, id) },
        )
        setContent {
            BelayTheme {
                val view = Agent.view.collectAsStateWithLifecycle().value
                DialerScreen(
                    calls = view?.calls,
                    privateCalls = privateCalls,
                    typed = typed,
                    onTyped = { typed = it },
                    actions = actions,
                    onClose = ::finish,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        numberOf(intent).takeIf { it.isNotEmpty() }?.let { typed = it }
    }

    override fun onResume() {
        super.onResume()
        Agent.handle(this, Trigger.APP_OPENED)
        val app = applicationContext
        reader.execute {
            val now = System.currentTimeMillis()
            val policy = CallsGate.policy(app)
            val found = CallRecords.privateCalls(
                AndroidCalls.log(app, now - CallRecords.ANDROID_LOG_MS),
                CallContacts.private(policy),
                AndroidCalls.emergencyNumbers(app),
                now,
                // A stranger's call showing 988 that Belay keeps itself isn't listed twice.
                kept = Agent.view.value?.calls?.recents.orEmpty(),
            )
            runOnUiThread { privateCalls = found }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_TYPED, typed)
    }

    /** The number an ACTION_DIAL or ACTION_VIEW `tel:` intent carries, as Android dials it. */
    private fun numberOf(intent: Intent?): String {
        val data = intent?.data?.takeIf { it.scheme == "tel" } ?: return ""
        return PhoneNumbers.dialable(data.schemeSpecificPart).take(MAX_TYPED)
    }

    private companion object {
        const val STATE_TYPED = "typed"
        const val MAX_TYPED = 40
        val reader = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-dialer") }
    }
}
