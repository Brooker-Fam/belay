package family.brooker.belay.core.location

import family.brooker.belay.core.CommandLog
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandOutcome
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.kid.Caregivers
import java.time.ZoneId

/**
 * Location's part of an agent step, as pure functions (Phase 4): which fixes Belay wants now (a
 * parent's `locate_now`, periodic mode, lost mode), what a finished fix makes (a fix for each want,
 * place events, the commands' results, the kid's list), when the next one is due, and the report.
 * The app takes the fixes (`LocationManager.getCurrentLocation`, never a stream) and stores what
 * this returns in one transaction.
 */
object LocationWork {
    /** A want that waited this long with no attempt running (Belay stopped mid-check) is failed. */
    const val STALE_MS = 5 * LocationSchedule.MINUTE_MS

    /** What only the phone can tell, read at the step. */
    data class Facts(
        val owner: Boolean,
        /** Belay holds ACCESS_FINE_LOCATION now. */
        val permission: Boolean,
        /** The phone's location setting is on. */
        val locationOn: Boolean,
    )

    // Belay's own words for the parent (enforcement.location.problem and the commands' results).
    const val PROBLEM_MODE_OFF = "Location is off for this phone in Belay, so it didn't check where the phone is."
    const val PROBLEM_LOCATION_OFF = "Location is turned off in the phone's settings, so Belay can't find where it is."
    const val PROBLEM_NO_PERMISSION = "Android didn't let Belay use location."
    const val PROBLEM_NOT_OWNER = "Belay isn't the device owner, so it can't use location."
    const val PROBLEM_NO_GPS_FIX = "No GPS fix in 60 seconds."
    const val PROBLEM_NO_FIX = "No fix from GPS or Android's combined location in 60 seconds."
    const val PROBLEM_NO_FUSED_FIX = "No fix from Android's combined location in 60 seconds."
    const val PROBLEM_STOPPED = "Belay stopped before it could finish this check."

    /** The `locate_now` commands to run now: each a want, or failed at once with plain words. */
    data class Commanded(val wants: List<FixWant>, val failed: List<WireCommandResult>, val told: List<ToldEntry>)

    fun commands(location: WireLocation?, commands: List<WireCommand>, facts: Facts, now: Long): Commanded {
        val wants = mutableListOf<FixWant>()
        val failed = mutableListOf<WireCommandResult>()
        val told = mutableListOf<ToldEntry>()
        for (command in commands.filter { it.kind == WireCommand.LOCATE_NOW }.distinctBy { it.id }) {
            val via = via(command.via)
            // Phase 12: a caregiver's check names them for the kid; never alongside an AI app's name.
            val caregiver = if (via == null) Caregivers.who(command.caregiver) else null
            val problem = when {
                !LocationRules.canLocateNow(location) -> PROBLEM_MODE_OFF
                !facts.owner -> PROBLEM_NOT_OWNER
                else -> null
            }
            if (problem == null) {
                wants += FixWant(WireFixReason.ON_DEMAND, now, commandId = command.id, via = via, caregiver = caregiver)
            } else {
                failed += CommandLog.failed(command, now, problem)
                told += ToldEntry(command.id, ToldKind.CHECK, now, via, sent = false, problem = problem, caregiver = caregiver)
            }
        }
        return Commanded(wants, failed, told)
    }

    /** The AI app's name for the kid's notice: one line, at most 60 characters, or null. */
    fun via(name: String?): String? =
        name?.replace(Regex("\\s+"), " ")?.trim()?.take(MAX_VIA)?.takeIf { it.isNotEmpty() }

    const val MAX_VIA = 60

    /** The wants due now by the clock: periodic (or for a place's edge) within hours, and lost mode. */
    fun due(location: WireLocation?, state: LocationState, now: Long, zone: ZoneId): List<FixWant> = listOfNotNull(
        LocationSchedule.nextPeriodic(location, state.periodicTriedAt, state.last, now, zone)
            ?.takeIf { it.at <= now }?.let { FixWant(it.reason, now) },
        LocationSchedule.nextLost(location, state.lostTriedAt, now)?.takeIf { it <= now }?.let { FixWant(WireFixReason.LOST, now) },
    )

