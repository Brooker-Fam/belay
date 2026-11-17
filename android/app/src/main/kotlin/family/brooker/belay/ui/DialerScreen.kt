package family.brooker.belay.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.calls.CallPlacer
import family.brooker.belay.calls.CallsView
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.calls.AlwaysAllowedKind
import family.brooker.belay.core.calls.CallContacts
import family.brooker.belay.core.calls.CallEntry
import family.brooker.belay.core.calls.CallsWireLimits
import family.brooker.belay.core.calls.PrivateCall
import family.brooker.belay.core.calls.WireCallAction
import family.brooker.belay.core.calls.WireCallDirection
import family.brooker.belay.core.calls.WireCallMode
import family.brooker.belay.core.calls.WireCallOutcome
import family.brooker.belay.core.calls.WireCallReason
import family.brooker.belay.core.calls.WireCalls
import family.brooker.belay.core.calls.WireOutgoing

/** What the dialer can do, each through Belay's own code (calls/CallPlacer.kt, the agent thread). */
class DialerActions(
    val call: (number: String, done: (CallPlacer.Result) -> Unit) -> Unit,
    val emergency: () -> Unit,
    val call988: () -> Unit,
    val text988: () -> Boolean,
    /** "Ask to add a contact": [done] gets whether it was sent. */
    val askContact: (name: String, number: String, reason: String?, done: (Boolean) -> Unit) -> Unit,
    /** A number formatted for the phone's country. */
    val display: (String?) -> String?,
)

private enum class DialerTab { KEYPAD, CONTACTS, RECENT }

/**
 * Belay's dialer, in large print: "Emergency (911)" and "988: Call or text for crisis support"
 * always at the top, then the dial pad, the approved contacts with "Ask to add a contact", and the
 * recent calls. Contact names are the family's words, shown as text.
 */
