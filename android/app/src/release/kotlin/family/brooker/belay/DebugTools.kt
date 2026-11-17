package family.brooker.belay

import android.content.Context

/**
 * Release builds: no way to release device owner from the phone (only a factory reset
 * removes Belay), and no debug state file.
 */
object DebugTools {
    const val CAN_RELEASE = false

    @Suppress("UNUSED_PARAMETER")
    fun releasePhone(context: Context): String = "Not available in release builds."

    @Suppress("UNUSED_PARAMETER")
    fun afterStep(context: Context, dump: () -> String) {}
}
