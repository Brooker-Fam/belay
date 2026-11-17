package family.brooker.belay.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.core.AnsweredRequest
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WireRequestKind
import family.brooker.belay.core.WireRequestStatus
import family.brooker.belay.core.screentime.LimitStatus
import family.brooker.belay.core.screentime.LocalTimes
import family.brooker.belay.core.screentime.Stages
import family.brooker.belay.core.screentime.WireAgreementAnswer
import family.brooker.belay.core.screentime.WireLimitState
import family.brooker.belay.core.screentime.WireSchedule
import family.brooker.belay.enforce.KidView
import family.brooker.belay.enforce.ScreenTimeView
import java.util.UUID

/*
 * Phase 3: what the kid sees about screen time. Every sentence comes from strings.xml through
 * KidWords; the family's own words (limit, schedule and stage names, the agreement) and the
 * parent's notes are shown as plain text, and app names come from their developers.
 */

/** What the kid can do about screen time from Belay's screen. */
class ScreenTimeActions(
    /** Ask a parent for [minutes] more for [limitId] today, from [packageName] if known. */
    val askMoreTime: (limitId: String, minutes: Int, packageName: String?, reason: String) -> Unit,
    /** Take self-serve minutes for [limitId]; [id] is made once per tap. */
    val takeMinutes: (limitId: String, packageName: String?, id: String) -> Unit,
    val answerAgreement: (version: Int, answer: WireAgreementAnswer, reason: String) -> Unit,
    /** Settings' usage access switch for Belay. */
    val openUsageAccess: () -> Unit,
)

/** The more-time choices offered, within the protocol's 5 to 240 minutes. */
private val MORE_TIME_CHOICES = listOf(15, 30, 60)

/**
 * Today: Belay can't count (and how to fix it), the schedules on now, each limit's time left
 * with "Ask for more time" (and self-serve when the family allows it), every schedule, and what
 * always works. [askFor]: a limit to ask about at once (from a time's-up notification).
 */
@Composable
internal fun TodayCard(kid: KidView, unsent: Set<String>, actions: ScreenTimeActions, askFor: String?, onAsked: () -> Unit) {
    val screenTime = kid.screenTime ?: return
    val context = LocalContext.current
    val words = remember(kid.labels) { KidWords(context) { kid.labels[it] ?: it } }
    val decision = screenTime.decision
    var asking by rememberSaveable { mutableStateOf<String?>(null) }
    val pendingAsk = askFor?.takeIf { id -> decision.limits.any { it.id == id } }
    KidSection(stringResource(R.string.section_today)) {
        Text(
            stringResource(if (screenTime.policy.measure) R.string.today_intro_measured else R.string.today_intro),
            style = MaterialTheme.typography.bodyMedium,
        )
        decision.unmeasured?.let { text ->
            Text(words.text(text), style = MaterialTheme.typography.bodyLarge)
            Button(onClick = actions.openUsageAccess) { Text(stringResource(R.string.usage_access_button)) }
        }
        decision.schedules.forEach { Text(words.text(it.kidText), style = MaterialTheme.typography.bodyLarge) }
        if (decision.limits.isNotEmpty()) {
            Text(stringResource(R.string.today_limits), style = MaterialTheme.typography.titleSmall)
            decision.limits.forEachIndexed { i, limit ->
                if (i > 0) HorizontalDivider()
                LimitRow(screenTime, limit, words, kid, unsent, actions) { asking = limit.id }
            }
            decision.selfServe?.kidText?.let { Text(words.text(it), style = MaterialTheme.typography.bodyMedium) }
        }
        val schedules = screenTime.policy.schedules
        if (schedules.isNotEmpty()) {
            Text(stringResource(R.string.today_schedules), style = MaterialTheme.typography.titleSmall)
            schedules.forEach { ScheduleLine(it, words) }
        }
        if (decision.limits.isEmpty() && schedules.isEmpty()) {
            Text(stringResource(R.string.today_no_rules), style = MaterialTheme.typography.bodyMedium)
        }
        Text(stringResource(R.string.today_always_open), style = MaterialTheme.typography.bodySmall)
    }
    val open = asking ?: pendingAsk
    val limit = decision.limits.firstOrNull { it.id == open }
    if (limit != null) {
        AskMoreTimeDialog(
            limit = limit,
            onSend = { minutes, reason ->
                actions.askMoreTime(limit.id, minutes, limit.packages.singleOrNull(), reason)
                asking = null
                onAsked()
            },
            onDismiss = {
                asking = null
                onAsked()
            },
        )
    }
}

