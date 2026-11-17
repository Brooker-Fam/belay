package family.brooker.belay.ui

import android.content.Context
import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import family.brooker.belay.AgentView
import family.brooker.belay.BuildConfig
import family.brooker.belay.R
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.ChangeKind
import family.brooker.belay.core.DataCategory
import family.brooker.belay.core.Detection
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.WireAgentUpdate
import family.brooker.belay.core.WireDevice
import family.brooker.belay.core.WireUpdateState
import family.brooker.belay.health.Health
import family.brooker.belay.health.HealthReader
import family.brooker.belay.inventory.Collectors
import family.brooker.belay.settings.Connection

/**
 * [connection] is null while it loads; [waiting] is how many outbox items wait to be sent;
 * [unsentRequests] the requests with a send still waiting. Phase 2's cards come first: a
 * pause, the apps waiting for a parent, the answers, blocked apps and the rules.
 */
@Composable
fun MainScreen(
    view: AgentView?,
    connection: Connection?,
    waiting: Int,
    unsentRequests: Set<String>,
    onAsk: Ask,
    onConnect: () -> Unit,
    onAllowBattery: () -> Unit,
    onRelease: (() -> Unit)?,
    onRecovery: () -> Unit,
) {
    Scaffold { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Header() }
            if (view == null || connection == null) {
                item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                return@LazyColumn
            }
            val kid = view.kid
            kid.plan?.pause?.let { pause -> item { PausedBanner(pause) } }
            if (kid.plan?.waiting.orEmpty().isNotEmpty()) item { WaitingCard(kid, unsentRequests, onAsk) }
            if (kid.requests.any { !it.open }) item { AnswersCard(kid) }
            if (kid.plan?.blocked.orEmpty().isNotEmpty()) item { BlockedCard(kid, unsentRequests, onAsk) }
            item { RulesCard(kid) }
            item { StatusCard(view) }
            item { ConnectionCard(connection, waiting, onConnect) }
            item { CanSeeCard(Collectors.categories, connection) }
            item { ChangesCard(view.changes, view.inventory) }
            item { ChecksCard(view.health, onAllowBattery) }
            item { PhoneCard(view.health, view.device) }
            item { SelfCard(view.health, view.inventory[LocalContext.current.packageName], view.update, kid.policy?.agentUpdate, onRecovery) }
            item { HeartbeatsCard(view.heartbeats) }
            if (onRelease != null && view.health.deviceOwner) item { ReleaseButton(onRelease) }
        }
    }
}

