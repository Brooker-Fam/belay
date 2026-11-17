package family.brooker.belay.store

import android.content.Context
import family.brooker.belay.calls.CallFlow
import family.brooker.belay.calls.Dialer
import family.brooker.belay.core.AppChange
import family.brooker.belay.core.HandoverPlan
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.Reconcile
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.core.WireRecoveryUse
import family.brooker.belay.core.calls.WireCallsStatus
import family.brooker.belay.core.location.WireLocationStatus
import family.brooker.belay.core.screentime.WireScreenTimeStatus
import family.brooker.belay.settings.Connection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A JSON summary of what the agent keeps: heartbeats and changes (oldest first), the
 * outbox's counts, the connection without the token, (Phase 2) what Belay enforces and which
 * requests it made, without the kid's words, (Phases 6 and 10) the update, the recovery
 * key's tries and use, and the commands' results, (Phase 3) why each app is held and
 * screen time's count and state, (Phase 4) location's report and what it wants, without where the
 * phone is, (Phase 7) whether each request was taken back or seen, (Phase 5) the dialer, the
 * block list Belay keeps and how it decided the last calls, without numbers, and (Phase 11) the
 * hand-over: when the policy asked for it, what Belay did about reset protection, and whether it
 * still holds any of the hand-over's locks. Debug builds write it after every step
 * (DebugTools.afterStep), for android/scripts/ci-emulator-test.sh.
 */
object StateDump {
    fun json(context: Context, store: AgentStore, connection: Connection): String = buildJsonObject {
        put(
            "heartbeats",
            JsonArray(store.recentHeartbeats(Reconcile.MAX_HEARTBEATS).asReversed().map { Json.encodeToJsonElement(Heartbeat.serializer(), it) }),
        )
        put(
            "changes",
            JsonArray(store.recentChanges(Reconcile.MAX_CHANGES).asReversed().map { Json.encodeToJsonElement(AppChange.serializer(), it) }),
        )
        putJsonObject("outbox") { store.countsByState().forEach { (state, count) -> put(state, count) } }
        putJsonObject("connection") {
            put("server", connection.server)
            put("device_id", connection.deviceId)
            put("connected", connection.connected)
            put("disconnected_at", connection.disconnectedAt)
            put("last_sync_at", connection.lastSyncAt)
            put("last_checkin_at", connection.lastCheckinAt)
            put("last_failure", connection.lastFailure)
        }
        val applied = store.applied()
        putJsonObject("enforcement") {
            put("policy_version", store.policy()?.version)
            put("applied_version", applied.policyVersion)
            put("suspended", JsonArray(applied.suspended.sorted().map(::JsonPrimitive)))
            put("hidden", JsonArray(applied.hidden.sorted().map(::JsonPrimitive)))
            put("locks", JsonArray(applied.locks.map { JsonPrimitive(it.name) }))
            put("problems", JsonArray(applied.problems.map(::JsonPrimitive)))
            put("policy_too_large", store.policyTooLarge() != null)
        }
        // Phase 3: why each app is held, and screen time's count (each app's settled minutes
        // since the ledger's start) and state, without the kid's words.
        putJsonObject("reasons") { applied.reasons.forEach { (name, why) -> put(name, JsonArray(why.map(::JsonPrimitive))) } }
        val screenTime = store.screenTime()
        putJsonObject("screen_time") {
            put("on", screenTime != null)
            applied.screenTime?.let { put("status", Json.encodeToJsonElement(WireScreenTimeStatus.serializer(), it)) }
            screenTime?.ledger?.let { ledger ->
                put("counted_from", ledger.log.from)
                put("counted_to", ledger.log.asOf)
                put("access_off", ledger.accessOff)
                putJsonObject("minutes") { ledger.log.apps.forEach { (name, spans) -> put(name, spans.sumOf { it.millis } / 60_000.0) } }
            }
            screenTime?.state?.let { state ->
                put("takes", state.takes.size)
                put("notices_shown", JsonArray(state.shown.keys.sorted().map(::JsonPrimitive)))
                put("locks_done", JsonArray(state.locked.keys.sorted().map(::JsonPrimitive)))
                put("lock_problem", state.lockProblem)
                put("measuring_since", state.uploads.since)
                put("last_upload_at", state.uploads.lastAt)
                put("days_sent_complete", JsonArray(state.uploads.complete.map(::JsonPrimitive)))
            }
            put("usage_waiting", store.pendingUsageCount())
        }
        // Phases 6 and 10: the update, the recovery key (never the key itself) and commands.
        store.agentUpdate()?.let { put("agent_update", Json.encodeToJsonElement(UpdateRecord.serializer(), it)) }
        val recovery = store.recovery()
        putJsonObject("recovery") {
            put("wrong_tries", recovery.wrongTries)
            put("used_versions", JsonArray(recovery.usedVersions.map(::JsonPrimitive)))
            recovery.lastUse?.let { put("last_use", Json.encodeToJsonElement(WireRecoveryUse.serializer(), it)) }
        }
        put("commands", JsonArray(store.commandLog().results.map { Json.encodeToJsonElement(WireCommandResult.serializer(), it) }))
        // Phase 7: when a parent saw each help request, from the policy's help_seen.
        val seen = store.policy()?.helpSeen.orEmpty().groupBy { it.requestId }.mapValues { (_, all) -> all.minOf { it.at } }
        put(
            "requests",
            JsonArray(
                store.requests().map {
                    buildJsonObject {
                        put("id", it.id)
                        put("kind", it.kind.name.lowercase())
                        put("package", it.packageName)
                        put("revision", it.revision)
                        put("has_reason", it.reason != null)
                        put("withdrawn_at", it.withdrawnAt)
                        put("has_location", it.location != null)
                        put("seen_at", seen[it.id])
                    }
                },
            ),
        )
        // Phase 11: the hand-over the policy asks for, and as Belay carried it out. A debug build never
        // touches reset protection: "skipped_debug" says it left it alone where a release build clears it.
        putJsonObject("handover") {
            put("at", store.policy()?.handover?.at)
            put("done_for", applied.handover?.at)
            put("done_at", applied.handover?.doneAt)
            put("frp", applied.handover?.frp?.name?.lowercase())
            put("frp_held", applied.frpAccounts != null)
            put("locks_held", JsonArray(applied.locks.filter { it in HandoverPlan.LIFTS }.map { JsonPrimitive(it.name) }))
        }
        // Phase 4: location as the last step left it, without where the phone is.
        val location = store.locationState()
        putJsonObject("location") {
            put("mode", store.policy()?.location?.mode?.name?.lowercase() ?: "off")
            location?.report?.let { put("report", Json.encodeToJsonElement(WireLocationStatus.serializer(), it)) }
            put("wanted", JsonArray(location?.wants.orEmpty().map { JsonPrimitive(it.key) }))
            put("last_fix_at", location?.last?.at)
            put("lost_since", location?.lost?.since)
            put("sharing_for_help", location?.help?.requestId)
            put("turned_on_for", JsonArray(location?.turnedOn.orEmpty().map { JsonPrimitive(it.name.lowercase()) }))
            put("unsent", store.pendingLocationCount())
            put("told", store.told().size)
        }
        // Phase 5: the dialer and how Belay decided the last calls, without anyone's number but the
        // parent's own blocked list, and never when the kid last called 911 or 988.
        putJsonObject("calls") { callsDump(this, store, context) }
    }.toString()

