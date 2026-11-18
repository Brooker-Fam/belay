package family.brooker.belay.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.core.AnsweredRequest
import family.brooker.belay.core.KidRules.Rule
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.WireRequestStatus
import family.brooker.belay.enforce.KidView

/*
 * Phase 2: what the kid sees about the phone's rules. Every sentence comes from
 * strings.xml; app names come from their developers and the parent's notes from the
 * parent, so both are shown as plain text, never as anything to act on.
 */

/** The kid sends [reason] for [packageName] (Agent.ask). */
typealias Ask = (packageName: String, reason: String) -> Unit

@Composable
internal fun PausedBanner(pause: WirePause) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.paused_title), style = MaterialTheme.typography.titleLarge)
            Text(
                pause.until?.let { stringResource(R.string.paused_until, formatTime(it)) }
                    ?: stringResource(R.string.paused_until_resumed),
                style = MaterialTheme.typography.bodyLarge,
            )
            pause.note?.takeIf { it.isNotBlank() }?.let {
                Text(stringResource(R.string.paused_note, it), style = MaterialTheme.typography.bodyLarge)
            }
            Text(stringResource(R.string.paused_still_work), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// Phase 7: every answer, of every kind, is on My requests (KidScreens.kt's RequestsCard).

@Composable
internal fun WaitingCard(kid: KidView, unsent: Set<String>, onAsk: Ask) {
    val waiting = kid.plan?.waiting.orEmpty()
    if (waiting.isEmpty()) return
    KidSection(stringResource(R.string.section_waiting)) {
        Text(stringResource(R.string.waiting_intro), style = MaterialTheme.typography.bodyMedium)
        waiting.forEachIndexed { i, name ->
            if (i > 0) HorizontalDivider()
            val request = kid.requests.firstOrNull { it.forApp && it.request.packageName == name }
            AppName(kid.labels[name] ?: name, name)
            when {
                request == null -> {}
                request.request.id in unsent && request.request.reason == null ->
                    Text(stringResource(R.string.waiting_will_ask), style = MaterialTheme.typography.bodySmall)
                request.open -> Text(
                    stringResource(if (request.request.reason == null) R.string.waiting_asked else R.string.not_answered),
                    style = MaterialTheme.typography.bodySmall,
                )
                else -> Answer(request)
            }
            AskBox(name, request?.takeIf { it.open }, unsent, onAsk)
        }
    }
}

@Composable
internal fun BlockedCard(kid: KidView, unsent: Set<String>, onAsk: Ask) {
    val blocked = kid.plan?.blocked.orEmpty()
    if (blocked.isEmpty()) return
    KidSection(stringResource(R.string.section_blocked)) {
        Text(stringResource(R.string.blocked_intro), style = MaterialTheme.typography.bodyMedium)
        blocked.forEachIndexed { i, name ->
            if (i > 0) HorizontalDivider()
            AppName(kid.labels[name] ?: name, name)
            val open = kid.requests.firstOrNull { it.forApp && it.request.packageName == name && it.open }
            var asking by rememberSaveable(name) { mutableStateOf(open != null) }
            if (asking) {
                if (open?.request?.reason != null) Text(stringResource(R.string.not_answered), style = MaterialTheme.typography.bodySmall)
                AskBox(name, open, unsent, onAsk)
            } else {
                TextButton(onClick = { asking = true }) { Text(stringResource(R.string.ask_about_it)) }
            }
        }
    }
}

@Composable
internal fun RulesCard(kid: KidView) {
    KidSection(stringResource(R.string.section_rules)) {
        val rules = kid.rules
        if (rules.isEmpty()) {
            Text(stringResource(R.string.rules_none), style = MaterialTheme.typography.bodyMedium)
        } else {
            Text(stringResource(R.string.rules_intro), style = MaterialTheme.typography.bodyMedium)
            rules.filter { it !in CHROME }.forEach { RuleText(it, kid) }
            val chrome = rules.filter { it in CHROME }
            if (chrome.isNotEmpty()) {
                Text(stringResource(R.string.rule_chrome), style = MaterialTheme.typography.bodyLarge)
                chrome.forEach { Text("• ${stringResource(chromeWords(it))}", style = MaterialTheme.typography.bodyMedium) }
            }
        }
        // Phase 5: who can call and whom the kid can call, while the family has calls on.
        kid.policy?.calls?.let { CallRulesText(it) }
        Text(stringResource(R.string.rules_emergency), style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Phase 13: the apps Android keeps off mobile data for Belay now, each with why: only those (an app
 * the policy lists that isn't installed, or that Belay can't restrict, isn't here). The rule above
 * says what it means.
 */
@Composable
internal fun WifiOnlyCard(kid: KidView) {
    if (kid.wifiOnly.isEmpty()) return
    KidSection(stringResource(R.string.section_wifi_only)) {
        Text(stringResource(R.string.wifi_only_intro), style = MaterialTheme.typography.bodyMedium)
        kid.wifiOnly.forEachIndexed { i, name ->
            if (i > 0) HorizontalDivider()
            AppName(kid.labels[name] ?: name, name)
            Text(stringResource(R.string.wifi_only_app), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun RuleText(rule: Rule, kid: KidView) {
    val (what, why) = when (rule) {
        Rule.NEW_APPS_WAIT -> stringResource(R.string.rule_new_apps) to stringResource(R.string.rule_new_apps_why)
        Rule.NO_SAFE_MODE -> stringResource(R.string.rule_safe_mode) to stringResource(R.string.rule_safe_mode_why)
        Rule.NO_NEW_USERS -> stringResource(R.string.rule_users) to stringResource(R.string.rule_users_why)
        Rule.NO_UNKNOWN_SOURCES -> stringResource(R.string.rule_unknown_sources) to stringResource(R.string.rule_unknown_sources_why)
        Rule.NO_VPN -> stringResource(R.string.rule_vpn) to stringResource(R.string.rule_vpn_why)
        Rule.WEB_FILTER -> stringResource(R.string.rule_web_filter) to stringResource(R.string.rule_web_filter_why, kid.privateDns.orEmpty())
        Rule.PRIVATE_DNS_LOCKED -> stringResource(R.string.rule_private_dns) to stringResource(R.string.rule_private_dns_why)
        Rule.CLOCK_LOCKED -> stringResource(R.string.rule_clock) to stringResource(R.string.rule_clock_why)
        Rule.DEFAULT_APPS_LOCKED -> stringResource(R.string.rule_default_apps) to stringResource(R.string.rule_default_apps_why)
        Rule.ACCOUNTS_LOCKED -> stringResource(R.string.rule_accounts) to stringResource(R.string.rule_accounts_why)
        Rule.PLAY_ACCOUNTS -> stringResource(R.string.rule_play_accounts) to stringResource(R.string.rule_play_accounts_why)
        Rule.NO_NEW_ESIM -> stringResource(R.string.rule_esim) to stringResource(R.string.rule_esim_why)
        Rule.NO_FACTORY_RESET -> stringResource(R.string.rule_factory_reset) to stringResource(R.string.rule_factory_reset_why)
        Rule.RESET_PROTECTION -> stringResource(R.string.rule_reset_protection) to stringResource(R.string.rule_reset_protection_why)
        Rule.NO_DEBUGGING -> stringResource(R.string.rule_debugging) to stringResource(R.string.rule_debugging_why)
        Rule.REPAIR_MODE ->
            stringResource(R.string.rule_repair, kid.plan?.maintenanceUntil?.let { formatTime(it) }.orEmpty()) to
                stringResource(R.string.rule_repair_why)
        Rule.RECOVERY_OPEN ->
            stringResource(R.string.rule_recovery, kid.plan?.recoveryUntil?.let { formatTime(it) }.orEmpty()) to
                stringResource(R.string.rule_recovery_why)
        Rule.NO_BROWSERS -> stringResource(R.string.rule_no_browsers) to stringResource(R.string.rule_no_browsers_why)
        Rule.LOCATION_LOCKED_ON -> stringResource(R.string.rule_location) to stringResource(R.string.rule_location_why)
        Rule.WIFI_ONLY ->
            stringResource(R.string.rule_wifi_only) to
                stringResource(R.string.rule_wifi_only_why, KidWords(LocalContext.current) { kid.labels[it] ?: it }.apps(kid.wifiOnly))
        else -> return
    }
    Column {
        Text(what, style = MaterialTheme.typography.bodyLarge)
        Text(why, style = MaterialTheme.typography.bodySmall)
    }
}

private val CHROME = setOf(
    Rule.CHROME_NO_INCOGNITO, Rule.CHROME_SAFE_SEARCH, Rule.CHROME_YOUTUBE_RESTRICTED, Rule.CHROME_SAFE_SITES,
    Rule.CHROME_NO_DOWNLOADS, Rule.CHROME_NO_PROXY, Rule.CHROME_ALLOWLIST, Rule.CHROME_BLOCKLIST,
)

private fun chromeWords(rule: Rule): Int = when (rule) {
    Rule.CHROME_NO_INCOGNITO -> R.string.rule_chrome_incognito
    Rule.CHROME_SAFE_SEARCH -> R.string.rule_chrome_safe_search
    Rule.CHROME_YOUTUBE_RESTRICTED -> R.string.rule_chrome_youtube
    Rule.CHROME_SAFE_SITES -> R.string.rule_chrome_safe_sites
    Rule.CHROME_NO_DOWNLOADS -> R.string.rule_chrome_downloads
    Rule.CHROME_NO_PROXY -> R.string.rule_chrome_proxy
    Rule.CHROME_ALLOWLIST -> R.string.rule_chrome_allowlist
    else -> R.string.rule_chrome_blocklist
}

/** The parent's answer: what they said, their note, who and when. */
@Composable
private fun Answer(request: AnsweredRequest) {
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
    val at = answer.answeredAt?.let { formatTime(it) }
    val by = answer.answeredBy?.takeIf { it.isNotBlank() }
    when {
        by != null && at != null -> Text(stringResource(R.string.answer_by, by, at), style = MaterialTheme.typography.bodySmall)
        by != null -> Text(by, style = MaterialTheme.typography.bodySmall)
        at != null -> Text(at, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * "Why I want it" and Send, for [packageName]. Sending again before an answer updates the
 * same request (its reason); after an answer it's a new request.
 */
@Composable
private fun AskBox(packageName: String, open: AnsweredRequest?, unsent: Set<String>, onAsk: Ask) {
    val sentReason = open?.request?.reason
    var text by rememberSaveable(packageName, open?.request?.id) { mutableStateOf(sentReason.orEmpty()) }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it.take(WireLimits.MAX_REASON) },
        label = { Text(stringResource(R.string.why_label)) },
        placeholder = { Text(stringResource(R.string.why_hint)) },
        supportingText = { Text(stringResource(R.string.why_counter, text.length, WireLimits.MAX_REASON)) },
        modifier = Modifier.fillMaxWidth(),
        minLines = 2,
    )
    val trimmed = text.trim()
    Button(onClick = { onAsk(packageName, trimmed) }, enabled = trimmed.isNotEmpty() && trimmed != sentReason) {
        Text(stringResource(R.string.why_send))
    }
    if (sentReason != null && trimmed == sentReason) {
        val waiting = open.request.id in unsent
        Text(stringResource(if (waiting) R.string.why_waiting_to_send else R.string.why_sent), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun AppName(label: String, packageName: String) {
    Column {
        Text(label, style = MaterialTheme.typography.titleSmall)
        Text(packageName, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
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