@Composable
private fun LimitRow(
    screenTime: ScreenTimeView,
    limit: LimitStatus,
    words: KidWords,
    kid: KidView,
    unsent: Set<String>,
    actions: ScreenTimeActions,
    onAsk: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(words.text(limit.kidText), style = MaterialTheme.typography.bodyLarge)
        val allowed = limit.baseMillis + limit.extraMillis
        if (allowed > 0 && screenTime.decision.measured) {
            val used = (limit.usedMillis.toFloat() / allowed).coerceIn(0f, 1f)
            LinearProgressIndicator(progress = { used }, modifier = Modifier.fillMaxWidth())
        }
        val request = kid.requests.firstOrNull {
            it.request.kind == WireRequestKind.MORE_TIME && it.request.limitId == limit.id && it.request.askedAt >= screenTime.todayStart
        }
        request?.let { MoreTimeAnswer(it, limit, words, unsent) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (request == null || !request.open) TextButton(onClick = onAsk) { Text(stringResource(R.string.ask_more_time)) }
            val selfServe = screenTime.decision.selfServe
            if (selfServe != null && selfServe.timesLeft > 0 && limit.state == WireLimitState.USED_UP) {
                // A new id per take, so a double tap takes once.
                val id = remember(limit.id, selfServe.taken) { UUID.randomUUID().toString() }
                OutlinedButton(onClick = { actions.takeMinutes(limit.id, limit.packages.singleOrNull(), id) }) {
                    Text(stringResource(R.string.self_serve_button, words.duration(selfServe.minutes)))
                }
            }
        }
    }
}

/** Where the kid's request for more time stands, and the parent's answer. */
@Composable
private fun MoreTimeAnswer(request: AnsweredRequest, limit: LimitStatus, words: KidWords, unsent: Set<String>) {
    val asked = words.duration(request.request.minutes ?: 0)
    val answer = request.answer
    val text = when (answer?.status) {
        null, WireRequestStatus.PENDING -> stringResource(R.string.more_time_asked, asked, limit.name)
        WireRequestStatus.APPROVED -> answer.minutes?.let { stringResource(R.string.more_time_given, words.duration(it), limit.name) }
            ?: stringResource(R.string.more_time_yes, limit.name)
        WireRequestStatus.DECLINED -> stringResource(R.string.more_time_no, limit.name)
        WireRequestStatus.TALK -> stringResource(R.string.more_time_talk, limit.name)
    }
    Text(text, style = MaterialTheme.typography.bodyMedium)
    answer?.note?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.answer_note, it), style = MaterialTheme.typography.bodyMedium) }
    if (request.open && request.request.id in unsent) {
        Text(stringResource(R.string.ask_more_time_waiting), style = MaterialTheme.typography.bodySmall)
    }
}

