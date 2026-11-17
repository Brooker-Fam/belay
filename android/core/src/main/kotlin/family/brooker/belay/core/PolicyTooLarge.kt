package family.brooker.belay.core

/**
 * A policy answer larger than the phone reads (docs/protocol.md, "Versions": up to 1 MB) must
 * never fail silently: Belay keeps enforcing the last policy it could read, reports the problem,
 * counts the check-in as delivered (the server stored the status before it answered), and the
 * long-poll waits longer instead of fetching the same answer again and again.
 */
object PolicyTooLarge {
    /** The largest policy answer (long-poll or check-in) the phone reads. */
    const val MAX_BYTES = 1024L * 1024

    /** After a too-large answer the long-poll waits at least this, growing to [MAX_WAIT_MS]. */
    const val FIRST_WAIT_MS = 5L * 60 * 1000
    const val MAX_WAIT_MS = 60L * 60 * 1000

    /** For enforcement.problems. [bytes]: the answer's Content-Length, when the server sent one. */
    fun problem(bytes: Long?): String {
        val size = if (bytes != null && bytes > MAX_BYTES) "${bytes / 1024 + if (bytes % 1024 == 0L) 0 else 1} KB" else "more than ${MAX_BYTES / 1024} KB"
        return "The rules from the server are too big to read ($size). Belay keeps the last rules it could read."
    }

    /** The long-poll's wait after its [failures]-th failure in a row, the last a too-large answer. */
    fun retryMs(failures: Int, random: Double): Long = OutboxPolicy.backoffMs(failures, random).coerceIn(FIRST_WAIT_MS, MAX_WAIT_MS)
}