@Composable
private fun Header() {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.main_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.main_intro), style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun StatusCard(view: AgentView) {
    val apps = view.inventory.values
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (view.health.deviceOwner) {
                Text(stringResource(R.string.status_set_up), style = MaterialTheme.typography.titleMedium)
            } else {
                Text(stringResource(R.string.status_not_set_up), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.status_not_set_up_detail), style = MaterialTheme.typography.bodyMedium)
            }
            val launchable = apps.count { it.launchable }
            Text(
                pluralStringResource(R.plurals.apps_launchable, launchable, launchable),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                pluralStringResource(R.plurals.packages_total, apps.size, apps.size),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/** Which server, if any; what was sent and what waits. */
@Composable
private fun ConnectionCard(connection: Connection, waiting: Int, onConnect: () -> Unit) {
    Section(stringResource(R.string.section_connection)) {
        when {
            connection.connected -> {
                Text(stringResource(R.string.connection_connected, connection.host.orEmpty()), style = MaterialTheme.typography.bodyLarge)
                connection.deviceName?.let {
                    Text(stringResource(R.string.connection_device_name, it), style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    connection.lastSyncAt?.let { stringResource(R.string.connection_last_sync, formatTime(it)) }
                        ?: stringResource(R.string.connection_never_synced),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    if (waiting == 0) {
                        stringResource(R.string.connection_nothing_waiting)
                    } else {
                        pluralStringResource(R.plurals.connection_waiting, waiting, waiting)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (connection.lastFailureAt != null) {
                    Text(stringResource(R.string.connection_trouble), style = MaterialTheme.typography.bodySmall)
                }
            }
            connection.enrolled -> {
                Text(stringResource(R.string.connection_disconnected), style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.connection_disconnected_detail), style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = onConnect) { Text(stringResource(R.string.connection_connect_again)) }
            }
            else -> {
                Text(stringResource(R.string.connection_none), style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.connection_none_detail), style = MaterialTheme.typography.bodyMedium)
                Button(onClick = onConnect) { Text(stringResource(R.string.connection_connect)) }
            }
        }
        Text(stringResource(R.string.connection_version, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun CanSeeCard(categories: List<DataCategory>, connection: Connection) {
    Section(stringResource(R.string.section_can_see)) {
        categories.forEach { category ->
            Text(category.title, style = MaterialTheme.typography.titleSmall)
            category.details.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
        }
        val whereItGoes = when {
            connection.connected -> stringResource(R.string.data_sent_to_server, connection.host.orEmpty())
            connection.enrolled -> stringResource(R.string.data_disconnected)
            else -> stringResource(R.string.data_stays_here)
        }
        Text(whereItGoes, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ChangesCard(changes: List<AppChange>, inventory: Map<String, PackageRecord>) {
    Section(stringResource(R.string.section_changes)) {
        if (changes.isEmpty()) Text(stringResource(R.string.no_changes), style = MaterialTheme.typography.bodyMedium)
        changes.forEach { change ->
            Column {
                Text("${kindLabel(change.kind)} · ${change.label}", style = MaterialTheme.typography.bodyLarge)
                val version = when {
                    change.from != null && change.to != null && change.from != change.to -> "${change.from} → ${change.to}"
                    else -> (change.to ?: change.from)?.toString().orEmpty()
                }
                // Where it came from, while it's still installed (removed apps have no source).
                val source = inventory[change.packageName]?.takeIf { change.kind != ChangeKind.REMOVED }?.source
                Text(
                    listOf(formatTime(change.happenedAt ?: change.detectedAt), detectionLabel(change.detection), version)
                        .filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                )
                if (source != null) Text("from ${source.description}", style = MaterialTheme.typography.bodySmall)
                Text(change.packageName, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun ChecksCard(health: Health, onAllowBattery: () -> Unit) {
    Section(stringResource(R.string.section_checks)) {
        Check(stringResource(R.string.check_device_owner), health.deviceOwner)
        Check(stringResource(R.string.check_uninstall_blocked), health.uninstallBlocked == true)
        Check(stringResource(R.string.check_notifications), health.notificationsShown)
        health.permissions.forEach { p ->
            Check(
                stringResource(R.string.check_permission, p.name) + if (p.fixedByPolicy) " (locked by policy)" else "",
                p.granted,
            )
        }
        Check(stringResource(R.string.check_battery), health.batteryExempt) {
            if (!health.batteryExempt) TextButton(onClick = onAllowBattery) { Text(stringResource(R.string.fix_battery)) }
        }
        Check(stringResource(R.string.check_usage_access), health.usageAccess)
        Check(
            stringResource(R.string.check_service) + (health.serviceRunningSince?.let { " since ${formatTime(it)}" } ?: ""),
            health.serviceRunningSince != null,
        )
        Fact("Standby bucket", HealthReader.bucketName(health.standbyBucket))
        Fact("Background restricted", if (health.backgroundRestricted) "yes" else "no")
        Fact(stringResource(R.string.check_other_users), health.otherUsers?.toString() ?: stringResource(R.string.unknown))
        Fact(
            stringResource(R.string.check_foreign_restrictions),
            health.foreignRestrictions.joinToString(", ").ifEmpty { stringResource(R.string.none) },
        )
    }
}

@Composable
private fun PhoneCard(health: Health, device: WireDevice) {
    Section(stringResource(R.string.section_phone)) {
        val phone = health.phone
        val context = LocalContext.current
        Fact("Model", "${phone.manufacturer} ${phone.model}")
        Fact("Android", "${phone.androidRelease} (API ${phone.sdk})")
        Fact("Security update", phone.securityPatch)
        Fact("Boot count", health.bootCount?.toString() ?: "unavailable")
        Fact("Last restart", formatTime(health.lastBootAt))
        val percent = device.batteryPercent
        Fact(
            stringResource(R.string.phone_battery),
            when {
                percent == null -> stringResource(R.string.unknown)
                device.charging == true -> stringResource(R.string.phone_battery_charging, percent)
                else -> stringResource(R.string.phone_battery_value, percent)
            },
        )
        val free = device.storageFreeBytes
        val total = device.storageTotalBytes
        Fact(
            stringResource(R.string.phone_storage),
            if (free == null || total == null) {
                stringResource(R.string.unknown)
            } else {
                stringResource(R.string.phone_storage_value, Formatter.formatShortFileSize(context, free), Formatter.formatShortFileSize(context, total))
            },
        )
        Fact(stringResource(R.string.phone_time_zone), device.timezone)
    }
}

/**
 * About Belay: its version and where it came from, how an update a parent chose is going
 * (Phase 6), and Recovery, for a parent whose Belay server is gone.
 */
@Composable
private fun SelfCard(health: Health, self: PackageRecord?, update: UpdateRecord?, offer: WireAgentUpdate?, onRecovery: () -> Unit) {
    Section(stringResource(R.string.section_self)) {
        Fact("Version", health.agentVersion + if (health.testOnly) ", debug (test-only)" else ", release")
        if (self != null) {
            Fact("Came from", self.source.description)
            Fact("installing", self.installer.installing ?: "none")
            Fact("initiating", self.installer.initiating ?: "none")
            Fact("update owner", self.installer.updateOwner ?: "none")
            Fact("package source", self.installer.packageSource?.toString() ?: "n/a")
        }
        UpdateLine(update, offer)
        OutlinedButton(onClick = onRecovery) { Text(stringResource(R.string.recovery_button)) }
        Text(stringResource(R.string.recovery_button_hint), style = MaterialTheme.typography.bodySmall)
    }
}

/** Only what Belay did: an update it installed, or one the policy still offers. */
@Composable
private fun UpdateLine(update: UpdateRecord?, offer: WireAgentUpdate?) {
    if (update == null) return
    val offered = offer?.sha256 == update.sha256
    val words = when {
        update.state == WireUpdateState.DONE && update.installed && update.versionCode == BuildConfig.VERSION_CODE.toLong() ->
            stringResource(R.string.parent_updated, BuildConfig.VERSION_NAME)
        !offered -> return
        update.state == WireUpdateState.DOWNLOADING -> stringResource(R.string.about_update_downloading)
        update.state == WireUpdateState.CHECKING -> stringResource(R.string.about_update_checking)
        update.state == WireUpdateState.INSTALLING -> stringResource(R.string.about_update_installing)
        update.state == WireUpdateState.FAILED -> stringResource(R.string.about_update_failed)
        else -> return
    }
    Text(words, style = MaterialTheme.typography.bodyMedium)
    Text(formatTime(update.at), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun HeartbeatsCard(heartbeats: List<Heartbeat>) {
    Section(stringResource(R.string.section_background)) {
        heartbeats.forEach { beat ->
            Text(
                "${formatTime(beat.at)} · ${beat.trigger}" + (beat.note?.let { ": $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ReleaseButton(onRelease: () -> Unit) {
    var confirming by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { confirming = true }, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.release_button))
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.release_confirm_title)) },
            text = { Text(stringResource(R.string.release_confirm_text)) },
            confirmButton = {
                TextButton(onClick = { confirming = false; onRelease() }) { Text(stringResource(R.string.release_confirm_yes)) }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun Check(label: String, ok: Boolean, action: @Composable () -> Unit = {}) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(
            if (ok) "✓" else "✗",
            color = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.width(24.dp),
        )
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        action()
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun kindLabel(kind: ChangeKind): String = stringResource(
    when (kind) {
        ChangeKind.INSTALLED -> R.string.kind_installed
        ChangeKind.UPDATED -> R.string.kind_updated
        ChangeKind.REMOVED -> R.string.kind_removed
        ChangeKind.REINSTALLED -> R.string.kind_reinstalled
    },
)

@Composable
private fun detectionLabel(detection: Detection): String = stringResource(
    when (detection) {
        Detection.BROADCAST -> R.string.detected_broadcast
        Detection.CHANGED_PACKAGES -> R.string.detected_changed_packages
        Detection.SNAPSHOT -> R.string.detected_snapshot
    },
)

@Composable
internal fun formatTime(millis: Long): String = formatTime(LocalContext.current, millis)

internal fun formatTime(context: Context, millis: Long): String = DateUtils.formatDateTime(
    context,
    millis,
    DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH,
)
