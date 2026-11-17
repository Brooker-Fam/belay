package family.brooker.belay.core

/**
 * The check-in's size. The server takes at most 64 KB (docs/protocol.md; servers before Phase 3
 * took 32 KB), and refuses anything larger, so a check-in that grew too big would be refused every
 * time and the phone would look silent. Every list in it is capped already; with every cap reached
 * and long names it comes to about 28 KB (CheckinSizeTest), and a busy phone sends far less. This
 * is the last guard, and its target fits the older servers too.
 */
object Checkins {
    /** The smallest limit a server has had for `POST /api/v1/checkin` (64 KB since Phase 3). */
    const val MAX_BYTES = 32 * 1024

    /** Belay keeps its check-ins under this. */
    const val TARGET_BYTES = 30 * 1024

    fun bytes(request: CheckinRequest): Int = Wire.json.encodeToString(CheckinRequest.serializer(), request).encodeToByteArray().size

    /**
     * A check-in with [device], under [TARGET_BYTES]: when it's larger, what matters least goes
     * first, one step at a time: the tail of the never-blocked list (the phone refuses to block
     * those anyway), long words in the commands' results, half the problems, older self-serve
     * takes, then the rest of the never-blocked list.
     */
    fun fit(device: WireDevice, target: Int = TARGET_BYTES): CheckinRequest {
        var request = CheckinRequest(device)
        if (bytes(request) <= target) return request
        val steps = listOf<(WireEnforcement) -> WireEnforcement>(
            { it.copy(neverBlocked = it.neverBlocked.take(WireLimits.MAX_NEVER_BLOCKED / 2)) },
            { it.copy(commands = it.commands.map { c -> c.copy(problem = c.problem?.take(80)) }) },
            { it.copy(problems = it.problems.take(WireLimits.MAX_PROBLEMS / 2)) },
            { e -> e.copy(screenTime = e.screenTime?.let { it.copy(selfServe = it.selfServe.takeLast(5)) }) },
            { it.copy(neverBlocked = emptyList()) },
        )
        for (step in steps) {
            val enforcement = request.status.enforcement ?: break
            request = CheckinRequest(request.status.copy(enforcement = step(enforcement)))
            if (bytes(request) <= target) break
        }
        return request
    }
}
