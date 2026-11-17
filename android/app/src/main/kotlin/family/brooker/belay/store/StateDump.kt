package family.brooker.belay.store

import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.Reconcile
import family.brooker.belay.settings.Connection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A JSON summary of what the agent keeps: heartbeats and changes (oldest first), the
 * outbox's counts, the connection without the token, and (Phase 2) what Belay enforces and
 * which requests it made, without the kid's words. Debug builds write it after every step
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
        }
        put(
            "requests",
            JsonArray(
                store.requests().map {
                    buildJsonObject {
                        put("id", it.id)
                        put("package", it.packageName)
                        put("revision", it.revision)
                        put("has_reason", it.reason != null)
                    }
                },
            ),
        )
    }.toString()
}
