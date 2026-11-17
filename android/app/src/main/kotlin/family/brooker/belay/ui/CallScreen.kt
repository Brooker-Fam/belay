package family.brooker.belay.ui

import android.telecom.Call
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.calls.CallFlow
import kotlinx.coroutines.delay

/** What the call screen can do, through CallFlow. */
class CallActions(
    val answer: (id: String) -> Unit,
    val decline: (id: String) -> Unit,
    val hangUp: (id: String) -> Unit,
    val hold: (id: String, on: Boolean) -> Unit,
    val dtmf: (id: String, digit: Char) -> Unit,
    val mute: (Boolean) -> Unit,
    val speaker: (Boolean) -> Unit,
    val bluetooth: (Boolean) -> Unit,
    val display: (String?) -> String?,
)

/**
 * The incoming call (Answer and Decline, large), or the call going on: who, how long, and Mute,
 * Speaker, Bluetooth (when there's a headset or a car), Keypad, Hold (when the network allows it)
 * and End call. The first ringing call comes first. Contact names are the family's words.
 */
@Composable
fun CallScreen(calls: List<CallFlow.CallUi>, audio: CallFlow.AudioUi, actions: CallActions) {
    val call = calls.firstOrNull { it.incoming && it.state == Call.STATE_RINGING } ?: calls.firstOrNull() ?: return
    var keypad by rememberSaveable { mutableStateOf(false) }
    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.heightIn(min = 24.dp))
            Text(
                call.name ?: actions.display(call.number) ?: stringResource(R.string.calls_unknown_caller),
                style = MaterialTheme.typography.displaySmall,
                textAlign = TextAlign.Center,
            )
            if (call.name != null) actions.display(call.number)?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            Text(stateWords(call), style = MaterialTheme.typography.titleLarge)
            if (call.incoming && call.state == Call.STATE_RINGING) {
                Incoming(call, actions)
            } else {
                Ongoing(call, audio, actions, keypad) { keypad = it }
            }
            if (calls.size > 1) Text(stringResource(R.string.calls_more_than_one), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun stateWords(call: CallFlow.CallUi): String = when (call.state) {
    Call.STATE_RINGING -> stringResource(R.string.calls_incoming)
    Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_SELECT_PHONE_ACCOUNT, Call.STATE_NEW -> stringResource(R.string.calls_dialing)
    Call.STATE_HOLDING -> stringResource(R.string.calls_on_hold)
    Call.STATE_ACTIVE -> elapsed(call.connectedAt)
    else -> stringResource(R.string.calls_ending)
}

/** "3:05", counting up while the call lasts. */
@Composable
private fun elapsed(since: Long?): String {
    var now by androidx.compose.runtime.remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val seconds = ((now - (since ?: now)) / 1000).coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

@Composable
private fun Incoming(call: CallFlow.CallUi, actions: CallActions) {
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.fillMaxWidth()) {
        Button(
            onClick = { actions.decline(call.id) },
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            modifier = Modifier.weight(1f).heightIn(min = 72.dp),
        ) { Text(stringResource(R.string.calls_decline), style = MaterialTheme.typography.titleLarge) }
        Button(
            onClick = { actions.answer(call.id) },
            colors = ButtonDefaults.buttonColors(containerColor = CALL_GREEN),
            modifier = Modifier.weight(1f).heightIn(min = 72.dp),
        ) { Text(stringResource(R.string.calls_answer), style = MaterialTheme.typography.titleLarge) }
    }
}

@Composable
private fun Ongoing(call: CallFlow.CallUi, audio: CallFlow.AudioUi, actions: CallActions, keypad: Boolean, onKeypad: (Boolean) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Toggle(stringResource(R.string.calls_mute), audio.muted, Modifier.weight(1f)) { actions.mute(!audio.muted) }
            Toggle(stringResource(R.string.calls_speaker), audio.speaker, Modifier.weight(1f)) { actions.speaker(!audio.speaker) }
            Toggle(stringResource(R.string.calls_keypad), keypad, Modifier.weight(1f)) { onKeypad(!keypad) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            if (call.canHold) {
                val held = call.state == Call.STATE_HOLDING
                Toggle(stringResource(R.string.calls_hold), held, Modifier.weight(1f)) { actions.hold(call.id, !held) }
            }
            if (audio.canBluetooth) Toggle(stringResource(R.string.calls_bluetooth), audio.bluetooth, Modifier.weight(1f)) { actions.bluetooth(!audio.bluetooth) }
        }
        if (keypad) {
            DIGITS.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    row.forEach { digit ->
                        FilledTonalButton(onClick = { actions.dtmf(call.id, digit) }, modifier = Modifier.weight(1f).heightIn(min = 56.dp)) {
                            Text(digit.toString(), style = MaterialTheme.typography.headlineSmall)
                        }
                    }
                }
            }
        }
        Button(
            onClick = { actions.hangUp(call.id) },
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp),
        ) { Text(stringResource(R.string.calls_end), style = MaterialTheme.typography.titleLarge) }
    }
}

@Composable
private fun Toggle(label: String, on: Boolean, modifier: Modifier, onClick: () -> Unit) {
    if (on) {
        Button(onClick = onClick, modifier = modifier.heightIn(min = 56.dp)) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = 56.dp)) { Text(label) }
    }
}

private val DIGITS = listOf(listOf('1', '2', '3'), listOf('4', '5', '6'), listOf('7', '8', '9'), listOf('*', '0', '#'))
