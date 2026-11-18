package family.brooker.belay.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.core.AiAlways
import family.brooker.belay.core.AnsweredRequest
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.DataCategory
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WireParentNumber
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.WireRequestStatus
import family.brooker.belay.core.kid.HomeState
import family.brooker.belay.core.kid.Told
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.ToldKind
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.core.screentime.LocalTimes
import family.brooker.belay.core.screentime.WireAgreementAnswer
import family.brooker.belay.enforce.KidView
import family.brooker.belay.settings.Connection

/*
 * Phase 7: the kid's screens. Every sentence comes from strings.xml (DataCategory's words from
 * core's collectors list); the family's words (names, notes, numbers), the kid's own words and app
 * names are shown as plain text, never as anything to act on.
 */

/** What the kid can do from Belay's screens (Phase 7), each going through the agent thread. */
class KidActions(
    /** "I need help": [done] gets the new request's id (null if it failed), on the main thread. */
    val askHelp: (reason: String?, share: Boolean, done: (String?) -> Unit) -> Unit,
    /** Share where the phone is with help request [requestId], once. */
    val shareLocation: (requestId: String) -> Unit,
    val talk: (reason: String) -> Unit,
    /** Change the words of an open request. */
    val edit: (id: String, reason: String) -> Unit,
    /** Take back an open request. */
    val withdraw: (id: String) -> Unit,
    /** Open the dialer or the texting app with [number] filled in; false if nothing could. */
    val call: (number: String) -> Boolean,
    val text: (number: String) -> Boolean,
    /** Android's own emergency information; null when the phone has none. */
    val emergencyInfo: (() -> Boolean)?,
    val navigate: (Screen) -> Unit,
    /** Phase 5: Belay's dialer, while the family has calls on. */
    val openCalls: () -> Unit = {},
)

/** Home's first card: the phone's state in one line, and what works now. */
@Composable
internal fun HomeStateCard(home: HomeState, words: KidWords) {
    val paused = home.allPaused
    Card(
        colors = if (paused) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer) else CardDefaults.cardColors(),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.home_now), style = MaterialTheme.typography.labelLarge)
            Text(words.text(home.line), style = MaterialTheme.typography.headlineSmall)
            home.worksNow.forEach { Text(words.text(it), style = MaterialTheme.typography.bodyLarge) }
        }
    }
}

/** The big "I need help" button: one tap sends a help request, no words needed. */
@Composable
internal fun HelpButton(onHelp: () -> Unit) {
    Button(
        onClick = onHelp,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.help_button), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 8.dp))
    }
}

/**
 * The emergency card: 911 and 988 (call or text), the parents (Phase 5: the `parent` contacts, else
 * the policy's `parent_numbers`; core's CallContacts.emergencyCard), and Android's own emergency
 * information. Always on Home and Help, also while the phone is paused: Belay, the dialer and the
 * texting app are never blocked.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EmergencyCard(numbers: List<WireParentNumber>, actions: KidActions) {
    var failed by remember { mutableStateOf(false) }
    fun go(started: Boolean) {
        failed = !started
    }
    KidCard(stringResource(R.string.emergency_title)) {
        Text(stringResource(R.string.help_danger), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { go(actions.call(NUMBER_911)) }) { Text(stringResource(R.string.emergency_call_911)) }
            OutlinedButton(onClick = { go(actions.text(NUMBER_911)) }) { Text(stringResource(R.string.emergency_text_911)) }
        }
        Text(stringResource(R.string.emergency_text_911_note), style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.help_988), style = MaterialTheme.typography.bodyLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { go(actions.call(NUMBER_988)) }) { Text(stringResource(R.string.emergency_call_988)) }
            OutlinedButton(onClick = { go(actions.text(NUMBER_988)) }) { Text(stringResource(R.string.emergency_text_988)) }
        }
        numbers.take(WireLimits.MAX_PARENT_NUMBERS).forEach { parent ->
            val name = parent.name.take(WireLimits.MAX_PARENT_NAME)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { go(actions.call(parent.number)) }) { Text(stringResource(R.string.emergency_call, name)) }
                OutlinedButton(onClick = { go(actions.text(parent.number)) }) { Text(stringResource(R.string.emergency_text, name)) }
            }
        }
        actions.emergencyInfo?.let { info ->
            TextButton(onClick = { go(info()) }) { Text(stringResource(R.string.emergency_info)) }
            Text(stringResource(R.string.emergency_info_detail), style = MaterialTheme.typography.bodySmall)
        }
        if (failed) Text(stringResource(R.string.emergency_no_app), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
}

/** A row that opens another of Belay's screens. */
@Composable
internal fun NavRow(title: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Text(title, modifier = Modifier.fillMaxWidth())
    }
}

