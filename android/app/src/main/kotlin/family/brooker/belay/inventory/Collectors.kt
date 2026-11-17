package family.brooker.belay.inventory

import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.DataCategory

/**
 * The collectors that run on this phone, and the data category each one fills. The
 * kid-facing "What your parent can see" list is built from this list, so adding a
 * collector without adding its category here is the only way to make the screen wrong.
 * Keep one entry per collector class:
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
 *   it": [DataCategories.REQUESTS].
 */
object Collectors {
    val categories: List<DataCategory> = listOf(DataCategories.APPS, DataCategories.DEVICE_STATUS, DataCategories.REQUESTS)
}
