package family.brooker.belay

import android.content.Context
import family.brooker.belay.core.WirePolicy

/**
 * Release builds: no way to release device owner from the phone (only a factory reset
 * removes Belay), HTTPS only, no debug state file, and only the server's policy.
 */
object DebugTools {
    const val CAN_RELEASE = false

    val CLEARTEXT_HOSTS: Set<String> = emptySet()

    /** Never set: release builds only enforce the policy from the family's server. */
    val policyOverride: WirePolicy? = null

    /** Release builds send usage only on their own schedule (every 15 minutes while used). */
    fun takeUsageUpload(): Boolean = false

    @Suppress("UNUSED_PARAMETER")
    fun releasePhone(context: Context): String = "Not available in release builds."

    @Suppress("UNUSED_PARAMETER")
    fun afterStep(context: Context, dump: () -> String) {}
}
