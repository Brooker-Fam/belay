package family.brooker.belay.core

import kotlin.math.abs

/**
 * Telling one restart of the phone from another: by Settings.Global.BOOT_COUNT when both records
 * have it, else by when the phone started (the clock less the time since boot), which a clock
 * change moves a little.
 */
object Boots {
    /** Two records of a restart whose boot times are this close are the same one, without a boot count. */
    const val SAME_BOOT_MS = 10L * 60 * 1000

    /** Whether the restart [count] and [at] describe is the one [otherCount] and [otherAt] do. */
    fun same(count: Int?, at: Long, otherCount: Int?, otherAt: Long): Boolean =
        if (count != null && otherCount != null) count == otherCount else abs(at - otherAt) < SAME_BOOT_MS
}