/** "Talk to my parent": the kid's words, a `talk` request. */
@Composable
internal fun TalkCard(actions: KidActions) {
    var text by rememberSaveable { mutableStateOf("") }
    var sent by rememberSaveable { mutableStateOf(false) }
    KidCard(stringResource(R.string.talk_title)) {
        Text(stringResource(R.string.talk_intro), style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it.take(WireLimits.MAX_REASON)
                sent = false
            },
            label = { Text(stringResource(R.string.talk_label)) },
            supportingText = { Text(stringResource(R.string.why_counter, text.length, WireLimits.MAX_REASON)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        Button(
            onClick = {
                actions.talk(text.trim())
                text = ""
                sent = true
            },
            enabled = text.isNotBlank(),
        ) { Text(stringResource(R.string.talk_send)) }
        if (sent) Text(stringResource(R.string.talk_sent), style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * Every request the kid made (apps, more time, the agreement, help, talk), newest first, with its
 * answer, the parent's note and who answered; an open one can be changed or taken back.
 */
@Composable
internal fun RequestsCard(kid: KidView, unsent: Set<String>, words: KidWords, actions: KidActions) {
    KidCard(stringResource(R.string.screen_requests)) {
        if (kid.requests.isEmpty()) {
            Text(stringResource(R.string.requests_empty), style = MaterialTheme.typography.bodyMedium)
            return@KidCard
        }
        kid.requests.forEachIndexed { i, request ->
            if (i > 0) HorizontalDivider()
            RequestRow(request, kid, request.request.id in unsent, words, actions)
        }
    }
}

@Composable
private fun RequestRow(request: AnsweredRequest, kid: KidView, unsent: Boolean, words: KidWords, actions: KidActions) {
    val r = request.request
    val now = System.currentTimeMillis()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(requestTitle(request, kid, words), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.request_asked, words.at(r.askedAt, now)), style = MaterialTheme.typography.bodySmall)
        r.reason?.let { Text(stringResource(R.string.request_words, it), style = MaterialTheme.typography.bodyMedium) }
        if (r.location != null) Text(stringResource(R.string.request_shared_location), style = MaterialTheme.typography.bodyMedium)
        when {
            r.withdrawnAt != null -> Text(stringResource(R.string.request_withdrawn, words.at(r.withdrawnAt ?: now, now)), style = MaterialTheme.typography.bodyMedium)
            unsent -> Text(stringResource(R.string.why_waiting_to_send), style = MaterialTheme.typography.bodySmall)
            r.kind == WireRequestKind.HELP -> Text(
                request.seen?.let { stringResource(R.string.help_seen, words.at(it.at, now)) } ?: stringResource(R.string.help_not_seen),
                style = MaterialTheme.typography.bodyMedium,
            )
            request.open -> Text(stringResource(R.string.not_answered), style = MaterialTheme.typography.bodyMedium)
            else -> ParentAnswer(request, words)
        }
        val canWithdraw = request.open && !(r.kind == WireRequestKind.AGREEMENT && r.answer == WireAgreementAnswer.AGREE)
        if (request.open) ChangeAndWithdraw(request, canWithdraw, actions)
    }
}

@Composable
private fun requestTitle(request: AnsweredRequest, kid: KidView, words: KidWords): String {
    val r = request.request
    return when (r.kind) {
        WireRequestKind.APP -> stringResource(R.string.request_app, kid.labels[r.packageName] ?: r.label.ifEmpty { r.packageName })
        WireRequestKind.MORE_TIME -> {
            val limit = kid.policy?.screenTime?.limits?.firstOrNull { it.id == r.limitId }?.name ?: r.limitId.orEmpty()
            stringResource(R.string.request_more_time, words.duration(r.minutes ?: 0), limit)
        }
        WireRequestKind.AGREEMENT -> stringResource(
            if (r.answer == WireAgreementAnswer.AGREE) R.string.request_agreement_agree else R.string.request_agreement_talk,
        )
        WireRequestKind.HELP -> stringResource(R.string.request_help)
        WireRequestKind.TALK -> stringResource(R.string.request_talk)
        // Phase 5: "Ask to add a contact", named by what the kid wrote (their words, shown as text).
        WireRequestKind.CONTACT -> r.contactName?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.request_contact_named, it) }
            ?: stringResource(R.string.request_contact)
    }
}

/** The parent's answer: what they said, their note, who and when. */
@Composable
private fun ParentAnswer(request: AnsweredRequest, words: KidWords) {
    val answer = request.answer ?: return
    Text(
        stringResource(
            when (answer.status) {
                WireRequestStatus.APPROVED -> R.string.answer_yes
                WireRequestStatus.DECLINED -> R.string.answer_no
                WireRequestStatus.TALK -> R.string.answer_talk
                WireRequestStatus.PENDING -> R.string.not_answered
            },
        ),
        style = MaterialTheme.typography.bodyLarge,
    )
    answer.note?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.answer_note, it), style = MaterialTheme.typography.bodyMedium) }
    val at = answer.answeredAt?.let { words.at(it, System.currentTimeMillis()) }
    val by = answer.answeredBy?.takeIf { it.isNotBlank() }
    when {
        by != null && at != null -> Text(stringResource(R.string.answer_by, by, at), style = MaterialTheme.typography.bodySmall)
        by != null -> Text(by, style = MaterialTheme.typography.bodySmall)
        at != null -> Text(at, style = MaterialTheme.typography.bodySmall)
    }
}