    private fun callsDump(out: JsonObjectBuilder, store: AgentStore, context: Context) {
        val state = store.callsState()
        out.put("on", store.policy()?.calls != null)
        out.put("default_dialer", Dialer.defaultDialer(context))
        out.put("is_dialer", Dialer.isDialer(context))
        out.put("components_enabled", Dialer.componentsEnabled(context))
        out.put("dialer_before", state?.dialerBefore)
        state?.report?.let { out.put("report", Json.encodeToJsonElement(WireCallsStatus.serializer(), it)) }
        out.put("blocked_by_belay", JsonArray(state?.blockedByBelay.orEmpty().sorted().map(::JsonPrimitive)))
        out.put("call_phone_denied", JsonArray(state?.callPhoneDenied.orEmpty().sorted().map(::JsonPrimitive)))
        out.put("ringing", CallFlow.ringing)
        out.put(
            "now",
            JsonArray(
                CallFlow.summary().map { call ->
                    buildJsonObject { call.forEach { (k, v) -> put(k, v) } }
                },
            ),
        )
        out.put(
            "decided",
            JsonArray(
                CallFlow.decisions().map {
                    buildJsonObject {
                        put("at", it.at)
                        put("action", it.action.name.lowercase())
                        put("because", it.because?.name?.lowercase())
                        put("reason", it.reason?.name?.lowercase())
                        put("contact_id", it.contactId)
                        put("rang", it.rang)
                        put("screened", it.screened)
                    }
                },
            ),
        )
        out.put("recent", store.calls().size)
        out.put("unsent", store.pendingCallCount())
    }
}
