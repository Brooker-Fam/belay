package family.brooker.belay

import android.content.Context
import family.brooker.belay.core.DataCategory
import family.brooker.belay.core.WirePolicy
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Release builds: no way to release device owner from the phone (only a factory reset
 * removes Belay), HTTPS only, no debug state file, only the server's policy, and no debug
 * tests (no archival test, no permission held for one).
 */
object DebugTools {
    const val CAN_RELEASE = false

    val CLEARTEXT_HOSTS: Set<String> = emptySet()

    /** Never set: release builds only enforce the policy from the family's server. */
    val policyOverride: WirePolicy? = null

    /** Release builds send usage only on their own schedule (every 15 minutes while used). */
    fun takeUsageUpload(): Boolean = false

    /** No debug tests, so no permission is held for one. */
    val TESTED_PERMISSIONS: Set<String> = emptySet()

    @Suppress("UNUSED_PARAMETER")
    fun testing(context: Context): Set<String> = emptySet()

    @Suppress("UNUSED_PARAMETER")
    fun noticeLine(context: Context): String? = null

    private val nothingTested: StateFlow<List<DataCategory>> = MutableStateFlow(emptyList())

    @Suppress("UNUSED_PARAMETER")
    fun canSee(context: Context): StateFlow<List<DataCategory>> = nothingTested

    @Suppress("UNUSED_PARAMETER")
    fun releasePhone(context: Context): String = "Not available in release builds."

    @Suppress("UNUSED_PARAMETER")
    fun afterStep(context: Context, dump: () -> String) {}
}
