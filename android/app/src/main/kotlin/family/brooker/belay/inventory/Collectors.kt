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
 * - [family.brooker.belay.health.HealthReader] reads phone facts and Belay's own health:
 *   [DataCategories.DEVICE_STATUS].
 */
object Collectors {
    val categories: List<DataCategory> = listOf(DataCategories.APPS, DataCategories.DEVICE_STATUS)
}
