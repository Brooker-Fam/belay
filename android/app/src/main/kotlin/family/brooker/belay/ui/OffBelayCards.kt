package family.brooker.belay.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import family.brooker.belay.R
import family.brooker.belay.core.WireHandover
import family.brooker.belay.core.WireOffBelayPosition
import family.brooker.belay.core.kid.OffBelay

/**
 * Phase 11: the hand-over, first on Home while the policy has one (docs/protocol.md, "Off belay"):
 * what happens next, and what to back up first. Belay itself doesn't switch off; the reset does.
 */
@Composable
internal fun HandoverCard(handover: WireHandover) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.handover_title), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.handover_intro), style = MaterialTheme.typography.bodyLarge)
            val by = handover.by?.trim()?.takeIf { it.isNotEmpty() }?.take(MAX_NAME)
            Text(
                if (by != null) stringResource(R.string.handover_started_by, by, formatTime(handover.at)) else stringResource(R.string.handover_started, formatTime(handover.at)),
                style = MaterialTheme.typography.bodySmall,
            )
            listOf(R.string.handover_backup, R.string.handover_account, R.string.handover_reset).forEachIndexed { i, step ->
                Text("${i + 1}. " + stringResource(step), style = MaterialTheme.typography.bodyLarge)
            }
            Text(stringResource(R.string.handover_after), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.handover_together), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** Phase 11: Off belay on My stage, last, with the family's words for when it comes (core's kid.OffBelay). */
@Composable
internal fun OffBelayCard(line: OffBelay.Line) {
    KidCard(stringResource(R.string.off_belay_title)) {
        when (line.position) {
            WireOffBelayPosition.ON -> {
                Text(stringResource(R.string.off_belay_on), style = MaterialTheme.typography.bodyLarge)
                if (line.blocksNothing) Text(stringResource(R.string.off_belay_nothing_blocked), style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.off_belay_after_on), style = MaterialTheme.typography.bodyMedium)
            }
            WireOffBelayPosition.NEXT -> {
                Text(stringResource(R.string.off_belay_next), style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.off_belay_after), style = MaterialTheme.typography.bodyMedium)
            }
            WireOffBelayPosition.LATER -> {
                Text(
                    line.how?.let { stringResource(R.string.off_belay_last, it) } ?: stringResource(R.string.off_belay_last_plain),
                    style = MaterialTheme.typography.bodyLarge,
                )
                Text(stringResource(R.string.off_belay_after), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (line.position != WireOffBelayPosition.ON) Text(stringResource(R.string.off_belay_meaning), style = MaterialTheme.typography.bodySmall)
    }
}

/** A parent's name, as the policy caps it. */
private const val MAX_NAME = 60