    /**
     * [state] with [wants] added, each key once (the first stays), and the ones that no longer
     * apply dropped: periodic ones outside periodic mode, lost mode's outside lost mode. When a
     * periodic or lost want is added, its try counts as now, so it isn't due again for a while.
     */
    fun want(location: WireLocation?, state: LocationState, wants: List<FixWant>, now: Long): LocationState {
        val keys = state.wants.mapTo(HashSet()) { it.key }
        val added = wants.filter { keys.add(it.key) }
        val all = (state.wants + added).filter { applies(location, it) }
        return state.copy(
            wants = all,
            periodicTriedAt = if (added.any { it.key == "periodic" }) now else state.periodicTriedAt,
            lostTriedAt = if (added.any { it.reason == WireFixReason.LOST }) now else state.lostTriedAt,
        )
    }

    private fun applies(location: WireLocation?, want: FixWant): Boolean = when (want.reason) {
        WireFixReason.PERIODIC, WireFixReason.PLACE -> LocationRules.periodic(location)
        WireFixReason.LOST -> location?.lost != null
        // A check a parent asked for, or the kid's help fix, is answered even if the mode changed meanwhile.
        WireFixReason.ON_DEMAND, WireFixReason.HELP -> true
    }

    /** When the next fix is due by the clock (the alarm): periodic or lost mode, whichever is sooner. */
    fun nextAt(location: WireLocation?, state: LocationState, now: Long, zone: ZoneId): Long? = listOfNotNull(
        LocationSchedule.nextPeriodic(location, state.periodicTriedAt, state.last, now, zone)?.at,
        LocationSchedule.nextLost(location, state.lostTriedAt, now),
    ).minOrNull()

    /** What an attempt's end makes, to store in one transaction. */
    data class Recorded(
        val state: LocationState,
        /** For `POST /api/v1/locations`, oldest first: not a help fix, which goes in its request. */
        val fixes: List<WireFix>,
        /** A help request's shared fix, by the request's id. */
        val helpFixes: Map<String, WireFix>,
        val events: List<WirePlaceEvent>,
        /** The locate_now commands' answers. */
        val results: List<WireCommandResult>,
        /** Lines of "What Belay told your parent", new or updated (by id). */
        val told: List<ToldEntry>,
        /** The checks a parent asked for that sent a fix, for the kid's notice: the AI app's or (Phase 12) the caregiver's name, or neither. */
        val checks: List<FixWant>,
    )

