package family.brooker.belay.ui

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import family.brooker.belay.Agent
import family.brooker.belay.AgentView
import family.brooker.belay.R
import family.brooker.belay.core.RecoveryOutcome
import family.brooker.belay.core.RecoveryRules

/**
 * Phase 6: "Recovery", under About Belay. For a parent whose Belay server is gone: the
 * recovery key, typed here, opens repair access for 24 hours with no server (core's
 * RecoveryRules, checked on the agent thread against the stored policy). Not exported.
 */
class RecoveryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            BelayTheme {
                val view = Agent.view.collectAsStateWithLifecycle().value
                RecoveryScreen(
                    view = view,
                    onTry = { typed, done -> Agent.recover(this, typed) { outcome -> runOnUiThread { done(outcome) } } },
                    onClose = ::finish,
                )
            }
        }
    }
}

@Composable
fun RecoveryScreen(view: AgentView?, onTry: (String, (RecoveryOutcome?) -> Unit) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    var key by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var message by rememberSaveable { mutableStateOf<String?>(null) }
    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.recovery_title), style = MaterialTheme.typography.headlineSmall)
            Text(stringResource(R.string.recovery_intro), style = MaterialTheme.typography.bodyLarge)
            Text(stringResource(R.string.recovery_detail), style = MaterialTheme.typography.bodyMedium)
            val open = view?.recovery?.let { RecoveryRules.openUntil(it, System.currentTimeMillis()) }
            if (open != null) {
                Text(stringResource(R.string.recovery_open_until, formatTime(open)), style = MaterialTheme.typography.titleMedium)
            }
            if (view != null && view.kid.policy?.recovery == null) {
                Text(stringResource(R.string.recovery_no_key), style = MaterialTheme.typography.bodyMedium)
            }
            OutlinedTextField(
                value = key,
                onValueChange = { key = it.take(MAX_TYPED) },
                label = { Text(stringResource(R.string.recovery_key_label)) },
                placeholder = { Text(stringResource(R.string.recovery_key_hint)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Done,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    busy = true
                    message = null
                    onTry(key) { outcome ->
                        busy = false
                        message = words(context, outcome)
                        if (outcome is RecoveryOutcome.Opened) key = ""
                    }
                },
                enabled = !busy && key.isNotBlank(),
            ) { Text(stringResource(R.string.recovery_open_button)) }
            if (busy) Text(stringResource(R.string.recovery_checking), style = MaterialTheme.typography.bodyMedium)
            message?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
            view?.recovery?.lastUse?.let {
                Text(stringResource(R.string.recovery_last_used, formatTime(it.usedAt)), style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = onClose) { Text(stringResource(R.string.enroll_back)) }
        }
    }
}

/** What a try did, in plain words. Never repeats the key. */
private fun words(context: Context, outcome: RecoveryOutcome?): String = when (outcome) {
    is RecoveryOutcome.Opened -> context.getString(R.string.recovery_opened, formatTime(context, outcome.use.until))
    is RecoveryOutcome.Wrong -> context.getString(R.string.recovery_wrong) + " " + if (outcome.waitMs > 0) {
        context.getString(R.string.recovery_wrong_wait, waitWords(context, outcome.waitMs))
    } else {
        context.resources.getQuantityString(R.plurals.recovery_wrong_free, outcome.freeLeft, outcome.freeLeft)
    }
    is RecoveryOutcome.Wait -> context.getString(R.string.recovery_wait, waitWords(context, outcome.ms))
    RecoveryOutcome.NotAKey -> context.getString(R.string.recovery_not_a_key)
    RecoveryOutcome.NoKey -> context.getString(R.string.recovery_no_key)
    RecoveryOutcome.Used -> context.getString(R.string.recovery_used)
    null -> context.getString(R.string.recovery_error)
}

/** A wait, rounded up: "2 minutes", "3 hours". */
private fun waitWords(context: Context, ms: Long): String {
    val minutes = ((ms + 59_999) / 60_000).toInt().coerceAtLeast(1)
    return if (minutes < 60) {
        context.resources.getQuantityString(R.plurals.minutes, minutes, minutes)
    } else {
        val hours = (minutes + 59) / 60
        context.resources.getQuantityString(R.plurals.hours, hours, hours)
    }
}

private const val MAX_TYPED = 64