/** "Change what I wrote" and "Take it back", for an open request. */
@Composable
private fun ChangeAndWithdraw(request: AnsweredRequest, canWithdraw: Boolean, actions: KidActions) {
    val r = request.request
    var changing by rememberSaveable(r.id) { mutableStateOf(false) }
    var confirming by rememberSaveable(r.id) { mutableStateOf(false) }
    var text by rememberSaveable(r.id, r.revision) { mutableStateOf(r.reason.orEmpty()) }
    if (changing) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it.take(WireLimits.MAX_REASON) },
            label = { Text(stringResource(R.string.request_change_label)) },
            supportingText = { Text(stringResource(R.string.why_counter, text.length, WireLimits.MAX_REASON)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        val trimmed = text.trim()
        val allowed = trimmed != r.reason.orEmpty() && (r.kind != WireRequestKind.TALK || trimmed.isNotEmpty())
        Button(onClick = {
            actions.edit(r.id, trimmed)
            changing = false
        }, enabled = allowed) { Text(stringResource(R.string.request_change_send)) }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!changing) TextButton(onClick = { changing = true }) { Text(stringResource(R.string.request_change)) }
        if (canWithdraw) TextButton(onClick = { confirming = true }) { Text(stringResource(R.string.request_withdraw)) }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.request_withdraw_title)) },
            text = { Text(stringResource(R.string.request_withdraw_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    actions.withdraw(r.id)
                }) { Text(stringResource(R.string.request_withdraw_yes)) }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/**
 * What your parent can see: built from the collectors that are on (Collectors.categories), where
 * the data goes, and, for each category in the policy's `ai_reads`, that the parent's AI app can
 * read it.
 */
@Composable
internal fun CanSeeCard(categories: List<DataCategory>, connection: Connection, aiReads: List<String>) {
    KidCard(stringResource(R.string.section_can_see)) {
        val reads = aiReads.toSet()
        categories.distinctBy { it.id + it.title }.forEach { category ->
            Text(category.title, style = MaterialTheme.typography.titleSmall)
            category.details.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
            // Android's own notice says "your organization… may monitor network traffic" (platform notes W1).
            if (category.id == DataCategories.NETWORK_ID) Text(stringResource(R.string.network_android_says), style = MaterialTheme.typography.bodySmall)
            if (category.id in reads) {
                Text(stringResource(R.string.can_see_ai), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            }
        }
        val shown = categories.map { it.id }.toSet()
        val others = reads - shown
        if (AGREEMENT_SCOPE in others) Text(stringResource(R.string.can_see_ai_agreement), style = MaterialTheme.typography.bodyMedium)
        // Location, calls and network activity are read only while their collectors are on (listed above when they are).
        val unknown = (others - AGREEMENT_SCOPE - DataCategories.LOCATION_ID - DataCategories.CALLS_ID - DataCategories.NETWORK_ID).sorted()
        if (unknown.isNotEmpty()) Text(stringResource(R.string.can_see_ai_other, unknown.joinToString(", ")), style = MaterialTheme.typography.bodyMedium)
        // What it reads with every category off too (core's AiAlways, docs/mcp.md's "Always included").
        if (connection.connected) {
            Text(stringResource(R.string.can_see_ai_always), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            AiAlways.ITEMS.forEach { Text("• ${it.words}", style = MaterialTheme.typography.bodyMedium) }
        }
        if (reads.isEmpty() && connection.connected) Text(stringResource(R.string.can_see_ai_none), style = MaterialTheme.typography.bodyMedium)
        val whereItGoes = when {
            connection.connected -> stringResource(R.string.data_sent_to_server, connection.host.orEmpty())
            connection.enrolled -> stringResource(R.string.data_disconnected)
            else -> stringResource(R.string.data_stays_here)
        }
        Text(whereItGoes, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

/**
 * Phase 4: the Location card: the mode in plain words, the interval and hours, the places'
 * names, whether location is locked on, and how many checks in the last 30 days.
 */
@Composable
internal fun LocationCard(kid: KidView, told: List<ToldEntry>, words: KidWords, onTold: () -> Unit) {
    val location = kid.policy?.location ?: return
    if (!LocationRules.collecting(location)) return
    KidCard(stringResource(R.string.section_location)) {
        when (location.mode) {
            WireLocationMode.OFF -> {}
            WireLocationMode.ON_DEMAND -> Text(stringResource(R.string.location_on_demand), style = MaterialTheme.typography.bodyLarge)
            WireLocationMode.PERIODIC -> {
                val every = LocationRules.everyMinutes(location)
                val start = location.hours?.start?.let(LocalTimes::clock)
                val end = location.hours?.end?.let(LocalTimes::clock)
                Text(
                    if (start == null || end == null || start == end) {
                        pluralStringResource(R.plurals.location_periodic, every, every)
                    } else {
                        pluralStringResource(R.plurals.location_periodic_hours, every, every, words.time(start), words.time(end))
                    },
                    style = MaterialTheme.typography.bodyLarge,
                )
                val places = LocationRules.places(location).map { it.name.trim() }.filter { it.isNotEmpty() }
                if (places.isNotEmpty()) Text(stringResource(R.string.location_places, words.list(places)), style = MaterialTheme.typography.bodyMedium)
                Text(stringResource(R.string.location_periodic_checks), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (location.lost != null) Text(stringResource(R.string.location_lost), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
        if (LocationRules.keepOn(location)) Text(stringResource(R.string.location_locked_on), style = MaterialTheme.typography.bodyMedium)
        if (kid.location?.locationOn == false) Text(stringResource(R.string.location_turned_off), style = MaterialTheme.typography.bodyMedium)
        val checks = Told.checks(told).size
        Text(
            if (checks == 0) stringResource(R.string.location_checks_none) else pluralStringResource(R.plurals.location_checks, checks, checks),
            style = MaterialTheme.typography.bodyMedium,
        )
        // Phase 12: a caregiver's checks aren't the parent's.
        val byCaregivers = Told.caregiverChecks(told).size
        if (byCaregivers > 0) Text(pluralStringResource(R.plurals.location_checks_caregivers, byCaregivers, byCaregivers), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.location_android_says), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onTold) { Text(stringResource(R.string.screen_told)) }
    }
}

/** What Belay told your parent: every check, lost mode and shared fix of the last 30 days, from the phone's own record. */
@Composable
internal fun ToldCard(told: List<ToldEntry>, words: KidWords) {
    KidCard(stringResource(R.string.screen_told)) {
        Text(stringResource(R.string.told_intro), style = MaterialTheme.typography.bodyMedium)
        if (told.isEmpty()) Text(stringResource(R.string.told_empty), style = MaterialTheme.typography.bodyMedium)
        val now = System.currentTimeMillis()
        told.forEachIndexed { i, entry ->
            if (i > 0) HorizontalDivider()
            val text = when (entry.kind) {
                ToldKind.CHECK -> when {
                    // Phase 12: a caregiver's check, by their name.
                    entry.caregiver != null && !entry.sent -> stringResource(R.string.told_check_by_not_sent, entry.caregiver.orEmpty())
                    entry.caregiver != null -> stringResource(R.string.told_check_by, entry.caregiver.orEmpty())
                    !entry.sent -> stringResource(R.string.told_check_not_sent)
                    entry.via != null -> stringResource(R.string.told_check_via, entry.via.orEmpty())
                    else -> stringResource(R.string.told_check)
                }
                ToldKind.LOST -> pluralStringResource(R.plurals.told_lost, entry.count, entry.count, words.at(Told.lastAt(entry), now))
                ToldKind.HELP -> stringResource(if (entry.sent) R.string.told_help else R.string.told_help_not_sent)
            }
            Column {
                Text(text, style = MaterialTheme.typography.bodyLarge)
                Text(words.at(entry.at, now), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
internal fun KidCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

const val NUMBER_911 = "911"
const val NUMBER_988 = "988"

/** The server's AI scope for the stage and the agreement, which the phone doesn't collect. */
private const val AGREEMENT_SCOPE = "agreement"