@Composable
fun DialerScreen(
    calls: CallsView?,
    privateCalls: List<PrivateCall>,
    typed: String,
    onTyped: (String) -> Unit,
    actions: DialerActions,
    onClose: () -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(DialerTab.KEYPAD) }
    var asking by rememberSaveable { mutableStateOf<String?>(null) }
    var refused by rememberSaveable { mutableStateOf<String?>(null) }
    var crisis by rememberSaveable { mutableStateOf(false) }
    val call: (String) -> Unit = { number ->
        refused = null
        actions.call(number) { result -> if (result is CallPlacer.Result.NotAllowed) refused = number }
    }
    Scaffold { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.calls_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = onClose) { Text(stringResource(R.string.calls_close)) }
                }
            }
            item { AlwaysButtons(onEmergency = actions.emergency, onCrisis = { crisis = true }) }
            if (calls == null) {
                item { Text(stringResource(R.string.calls_off_now), style = MaterialTheme.typography.bodyLarge) }
                item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                return@LazyColumn
            }
            if (!calls.isDialer) item { Text(stringResource(R.string.calls_not_dialer), style = MaterialTheme.typography.bodyMedium) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    DialerTab.entries.forEach { t ->
                        val label = stringResource(
                            when (t) {
                                DialerTab.KEYPAD -> R.string.calls_tab_keypad
                                DialerTab.CONTACTS -> R.string.calls_tab_contacts
                                DialerTab.RECENT -> R.string.calls_tab_recent
                            },
                        )
                        if (t == tab) {
                            Button(onClick = {}, modifier = Modifier.weight(1f)) { Text(label) }
                        } else {
                            OutlinedButton(onClick = { tab = t }, modifier = Modifier.weight(1f)) { Text(label) }
                        }
                    }
                }
            }
            refused?.let { number ->
                item {
                    NotAllowedCard(calls, number, actions) {
                        asking = number
                        tab = DialerTab.CONTACTS
                        refused = null
                    }
                }
            }
            when (tab) {
                DialerTab.KEYPAD -> item { Keypad(typed, onTyped, actions, calls, onCall = call) }
                DialerTab.CONTACTS -> {
                    item { RulesText(calls) }
                    val callable = CallContacts.callable(calls.contacts)
                    if (callable.isEmpty()) item { Text(stringResource(R.string.calls_contacts_none), style = MaterialTheme.typography.bodyLarge) }
                    callable.forEach { contact ->
                        item {
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(contact.name, style = MaterialTheme.typography.headlineSmall)
                                    if (contact.parent) Text(stringResource(R.string.calls_parent), style = MaterialTheme.typography.labelLarge)
                                    contact.numbers.forEach { number ->
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Text(actions.display(number) ?: number, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                                            CallButton { call(number) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    item { AskToAdd(asking, actions) { asking = null } }
                }
                DialerTab.RECENT -> recentItems(this, calls, privateCalls, actions, call)
            }
        }
    }
    if (crisis) {
        AlertDialog(
            onDismissRequest = { crisis = false },
            title = { Text(stringResource(R.string.calls_988_title)) },
            text = { Text(stringResource(R.string.calls_988_text)) },
            confirmButton = {
                TextButton(onClick = {
                    crisis = false
                    actions.call988()
                }) { Text(stringResource(R.string.emergency_call_988)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    crisis = false
                    actions.text988()
                }) { Text(stringResource(R.string.emergency_text_988)) }
            },
        )
    }
}

/** The two buttons that are always there. */
@Composable
private fun AlwaysButtons(onEmergency: () -> Unit, onCrisis: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = onEmergency,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text(stringResource(R.string.calls_emergency_911), style = MaterialTheme.typography.titleLarge) }
        OutlinedButton(onClick = onCrisis, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Text(stringResource(R.string.calls_988), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun RulesText(calls: CallsView) = CallRulesText(calls.calls)

/** The family's call rules in the kid's words (the Contacts tab, and This phone's rules). */
@Composable
internal fun CallRulesText(rules: WireCalls) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            stringResource(if (rules.mode == WireCallMode.OPEN) R.string.calls_rule_anyone_rings else R.string.calls_rule_contacts_ring),
            style = MaterialTheme.typography.bodyLarge,
        )
        if (rules.mode == WireCallMode.CONTACTS) {
            if (rules.unknown != WireCallAction.RING) Text(stringResource(R.string.calls_rule_others_dont_ring), style = MaterialTheme.typography.bodyMedium)
            if (rules.withheld != WireCallAction.RING) Text(stringResource(R.string.calls_rule_hidden_dont_ring), style = MaterialTheme.typography.bodyMedium)
        }
        Text(
            stringResource(if (rules.outgoing == WireOutgoing.ANY) R.string.calls_rule_call_anyone else R.string.calls_rule_call_contacts),
            style = MaterialTheme.typography.bodyLarge,
        )
        if (rules.quiet) Text(stringResource(R.string.calls_rule_quiet), style = MaterialTheme.typography.bodyMedium)
        if (rules.log) Text(stringResource(R.string.calls_rule_log), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.calls_rule_always), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Keypad(typed: String, onTyped: (String) -> Unit, actions: DialerActions, calls: CallsView, onCall: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
        Text(
            if (typed.isEmpty()) stringResource(R.string.calls_type_number) else typed,
            style = MaterialTheme.typography.headlineLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        KEYS.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { (digit, letters) ->
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        modifier = Modifier.weight(1f).heightIn(min = 64.dp).combinedClickable(
                            onClick = { if (typed.length < MAX_TYPED) onTyped(typed + digit) },
                            // A long press on 0 types +, as on any phone.
                            onLongClick = { if (digit == '0' && typed.length < MAX_TYPED) onTyped("$typed+") },
                        ),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(8.dp)) {
                            Text(digit.toString(), style = MaterialTheme.typography.headlineMedium)
                            Text(letters, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = { onTyped(typed.dropLast(1)) }, enabled = typed.isNotEmpty(), modifier = Modifier.weight(1f).heightIn(min = 56.dp)) {
                Text(stringResource(R.string.calls_delete))
            }
            Button(
                onClick = { onCall(typed) },
                enabled = typed.isNotEmpty(),
                colors = ButtonDefaults.buttonColors(containerColor = CALL_GREEN),
                modifier = Modifier.weight(2f).heightIn(min = 56.dp),
            ) { Text(stringResource(R.string.calls_call), style = MaterialTheme.typography.titleLarge) }
        }
        if (calls.calls.outgoing == WireOutgoing.CONTACTS) {
            Text(stringResource(R.string.calls_rule_call_contacts), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
        }
        // So the kid sees what was typed, the way it'll be dialed.
        actions.display(typed)?.takeIf { it != typed }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    }
}

@Composable
private fun CallButton(onClick: () -> Unit) {
    Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = CALL_GREEN), modifier = Modifier.heightIn(min = 48.dp)) {
        Text(stringResource(R.string.calls_call))
    }
}

@Composable
private fun NotAllowedCard(calls: CallsView, number: String, actions: DialerActions, onAsk: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.calls_not_allowed, actions.display(number) ?: number), style = MaterialTheme.typography.bodyLarge)
            if (calls.calls.outgoing == WireOutgoing.CONTACTS) Text(stringResource(R.string.calls_rule_call_contacts), style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = onAsk) { Text(stringResource(R.string.calls_ask_this_one)) }
        }
    }
}

