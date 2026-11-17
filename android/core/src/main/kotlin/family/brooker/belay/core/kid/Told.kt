package family.brooker.belay.core.kid

import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.ToldKind

/**
 * Phase 7: "What Belay told your parent", from the phone's own record of what it ran (each
 * `locate_now`, each lost mode, each fix the kid shared with a help request; Phase 5 adds text
 * alerts), so it can't leave one out. Pure.
 */
object Told {
    /** The kid sees the last 30 days (the design's "checks" list). */
    const val KEEP_MS = 30L * 24 * 60 * 60 * 1000

    /** When an entry last told the parent something: a lost mode's last fix, or its own time. */
    fun lastAt(entry: ToldEntry): Long = maxOf(entry.at, entry.lastAt ?: entry.at)

    /** The list the kid sees: the last 30 days, the newest first, each id once (the newest record of it). */
    fun list(entries: List<ToldEntry>, now: Long): List<ToldEntry> =
        entries.groupBy { it.id }.values.map { same -> same.maxBy { lastAt(it) } }
            .filter { now - lastAt(it) <= KEEP_MS }
            .sortedByDescending { lastAt(it) }

    /** Entries older than this are deleted from the phone. */
    fun keepFrom(now: Long): Long = now - KEEP_MS

    /** The checks a parent (or their AI app) asked for in the list, for the Location card's count. */
    fun checks(entries: List<ToldEntry>): List<ToldEntry> = entries.filter { it.kind == ToldKind.CHECK }
}
