package family.brooker.belay.store

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.AgentState
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileNotFoundException

/**
 * Phase 0 keeps its state in one JSON file in no-backup storage (Phase 1 moves the
 * outbox and the last snapshot to Room). Only the agent thread reads and writes it.
 */
class StateStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "agent-state.json"))

    fun load(): AgentState = try {
        json.decodeFromString(AgentState.serializer(), file.readFully().decodeToString())
    } catch (e: FileNotFoundException) {
        AgentState()
    } catch (e: Exception) {
        // Unreadable (an older format, a torn write): start again. The next full scan is a
        // new baseline, and the heartbeat log says so.
        Log.e(Agent.TAG, "state unreadable, starting over", e)
        AgentState()
    }

    fun save(state: AgentState) {
        val out = file.startWrite()
        try {
            out.write(json.encodeToString(AgentState.serializer(), state).encodeToByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