    /**
     * An attempt for [answered] ended at [now], with [reading] (null: no fix, because of
     * [problem]). Each want gets its own fix (a new id, the same reading, its own reason and
     * command); places are evaluated once, in periodic mode, from a fix that's sent (not a mock,
     * not only a help fix); each locate_now is answered done or failed; lost mode's line counts
     * its fixes. Coordinates are rounded to 5 decimals here, so nothing more precise leaves.
     */
    fun record(
        location: WireLocation?,
        state: LocationState,
        answered: List<FixWant>,
        reading: FixReading?,
        problem: String?,
        now: Long,
        newId: () -> String,
    ): Recorded {
        val keys = answered.mapTo(HashSet()) { it.key }
        val wanted = state.wants.filter { it.key in keys }
        var next = state.copy(wants = state.wants.filter { it.key !in keys })
        val fixes = mutableListOf<WireFix>()
        val helpFixes = LinkedHashMap<String, WireFix>()
        val results = mutableListOf<WireCommandResult>()
        val told = mutableListOf<ToldEntry>()
        val checks = mutableListOf<FixWant>()
        var events = emptyList<WirePlaceEvent>()
        val why = problem ?: PROBLEM_NO_FIX

        for (want in wanted) {
            val fix = reading?.let {
                WireFix(
                    id = newId(),
                    at = it.at,
                    lat = Geo.latitude(it.lat),
                    lng = Geo.longitude(it.lng),
                    accuracyM = it.accuracyM.coerceIn(0, MAX_ACCURACY_M),
                    provider = it.provider,
                    reason = want.reason,
                    commandId = want.commandId,
                    mock = it.mock,
                )
            }
            when (want.reason) {
                WireFixReason.HELP -> {
                    if (fix != null && want.requestId != null) helpFixes[want.requestId] = fix
                    told += ToldEntry("help:${want.requestId}", ToldKind.HELP, fix?.at ?: now, sent = fix != null, problem = if (fix == null) why else null)
                }
                WireFixReason.ON_DEMAND -> {
                    fix?.let { fixes += it }
                    val commandId = want.commandId
                    if (commandId != null) {
                        results += WireCommandResult(
                            commandId,
                            if (fix != null) WireCommandOutcome.DONE else WireCommandOutcome.FAILED,
                            now,
                            if (fix != null) null else why.take(WireLimits.MAX_PROBLEM),
                        )
                        told += ToldEntry(
                            commandId,
                            ToldKind.CHECK,
                            fix?.at ?: now,
                            want.via,
                            sent = fix != null,
                            problem = if (fix == null) why else null,
                            caregiver = want.caregiver,
                        )
                        if (fix != null) checks += want
                    }
                }
                WireFixReason.LOST -> {
                    fix?.let { fixes += it }
                    val lost = next.lost
                    if (lost != null && fix != null) {
                        val updated = lost.copy(fixes = lost.fixes + 1, lastFixAt = fix.at)
                        next = next.copy(lost = updated)
                        told += ToldEntry("lost:${lost.since}", ToldKind.LOST, lost.since, sent = true, count = updated.fixes, lastAt = fix.at)
                    }
                }
                WireFixReason.PERIODIC, WireFixReason.PLACE -> fix?.let { fixes += it }
            }
        }

        // Every fix of one reading has the same place and time; the first one sent stands for them.
        val sent = fixes.firstOrNull()
        if (sent != null) {
            val seen = PlaceFix(sent.id, sent.at, sent.lat, sent.lng, sent.accuracyM, sent.mock)
            val places = LocationRules.places(location)
            if (places.isNotEmpty() && !seen.mock) {
                val outcome = Places.evaluate(places, next.places, seen, newId)
                next = next.copy(places = outcome.tracks)
                events = outcome.events
            }
            next = next.copy(last = seen)
        }
        if (!LocationRules.periodic(location)) next = next.copy(places = emptyMap())
        next = next.copy(problem = if (reading != null) null else why)
        return Recorded(next, fixes, helpFixes, events, results, told, checks)
    }

    /** The largest accuracy the server takes, in meters. */
    const val MAX_ACCURACY_M = 100_000

    /**
     * Wants that waited longer than twice [STALE_MS] while no attempt runs ([busy] false): Belay
     * stopped before it finished them more than once (its process died). The caller fails them with
     * [PROBLEM_STOPPED]; younger ones are simply tried again.
     */
    fun stale(state: LocationState, now: Long, busy: Boolean): List<FixWant> =
        if (busy) emptyList() else state.wants.filter { now - it.since > 2 * STALE_MS }

    /**
     * `enforcement.location`, null while location is off (mode off and not lost): whether Belay
     * holds the permission, whether the phone's location is on, the last fix's time, and what
     * failed: no permission, location turned off (the kid can, without keep_on), or the last fix's
     * problem.
     */
    fun status(location: WireLocation?, state: LocationState, facts: Facts): WireLocationStatus? {
        if (!LocationRules.collecting(location)) return null
        val problem = when {
            !facts.owner -> PROBLEM_NOT_OWNER
            !facts.permission -> PROBLEM_NO_PERMISSION
            !facts.locationOn -> PROBLEM_LOCATION_OFF
            else -> state.problem
        }
        return WireLocationStatus(facts.permission, facts.locationOn, state.last?.at, problem?.take(WireLimits.MAX_PROBLEM))
    }
}
