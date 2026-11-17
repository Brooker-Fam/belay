package family.brooker.belay.store

import family.brooker.belay.core.AppChange
import family.brooker.belay.core.Heartbeat
import family.brooker.belay.core.Reconcile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A JSON summary of what the agent keeps: heartbeats and changes (oldest first) and the
 * outbox's counts. Debug builds write it after every step (DebugTools.afterStep), for
 * android/scripts/ci-emulator-test.sh.
 */
object StateDump {
    fun json(store: AgentStore): String = buildJsonObject {
        put(
            "heartbeats",
            JsonArray(store.recentHeartbeats(Reconcile.MAX_HEARTBEATS).asReversed().map { Json.encodeToJsonElement(Heartbeat.serializer(), it) }),
        )
        put(
            "changes",
            JsonArray(store.recentChanges(Reconcile.MAX_CHANGES).asReversed().map { Json.encodeToJsonElement(AppChange.serializer(), it) }),
        )
        putJsonObject("outbox") { store.countsByState().forEach { (state, count) -> put(state, count) } }
    }.toString()
}
