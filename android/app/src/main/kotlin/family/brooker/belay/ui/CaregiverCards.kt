package family.brooker.belay.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import family.brooker.belay.R
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.kid.Caregivers
import family.brooker.belay.core.kid.ShownCaregiver

/*
 * Phase 12: the caregivers a parent gave some access to this phone for a while (core's
 * kid.Caregivers, from the policy's `caregivers`), so the kid always sees who has access
 * (principle 4): on What your parent can see, what each can see and do and until when (core's
 * DataCategories.caregiver), one line each on Home, and on Help who else gets help requests. Each
 * name is a parent's words, shown as plain text. A caregiver leaves these when their access ends,
 * by the phone's own clock, the next time the screen is drawn.
 */

/** "Caregivers your parent added", on What your parent can see: each one, what they can and can't see and do, and until when. */
@Composable
internal fun CaregiversCard(caregivers: List<ShownCaregiver>, words: KidWords) {
    val now = System.currentTimeMillis()
    KidCard(stringResource(R.string.section_caregivers)) {
        Text(stringResource(R.string.caregivers_intro), style = MaterialTheme.typography.bodyMedium)
        caregivers.forEach { caregiver ->
            val card = DataCategories.caregiver(caregiver, caregiverUntil(words, caregiver.until, now))
            Text(card.title, style = MaterialTheme.typography.titleSmall)
            card.details.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
        }
    }
}

/** Home: "Your parent gave Grandma some access to this phone until Sunday at 6:00 PM.", one line each, and their card. */
@Composable
internal fun CaregiversHomeCard(caregivers: List<ShownCaregiver>, words: KidWords, onOpen: () -> Unit) {
    val now = System.currentTimeMillis()
    KidCard(stringResource(R.string.section_caregivers)) {
        caregivers.forEach {
            Text(stringResource(R.string.home_caregiver, it.name, caregiverUntil(words, it.until, now)), style = MaterialTheme.typography.bodyLarge)
        }
        TextButton(onClick = onOpen) { Text(stringResource(R.string.home_caregivers_open)) }
    }
}

/** Help: "Grandma gets your help requests too, …", while any caregiver does. */
@Composable
internal fun CaregiversHelpLine(caregivers: List<ShownCaregiver>, words: KidWords) {
    val getting = Caregivers.gettingHelp(caregivers)
    if (getting.isEmpty()) return
    Text(
        pluralStringResource(R.plurals.help_caregivers, getting.size, words.list(getting.map { it.name })),
        style = MaterialTheme.typography.bodyLarge,
    )
}

/**
 * Until when, in the kid's words: "5:30 PM", "tomorrow at 7:00 AM" or "Sunday at 6:00 PM" within
 * the next 6 days, where a weekday can only mean one day; the date further on ("Dec 5, 6:00 PM"),
 * since access can last 30 days.
 */
internal fun caregiverUntil(words: KidWords, until: Long, now: Long): String =
    if (until - now < WEEKDAY_MS) words.until(until, now) else words.at(until, now)

private const val WEEKDAY_MS = 6L * 24 * 60 * 60 * 1000
