package family.brooker.belay.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.core.AnsweredRequest
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.enforce.KidView

/**
 * Phase 7's Help screen: "I need help" (one tap sends it, no words needed), and once sent the
 * confirmation: that the parents get it right away (or when Belay can reach the server), "If you're
 * in danger right now, call 911." with a button and the 988 line, a few words if the kid wants,
 * "Share where this phone is, this once", and when a parent saw it. Then the emergency card and
 * "Talk to my parent". [helpId] is the request the kid just sent; without one, the newest open help
 * request of the last day shows.
 */
@Composable
internal fun HelpScreen(kid: KidView, unsent: Set<String>, helpId: String?, words: KidWords, actions: KidActions, onAsked: (String) -> Unit) {
    val now = System.currentTimeMillis()
    val help = kid.requests.firstOrNull { it.request.id == helpId }
        ?: kid.requests.firstOrNull { it.request.kind == WireRequestKind.HELP && it.open && now - it.request.askedAt < DAY_MS }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (help == null || help.withdrawn) {
            KidCard(stringResource(R.string.help_button)) {
                Text(stringResource(R.string.help_intro), style = MaterialTheme.typography.bodyMedium)
                HelpButton { actions.askHelp(null, false) { id -> if (id != null) onAsked(id) } }
                Text(stringResource(R.string.help_not_911), style = MaterialTheme.typography.bodySmall)
            }
        } else {
            HelpSent(help, help.request.id in unsent, LocationRules.collecting(kid.policy?.location), words, actions)
        }
        EmergencyCard(CallContacts.emergencyCard(kid.policy), actions)
        TalkCard(actions)
    }
}

@Composable
private fun HelpSent(help: AnsweredRequest, unsent: Boolean, locationOn: Boolean, words: KidWords, actions: KidActions) {
    val request = help.request
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.help_button), style = MaterialTheme.typography.titleLarge)
            Text(
                stringResource(if (unsent) R.string.help_waiting_to_send else R.string.help_sent),
                style = MaterialTheme.typography.bodyLarge,
            )
            help.seen?.let { Text(stringResource(R.string.help_seen, words.at(it.at, System.currentTimeMillis())), style = MaterialTheme.typography.bodyLarge) }
            // Always: Belay isn't a replacement for 911, and the words say so.
            Text(stringResource(R.string.help_danger), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Button(onClick = { actions.call(NUMBER_911) }) { Text(stringResource(R.string.emergency_call_911)) }
            Text(stringResource(R.string.help_988), style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { actions.call(NUMBER_988) }) { Text(stringResource(R.string.emergency_call_988)) }
                OutlinedButton(onClick = { actions.text(NUMBER_988) }) { Text(stringResource(R.string.emergency_text_988)) }
            }
            HelpWords(help, actions)
            when {
                request.location != null -> Text(stringResource(R.string.help_shared), style = MaterialTheme.typography.bodyMedium)
                request.sharing -> Text(stringResource(R.string.help_sharing), style = MaterialTheme.typography.bodyMedium)
                else -> {
                    if (request.shareFailed) Text(stringResource(R.string.help_share_failed), style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { actions.shareLocation(request.id) }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.help_share))
                    }
                    Text(
                        stringResource(if (locationOn) R.string.help_share_detail_on else R.string.help_share_detail_off),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

/** "Add a few words (optional)", sent with the same request. */
@Composable
private fun HelpWords(help: AnsweredRequest, actions: KidActions) {
    val request = help.request
    var text by rememberSaveable(request.id) { mutableStateOf(request.reason.orEmpty()) }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it.take(WireLimits.MAX_REASON) },
        label = { Text(stringResource(R.string.help_words)) },
        supportingText = { Text(stringResource(R.string.why_counter, text.length, WireLimits.MAX_REASON)) },
        modifier = Modifier.fillMaxWidth(),
        minLines = 2,
    )
    val trimmed = text.trim()
    Button(onClick = { actions.edit(request.id, trimmed) }, enabled = trimmed.isNotEmpty() && trimmed != request.reason.orEmpty()) {
        Text(stringResource(R.string.help_words_send))
    }
    if (request.reason != null && trimmed == request.reason) {
        Text(stringResource(R.string.help_words_sent), style = MaterialTheme.typography.bodySmall)
    }
}

private const val DAY_MS = 24L * 60 * 60 * 1000
