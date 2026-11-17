package family.brooker.belay.store

import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.Reconcile
import family.brooker.belay.settings.Connection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A JSON summary of what the agent keeps: heartbeats and changes (oldest first), the
 * outbox's counts, and the connection, without the token. Debug builds write it after
 * every step (DebugTools.afterStep), for android/scripts/ci-emulator-test.sh.
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
    }.toString()
}
