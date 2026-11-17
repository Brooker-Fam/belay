package family.brooker.belay.enroll

import android.content.Context
import family.brooker.belay.DebugTools
import family.brooker.belay.core.EnrollProblem
import family.brooker.belay.core.Enrollment
import family.brooker.belay.sync.Sync
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI

/** The enrollment screen's progress, kept for the process so it survives the screen being recreated. */
object EnrollFlow {
    sealed interface State {
        data object Idle : State
        data class Working(val host: String) : State
        data class Done(val host: String, val deviceName: String) : State
        data class Failed(val problem: EnrollProblem) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    fun start(context: Context, server: String, code: String) {
        if (_state.value is State.Working) return
        val host = Enrollment.normalizeServer(server, DebugTools.CLEARTEXT_HOSTS)
            ?.let { runCatching { URI(it).host }.getOrNull() } ?: server.trim()
        _state.value = State.Working(host)
        Sync.enroll(context, server, code, replace = false) { outcome ->
            _state.value = when (outcome) {
                is Enroller.Outcome.Enrolled -> State.Done(outcome.host, outcome.deviceName)
                is Enroller.Outcome.Failed -> State.Failed(outcome.problem)
            }
        }
    }

    /** Back to the start, unless an enrollment is still running. */
    fun reset() {
        if (_state.value !is State.Working) _state.value = State.Idle
    }
}
