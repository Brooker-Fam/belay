package family.brooker.belay.location

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.location.LocationManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.CategoryPermissions
import family.brooker.belay.core.KidRequest
import family.brooker.belay.core.Requests
import family.brooker.belay.core.ScreenLocks
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.location.FixReading
import family.brooker.belay.core.location.FixWant
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.LocationState
import family.brooker.belay.core.location.LocationWork
import family.brooker.belay.core.location.LostApplied
import family.brooker.belay.core.location.ToldEntry
import family.brooker.belay.core.location.TurnedOnFor
import family.brooker.belay.core.location.WireFix
import family.brooker.belay.core.location.WireFixReason
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationStatus
import family.brooker.belay.core.location.WirePlaceEvent
import family.brooker.belay.core.screentime.LocalTimes
import family.brooker.belay.enforce.ScreenLock
import family.brooker.belay.service.LocationNotice
import family.brooker.belay.service.ManagedNotice
import family.brooker.belay.store.AgentStore
import family.brooker.belay.ui.KidWords
import java.time.ZoneId
import java.util.UUID

/**
 * Location's part of an agent step (Phase 4), on the agent thread, with core's LocationWork:
 * - records the fixes the collector took since the last step (each want answered once: a fix for
 *   `POST /locations`, a help request's shared fix, a `locate_now`'s result, the kid's list);
 * - starts the `locate_now` commands the step plans (failed at once with plain words outside
 *   on_demand and periodic mode), the periodic fix when it's due, and lost mode's;
 * - keeps location on for `keep_on`, lost mode and a help fix (setLocationEnabled), and turns it
 *   back off when Belay turned it on for lost mode or a help fix that ended;
 * - lost mode: the parent's message on the lock screen (setDeviceOwnerLockScreenInfo) and one
 *   screen lock; both go back when it ends;
 * - starts one attempt (LocationCollector) when Belay wants a fix and can take one, sets the
 *   alarm for the next one, and works out `enforcement.location`.
 * Idempotent: a want is answered once, a lock happens once per lost mode, and nothing is started
 * twice. Revoking a permission restarts Belay, so the agent step does that last
 * ([Done.revoke], DeviceOwnerSetup.revokeUnwanted).
 */
class LocationStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext
    private val dpm = app.getSystemService(DevicePolicyManager::class.java)
    private val lm = app.getSystemService(LocationManager::class.java)

    /** Lost mode's lock waits for a call to end (this step's). */
    private var lockWaits = false

    /** What to store with the step, and do after it. */
    class Done(
        /** Null: nothing to store. */
        val write: AgentStore.LocationWrite?,
        /** The locate_now commands' answers, for the command log. */
        val results: List<WireCommandResult>,
        /** Help requests with their shared fix, sent again. */
        val requests: List<KidRequest>,
        /** Checks a parent asked for that sent a fix: the kid's notices. */
        val checks: List<FixWant>,
        /** A tied permission is held that no longer should be: deny it after the step is stored. */
        val revoke: Boolean,
        val report: WireLocationStatus?,
        val lost: LostApplied?,
        val location: WireLocation?,
        /** Lost mode's one lock is due but waits for a call to end (core's ScreenLocks). */
        val lockWaits: Boolean = false,
    )

    /** [telecomCall]: whether Telecom has a call on (core's ScreenLocks), asked only when lost mode's lock is due (then it waits). */
    fun run(
        policy: WirePolicy,
        commands: List<WireCommand>,
        owner: Boolean,
        requests: List<KidRequest>,
        now: Long,
        telecomCall: () -> Boolean = { false },
    ): Done {
        val location = policy.location
        val before = store.locationState()
        val zone = ZoneId.systemDefault()
        var state = before ?: LocationState()
        val fixes = mutableListOf<WireFix>()
        val events = mutableListOf<WirePlaceEvent>()
        val results = mutableListOf<WireCommandResult>()
        val told = mutableListOf<ToldEntry>()
        val checks = mutableListOf<FixWant>()
        val helpFixes = LinkedHashMap<String, WireFix?>()
        val newId = { UUID.randomUUID().toString() }

        fun record(answered: List<FixWant>, reading: FixReading?, problem: String?) {
            if (answered.isEmpty()) return
            val recorded = LocationWork.record(location, state, answered, reading, problem, now, newId)
            state = recorded.state
            fixes += recorded.fixes
            events += recorded.events
            results += recorded.results
            told += recorded.told
            checks += recorded.checks
            answered.filter { it.reason == WireFixReason.HELP }.forEach { want ->
                want.requestId?.let { helpFixes[it] = recorded.helpFixes[it] }
            }
        }

        // 1. What the collector took since the last step.
        for (result in LocationCollector.takeResults()) {
            record(state.wants.filter { it.key in result.keys }, result.reading, result.problem)
        }
        // 2. Wants left from an attempt that never finished (Belay stopped) are failed if they're old.
        record(LocationWork.stale(state, now, LocationCollector.busy), null, LocationWork.PROBLEM_STOPPED)

        var facts = facts(owner)
        // 3. The parent's checks, then what's due by the clock.
        val commanded = LocationWork.commands(location, commands, facts, now)
        results += commanded.failed
        told += commanded.told
        state = LocationWork.want(location, state, commanded.wants + LocationWork.due(location, state, now, zone), now)

        // 4. A help fix that's done; its grant goes once Belay's screens are closed (revoking restarts Belay).
        state.help?.let { help ->
            val answered = state.wants.none { it.reason == WireFixReason.HELP && it.requestId == help.requestId }
            val next = if (answered) help.copy(done = true) else help
            state = state.copy(help = next.takeUnless { it.done && !Agent.screensVisible })
        }

        if (owner) {
            state = lost(location, state, telecomCall)
            state = locationOn(location, state, facts)
            // Granted at the start of most steps (DeviceOwnerSetup.ensure); here for the ones that skip setup.
            if ((LocationRules.collecting(location) || state.help != null) && !facts.permission) DeviceOwnerSetup.ensure(app)
            facts = facts(owner)
        }

        // 5. One attempt when Belay wants a fix and can take one; otherwise the wants are answered now.
        if (state.wants.isNotEmpty() && !LocationCollector.busy) {
            val problem = when {
                !facts.owner -> LocationWork.PROBLEM_NOT_OWNER
                !facts.permission -> LocationWork.PROBLEM_NO_PERMISSION
                !facts.locationOn -> LocationWork.PROBLEM_LOCATION_OFF
                else -> null
            }
            if (problem != null) {
                Log.w(Agent.TAG, "location: ${state.wants.size} wanted, but $problem")
                record(state.wants, null, problem)
            } else if (LocationCollector.start(app, state.wants.map { it.key }, LocationRules.providers(location))) {
                Log.i(Agent.TAG, "location: taking a fix for ${state.wants.map { it.key }}")
            }
        }

        LocationTimer.schedule(app, LocationWork.nextAt(location, state, now, zone))
        val report = LocationWork.status(location, state, facts)
        state = state.copy(report = report)

        val collecting = LocationRules.collecting(location)
        val empty = state.wants.isEmpty() && state.lost == null && state.help == null && state.turnedOn.isEmpty()
        val keep = if (!collecting && empty) null else state
        val dropUnsent = !collecting && state.help == null && store.pendingLocationCount() > 0
        val changed = keep != before || fixes.isNotEmpty() || events.isNotEmpty() || told.isNotEmpty() || dropUnsent
        val write = if (changed) AgentStore.LocationWrite(keep, fixes, events, told, dropUnsent) else null
        if (dropUnsent) Log.i(Agent.TAG, "location: off, so unsent fixes aren't sent")

        val helpRequests = helpFixes.mapNotNull { (id, fix) -> Requests.withHelpFix(requests, id, fix) }
        val on = CategoryPermissions.categoriesOn(policy, helpFix = keep?.help != null)
        val revoke = owner && DeviceOwnerSetup.unwanted(app, on).isNotEmpty()
        return Done(write, results, helpRequests, checks, revoke, report, keep?.lost, location, lockWaits)
    }

    /** After the step is stored: the kid's notices, and the managed notice's line for periodic mode. */
    fun after(done: Done) {
        val words = KidWords(app) { it }
        val zone = ZoneId.systemDefault()
        fun time(at: Long) = words.time(LocalTimes.local(at, zone).toLocalTime())
        done.checks.forEach { check ->
            val at = done.write?.told?.firstOrNull { it.id == check.commandId }?.at ?: System.currentTimeMillis()
            LocationNotice.checked(app, check.commandId ?: check.key, time(at), check.via)
        }
        val lost = done.lost
        if (lost != null && done.location?.lost != null) LocationNotice.lost(app, lost.lastFixAt?.let(::time)) else LocationNotice.cancelLost(app)
        ManagedNotice.update(app, ManagedNotice.locationLine(app, done.location, words))
    }

    private fun facts(owner: Boolean) = LocationWork.Facts(
        owner = owner,
        permission = DeviceOwnerSetup.hasLocation(app),
        locationOn = runCatching { lm?.isLocationEnabled == true }.getOrDefault(false),
    )

    /** Lost mode as the policy says: the message on the lock screen and one lock, or both taken back. */
    private fun lost(location: WireLocation?, state: LocationState, telecomCall: () -> Boolean): LocationState {
        val lost = location?.lost
        val admin = DeviceOwnerSetup.admin(app)
        if (lost == null) {
            if (state.lost == null) return state
            try {
                dpm.setDeviceOwnerLockScreenInfo(admin, null)
                Log.i(Agent.TAG, "lost mode: off, the lock screen message is gone")
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "lost mode: the lock screen message couldn't be taken back", e)
            }
            return state.copy(lost = null)
        }
        var applied = state.lost?.takeIf { it.since == lost.since } ?: LostApplied(lost.since)
        val message = LocationRules.lostMessage(lost)
        if (applied.message != message) {
            try {
                dpm.setDeviceOwnerLockScreenInfo(admin, message)
                applied = applied.copy(message = message)
                Log.i(Agent.TAG, "lost mode: the parent's message is on the lock screen")
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "lost mode: the lock screen message couldn't be set", e)
            }
        }
        // One lock, once no call Telecom has is on (core's ScreenLocks): during one it waits for a step after it.
        if (!applied.locked && ScreenLocks.lostLockNow(applied, telecomCall())) {
            val problem = ScreenLock.lock(app, owner = true)
            if (problem != null) Log.w(Agent.TAG, "lost mode: $problem")
            applied = applied.copy(locked = true)
        } else if (!applied.locked) {
            Log.i(Agent.TAG, "screen lock waits for a call to end")
            lockWaits = true
        }
        return state.copy(lost = applied)
    }

    /**
     * Location on for keep_on, lost mode and a help fix in progress; off again when Belay turned it
     * on for lost mode or a help fix and neither needs it now (nor keep_on).
     */
    private fun locationOn(location: WireLocation?, state: LocationState, facts: LocationWork.Facts): LocationState {
        val admin = DeviceOwnerSetup.admin(app)
        val helping = state.wants.any { it.reason == WireFixReason.HELP }
        val needed = buildSet {
            if (location?.lost != null) add(TurnedOnFor.LOST)
            if (helping) add(TurnedOnFor.HELP)
        }
        var turnedOn = state.turnedOn.filterTo(HashSet()) { it in needed }
        val keepOn = LocationRules.keepOn(location)
        if (!facts.locationOn && (keepOn || needed.isNotEmpty())) {
            try {
                dpm.setLocationEnabled(admin, true)
                Log.i(Agent.TAG, "location: turned on (${if (keepOn) "keep_on" else needed.joinToString { it.name.lowercase() }})")
                if (!keepOn) turnedOn += needed
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "location: couldn't turn location on", e)
            }
        }
        val released = state.turnedOn - turnedOn
        if (released.isNotEmpty() && turnedOn.isEmpty() && !keepOn && facts.locationOn) {
            try {
                dpm.setLocationEnabled(admin, false)
                Log.i(Agent.TAG, "location: turned back off, as it was before ${released.joinToString { it.name.lowercase() }}")
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "location: couldn't turn location back off", e)
            }
        }
        return state.copy(turnedOn = turnedOn)
    }
}
