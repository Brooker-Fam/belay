package family.brooker.belay

import android.content.Context

/** Release builds: no way to release device owner from the phone. Only a factory reset removes Belay. */
object DebugTools {
    const val CAN_RELEASE = false

    @Suppress("UNUSED_PARAMETER")
    fun releasePhone(context: Context): String = "Not available in release builds."
}
