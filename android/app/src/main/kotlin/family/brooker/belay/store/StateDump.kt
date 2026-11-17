package family.brooker.belay.store

import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.Reconcile
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.WireCommandResult
import family.brooker.belay.core.WireRecoveryUse
import family.brooker.belay.core.screentime.WireScreenTimeStatus
import family.brooker.belay.settings.Connection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A JSON summary of what the agent keeps: heartbeats and changes (oldest first), the
 * outbox's counts, the connection without the token, (Phase 2) what Belay enforces and which
 * requests it made, without the kid's words, (Phases 6 and 10) the update, the recovery
 * key's tries and use, and the commands' results, and (Phase 3) why each app is held and
 * screen time's count and state. Debug builds write it after every step
 * (DebugTools.afterStep), for android/scripts/ci-emulator-test.sh.
 */
object StateDump {
    fun json(store: AgentStore, connection: Connection): String = buildJsonObject {
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
                    }
                },
            ),
        )
    }.toString()
}
