package family.brooker.belay.inventory

import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.DataCategory
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.location.LocationRules

/**
 * The collectors that run on this phone, and the data category each one fills. The
 * kid-facing "What your parent can see" list is built from this list, so adding a
 * collector without adding its category here is the only way to make the screen wrong.
 * From Phase 3 the list follows the policy: a collector the policy turns on is listed the
 * moment it's on, and goes when it's off. Keep one entry per collector class:
 * - [PackageReader] reads the apps, with the sensitive permissions and special access each
 *   holds: [DataCategories.APPS].
 * - [family.brooker.belay.health.HealthReader] reads phone facts and Belay's own health (with
 *   the count of other users and the restrictions Belay didn't set),
 *   [family.brooker.belay.health.DeviceStatus] adds the battery, storage, time zone, clock,
 *   Belay's signing certificate and the enforcement report (with the update's state, the
 *   recovery key's use, the commands' results and the packages never blocked), and
 *   [family.brooker.belay.enforce.PhoneFacts] notices a changed SIM card and other users or
 *   profiles for it: [DataCategories.DEVICE_STATUS].
 * - [family.brooker.belay.enforce.EnforcementStep] asks for each new app that waits for a
 *   parent, and [family.brooker.belay.Agent.ask] sends what the kid writes in "Why I want
 *   it"; Phase 3's [family.brooker.belay.Agent.askMoreTime] and
 *   [family.brooker.belay.Agent.answerAgreement] send more-time requests and the kid's answer
 *   to the agreement: [DataCategories.REQUESTS].
 * - Phase 3, only while the policy has screen_time: [family.brooker.belay.screentime.UsageReader]
 *   reads how long apps are on the screen, and [family.brooker.belay.screentime.ScreenTimeStep]
 *   sends the usage days (only while `measure` is on: [DataCategories.SCREEN_TIME]) and puts
 *   where each limit stands in the enforcement report (with `measure` off, without the
 *   minutes: [DataCategories.SCREEN_TIME_LIMITS]).
 * - Phase 5, only while the policy's calls has `log` on: [family.brooker.belay.calls.CallFlow] and
 *   [family.brooker.belay.calls.BelayCallScreeningService] note each call (when, which way, how
 *   long, how it ended, and the contact or the number), and [family.brooker.belay.Agent.recordCall]
 *   sends it, never one with 911, an emergency number, 988 or a private number:
 *   [DataCategories.CALLS]. Whether Belay is the dialer goes in the device status; "Ask to add a
 *   contact" ([family.brooker.belay.Agent.askContact]) is a request: [DataCategories.REQUESTS].
 * - Phase 4, only while the policy's location is on (a mode, or lost mode):
 *   [family.brooker.belay.location.LocationCollector] takes single fixes, and
 *   [family.brooker.belay.location.LocationStep] sends them with the place events and puts
 *   location's status in the enforcement report: [DataCategories.location]. Phase 7's help fix,
 *   which the kid chooses to share even with location off, is in [DataCategories.REQUESTS]
 *   ([family.brooker.belay.Agent.askHelp], [family.brooker.belay.Agent.shareWhereThePhoneIs]).
 */
object Collectors {
    /** [clock] shows a policy's "HH:MM" as the kid's phone shows times. */
    fun categories(policy: WirePolicy?, clock: (String) -> String = { it }): List<DataCategory> =
        listOf(DataCategories.APPS, DataCategories.DEVICE_STATUS, DataCategories.REQUESTS) +
            listOfNotNull(
                policy?.screenTime?.let { DataCategories.screenTime(it.measure) },
                policy?.location?.takeIf { LocationRules.collecting(it) }?.let { DataCategories.location(it, clock) },
                policy?.calls?.takeIf { it.log }?.let { DataCategories.CALLS },
            )
}