/** "Ask to add a contact": a name, a number and why, sent to a parent as a `contact` request. */
@Composable
private fun AskToAdd(prefill: String?, actions: DialerActions, onSent: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var number by rememberSaveable(prefill) { mutableStateOf(prefill.orEmpty()) }
    var why by rememberSaveable { mutableStateOf("") }
    var sent by rememberSaveable { mutableStateOf<Boolean?>(null) }
    KidCard(stringResource(R.string.calls_ask_title)) {
        Text(stringResource(R.string.calls_ask_intro), style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(CallsWireLimits.MAX_CONTACT_NAME); sent = null },
            label = { Text(stringResource(R.string.calls_ask_name)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = number,
            onValueChange = { number = it.take(MAX_TYPED); sent = null },
            label = { Text(stringResource(R.string.calls_ask_number)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = why,
            onValueChange = { why = it.take(WireLimits.MAX_REASON); sent = null },
            label = { Text(stringResource(R.string.calls_ask_why)) },
            supportingText = { Text(stringResource(R.string.why_counter, why.length, WireLimits.MAX_REASON)) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                actions.askContact(name.trim(), number.trim(), why.trim().ifEmpty { null }) { ok ->
                    sent = ok
                    if (ok) {
                        name = ""
                        number = ""
                        why = ""
                        onSent()
                    }
                }
            },
            enabled = name.isNotBlank() && number.isNotBlank(),
        ) { Text(stringResource(R.string.calls_ask_send)) }
        when (sent) {
            true -> Text(stringResource(R.string.calls_ask_sent), style = MaterialTheme.typography.bodyMedium)
            false -> Text(stringResource(R.string.calls_ask_failed), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            null -> {}
        }
    }
}

/** Belay's recent calls and, while Android's own call log has them, the calls with 911, 988 and private numbers. */
private fun recentItems(
    scope: androidx.compose.foundation.lazy.LazyListScope,
    calls: CallsView,
    privateCalls: List<PrivateCall>,
    actions: DialerActions,
    call: (String) -> Unit,
) {
    scope.item { Text(stringResource(R.string.calls_recent_private_note), style = MaterialTheme.typography.bodySmall) }
    val rows = calls.recents.map { it.at to RecentRow.Belay(it) } + privateCalls.map { it.at to RecentRow.Private(it) }
    if (rows.isEmpty()) scope.item { Text(stringResource(R.string.calls_recent_none), style = MaterialTheme.typography.bodyLarge) }
    rows.sortedByDescending { it.first }.forEachIndexed { i, (_, row) ->
        scope.item {
            if (i > 0) HorizontalDivider()
            when (row) {
                is RecentRow.Belay -> BelayRecent(row.entry, calls, actions, call)
                is RecentRow.Private -> PrivateRecent(row.call, actions, call)
            }
        }
    }
}

private sealed interface RecentRow {
    data class Belay(val entry: CallEntry) : RecentRow

    data class Private(val call: PrivateCall) : RecentRow
}

@Composable
private fun BelayRecent(entry: CallEntry, calls: CallsView, actions: DialerActions, call: (String) -> Unit) {
    val context = LocalContext.current
    val now = System.currentTimeMillis()
    val contact = calls.contacts.firstOrNull { it.id == entry.contactId }
    val name = contact?.name ?: actions.display(entry.number) ?: stringResource(R.string.calls_number_hidden)
    val what = stringResource(recentWords(entry))
    val callBack = contact?.numbers?.firstOrNull() ?: entry.number
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.titleLarge)
            val duration = if (entry.durationS > 0) " · " + KidWords(context) { it }.duration(maxOf(1, (entry.durationS + 59) / 60)) else ""
            Text("$what$duration", style = MaterialTheme.typography.bodyMedium)
            Text(KidWords(context) { it }.at(entry.at, now), style = MaterialTheme.typography.bodySmall)
        }
        if (callBack != null) CallButton { call(callBack) }
    }
}

@Composable
private fun PrivateRecent(entry: PrivateCall, actions: DialerActions, call: (String) -> Unit) {
    val context = LocalContext.current
    val now = System.currentTimeMillis()
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(
                when (entry.kind) {
                    AlwaysAllowedKind.EMERGENCY, AlwaysAllowedKind.CRISIS_988 -> entry.number
                    null -> actions.display(entry.number) ?: entry.number
                },
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(if (entry.direction == WireCallDirection.OUT) R.string.calls_recent_out else R.string.calls_recent_in) + " · " +
                    stringResource(R.string.calls_recent_only_here),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(KidWords(context) { it }.at(entry.at, now), style = MaterialTheme.typography.bodySmall)
        }
        Box { CallButton { call(entry.number) } }
    }
}

