package family.brooker.belay.core.screentime

import java.time.LocalDateTime
import java.time.ZoneId

/** Made-up apps and a family in New York (public-repo hygiene: no real device data). */
object Fx {
    val NY: ZoneId = ZoneId.of("America/New_York")
    val LA: ZoneId = ZoneId.of("America/Los_Angeles")
    const val SEC = 1000L
    const val MIN = 60 * SEC
    const val HOUR = 60 * MIN

    const val BLOCKS = "com.example.blocks"
    const val RACER = "com.example.racer"
    const val VIDEO = "com.example.video"
    const val CHAT = "com.example.chat"
    const val MATH = "com.example.math"
    const val HOMEWORK = "com.example.homework"
    const val CLOCK = "com.example.clock"
    const val LAUNCHER = "com.example.launcher"
    const val DIALER = "com.example.dialer"
    const val BELAY = "family.brooker.belay"

    /** A local time in [zone]; in an overlap, the first of the two. */
    fun at(local: String, zone: ZoneId = NY): Long =
        LocalDateTime.parse(local).atZone(zone).toInstant().toEpochMilli()

    /** A local time in [zone]; in an overlap, the second of the two. */
    fun atLater(local: String, zone: ZoneId = NY): Long =
        LocalDateTime.parse(local).atZone(zone).withLaterOffsetAtOverlap().toInstant().toEpochMilli()
}