/** "Bedtime: 9:00 PM to 7:00 AM, every day", and the apps that stay open during it. */
@Composable
private fun ScheduleLine(schedule: WireSchedule, words: KidWords) {
    val start = LocalTimes.clock(schedule.start) ?: return
    val end = LocalTimes.clock(schedule.end) ?: return
    Column {
        Text(
            stringResource(
                R.string.today_schedule_line,
                schedule.name,
                words.time(start),
                words.time(end),
                words.days(schedule.days.mapTo(HashSet()) { it.dayOfWeek }),
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
        if (schedule.allow.isNotEmpty()) {
            Text(stringResource(R.string.today_schedule_allows, words.apps(schedule.allow)), style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** "Ask for more time": how many minutes, and why if the kid wants to say. */
@Composable
private fun AskMoreTimeDialog(limit: LimitStatus, onSend: (minutes: Int, reason: String) -> Unit, onDismiss: () -> Unit) {
    var minutes by rememberSaveable(limit.id) { mutableIntStateOf(MORE_TIME_CHOICES.first()) }
    var reason by rememberSaveable(limit.id) { mutableStateOf("") }
    val context = LocalContext.current
    val words = remember { KidWords(context) { it } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ask_more_time_title, limit.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.ask_more_time_how_much), style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MORE_TIME_CHOICES.forEach { choice ->
                        FilterChip(selected = minutes == choice, onClick = { minutes = choice }, label = { Text(words.duration(choice)) })
                    }
                }
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it.take(WireLimits.MAX_REASON) },
                    label = { Text(stringResource(R.string.ask_more_time_why)) },
                    supportingText = { Text(stringResource(R.string.why_counter, reason.length, WireLimits.MAX_REASON)) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSend(minutes, reason.trim()) }) { Text(stringResource(R.string.ask_more_time_send)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

/** Your stage: its name, what the next stage changes (in Belay's words, or the family's), and how to get there. */
@Composable
internal fun StageCard(kid: KidView) {
    val policy = kid.policy ?: return
    val stage = policy.stage ?: return
    val context = LocalContext.current
    val words = remember(kid.labels) { KidWords(context) { kid.labels[it] ?: it } }
    KidSection(stringResource(R.string.section_stage, stage.name)) {
        Text(stringResource(R.string.stage_since, formatTime(stage.since)), style = MaterialTheme.typography.bodySmall)
        val next = stage.next ?: return@KidSection
        Text(stringResource(R.string.stage_next, next.name), style = MaterialTheme.typography.titleSmall)
        val changes = Stages.next(policy).map { words.text(it.kidText) }.ifEmpty { next.unlocks }
        changes.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
        next.how?.takeIf { it.isNotBlank() }?.let { how ->
            Text(stringResource(R.string.stage_how), style = MaterialTheme.typography.titleSmall)
            Text(how, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** Your family agreement: the family's sections, and "I agree" or "I want to talk about it". */
@Composable
internal fun AgreementCard(kid: KidView, unsent: Set<String>, actions: ScreenTimeActions) {
    val agreement = kid.policy?.agreement ?: return
    var reason by rememberSaveable(agreement.version) { mutableStateOf("") }
    KidSection(stringResource(R.string.section_agreement)) {
        Text(stringResource(R.string.agreement_intro), style = MaterialTheme.typography.bodyMedium)
        agreement.sections.forEach { section ->
            Column {
                Text(section.title, style = MaterialTheme.typography.titleSmall)
                Text(section.text, style = MaterialTheme.typography.bodyMedium)
            }
        }
        agreement.kidAgreedAt?.let { Text(stringResource(R.string.agreement_kid_agreed, formatTime(it)), style = MaterialTheme.typography.bodySmall) }
        agreement.parentsAgreedAt?.let { Text(stringResource(R.string.agreement_parents_agreed, formatTime(it)), style = MaterialTheme.typography.bodySmall) }
        val answered = kid.requests.firstOrNull { it.request.kind == WireRequestKind.AGREEMENT && it.request.version == agreement.version }
        answered?.let { request ->
            Text(
                stringResource(if (request.request.answer == WireAgreementAnswer.AGREE) R.string.agreement_said_agree else R.string.agreement_said_talk),
                style = MaterialTheme.typography.bodyMedium,
            )
            request.answer?.note?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.answer_note, it), style = MaterialTheme.typography.bodyMedium) }
            if (request.open && request.request.id in unsent) {
                Text(stringResource(R.string.why_waiting_to_send), style = MaterialTheme.typography.bodySmall)
            }
        }
        OutlinedTextField(
            value = reason,
            onValueChange = { reason = it.take(WireLimits.MAX_REASON) },
            label = { Text(stringResource(R.string.agreement_why)) },
            supportingText = { Text(stringResource(R.string.why_counter, reason.length, WireLimits.MAX_REASON)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { actions.answerAgreement(agreement.version, WireAgreementAnswer.AGREE, reason.trim()) }) {
                Text(stringResource(R.string.agreement_agree))
            }
            OutlinedButton(onClick = { actions.answerAgreement(agreement.version, WireAgreementAnswer.TALK, reason.trim()) }) {
                Text(stringResource(R.string.agreement_talk))
            }
        }
    }
}

@Composable
private fun KidSection(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}