/** What happened to a call, in the kid's words ("Missed: number not in your contacts"). */
private fun recentWords(entry: CallEntry): Int = when (entry.direction) {
    WireCallDirection.IN -> when (entry.outcome) {
        WireCallOutcome.ANSWERED -> R.string.calls_recent_in
        WireCallOutcome.MISSED -> R.string.calls_recent_missed
        WireCallOutcome.REJECTED, WireCallOutcome.VOICEMAIL, WireCallOutcome.NOT_PLACED -> when (entry.reason) {
            WireCallReason.UNKNOWN -> R.string.calls_recent_refused_unknown
            WireCallReason.WITHHELD -> R.string.calls_recent_refused_withheld
            WireCallReason.QUIET -> R.string.calls_recent_refused_quiet
            WireCallReason.NOT_ALLOWED -> R.string.calls_recent_refused_not_allowed
            null -> R.string.calls_recent_declined
        }
    }
    WireCallDirection.OUT -> when (entry.outcome) {
        WireCallOutcome.ANSWERED -> R.string.calls_recent_out
        WireCallOutcome.NOT_PLACED -> R.string.calls_recent_not_placed
        else -> R.string.calls_recent_no_answer
    }
}

private val KEYS = listOf(
    listOf('1' to " ", '2' to "ABC", '3' to "DEF"),
    listOf('4' to "GHI", '5' to "JKL", '6' to "MNO"),
    listOf('7' to "PQRS", '8' to "TUV", '9' to "WXYZ"),
    listOf('*' to " ", '0' to "+", '#' to " "),
)

private const val MAX_TYPED = 40

/** The answer and call green, the same in light and dark. */
internal val CALL_GREEN = androidx.compose.ui.graphics.Color(0xFF1B7F3A)
