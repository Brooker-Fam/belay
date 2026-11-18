package family.brooker.belay.enroll

import android.content.Context
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.Trigger
import family.brooker.belay.core.EnrollProblem
import family.brooker.belay.core.EnrollRequest
import family.brooker.belay.core.Enrollment
import family.brooker.belay.core.RecoveryRules
import family.brooker.belay.core.SyncPolicy
import family.brooker.belay.health.DeviceStatus
import family.brooker.belay.health.HealthReader
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.settings.TokenVault
import family.brooker.belay.store.AgentStore
import family.brooker.belay.sync.DeviceApi
import family.brooker.belay.sync.SyncWork
import java.net.URI
import java.security.GeneralSecurityException

/**
 * Enrollment, however the server and code arrived (scanned, typed, or from provision.sh):
 * `POST /api/v1/enroll`, then the result is stored, and a check-in and a full inventory
 * follow at once. Runs on the sync thread ([family.brooker.belay.sync.Sync.enroll]).
 */
class Enroller(private val app: Context) {
    sealed interface Outcome {
        data class Enrolled(val host: String, val deviceName: String) : Outcome

        /** [detail] is the server's own words, if any: for provision.sh and the log. */
        data class Failed(val problem: EnrollProblem, val detail: String? = null) : Outcome
    }

    /**
     * [replace]: a phone that's connected may move to another server (only provision.sh's receiver
     * asks); even then, not while Belay holds the debugging lock, unless a parent opened repair
     * access (core's Enrollment.receiverMayReplace).
     */
    fun enroll(typedServer: String, typedCode: String, replace: Boolean): Outcome {
        val server = Enrollment.normalizeServer(typedServer, DebugTools.CLEARTEXT_HOSTS)
            ?: return Outcome.Failed(EnrollProblem.BAD_SERVER)
        val code = Enrollment.normalizeCode(typedCode) ?: return Outcome.Failed(EnrollProblem.BAD_CODE)
        val connected = ConnectionStore.read(app).connected
        if (!replace && connected) return Outcome.Failed(EnrollProblem.ALREADY_CONNECTED)
        if (connected && !mayReplace()) {
            Log.w(Agent.TAG, "enroll: refused to move a connected phone while the debugging lock is on")
            return Outcome.Failed(EnrollProblem.LOCKED)
        }
        val host = URI(server).host
        val device = DeviceStatus.read(app, HealthReader(app).read())
        val outcome = when (val answer = DeviceApi(server).enroll(EnrollRequest(code, device))) {
            is DeviceApi.Answer.Ok -> {
                val body = answer.body
                if (!TOKEN.matches(body.token) || body.deviceId.isBlank()) {
                    Outcome.Failed(EnrollProblem.NOT_BELAY, "the answer had no usable token")
                } else {
                    try {
                        ConnectionStore.enrolled(
                            app,
                            server = server,
                            deviceId = body.deviceId,
                            deviceName = body.deviceName.take(MAX_NAME),
                            sealedToken = TokenVault.encrypt(body.token),
                            at = answer.receivedAt,
                            clockSkewMs = SyncPolicy.clockSkewMs(body.serverTime, answer.sentAt, answer.receivedAt),
                        )
                        Outcome.Enrolled(host, body.deviceName.take(MAX_NAME))
                    } catch (e: GeneralSecurityException) {
                        Log.e(Agent.TAG, "enroll: Keystore refused", e)
                        Outcome.Failed(EnrollProblem.PHONE_ERROR, "this phone couldn't store the token safely")
                    }
                }
            }
            is DeviceApi.Answer.Refused ->
                Outcome.Failed(Enrollment.problemFor(answer.status, answer.error?.error), answer.error?.description?.take(MAX_DETAIL))
            is DeviceApi.Answer.Failed ->
                Outcome.Failed(if (answer.answered) EnrollProblem.NOT_BELAY else EnrollProblem.UNREACHABLE, answer.reason)
        }
        when (outcome) {
            is Outcome.Enrolled -> {
                Log.i(Agent.TAG, "enrolled with $host")
                // Whatever waited (from before, or for a server that removed this phone) goes now.
                AgentStore.get(app).makePendingDue()
                SyncWork.scheduleCheckins(app)
                // A full scan and inventory, then a check-in (Trigger.ENROLLED).
                Agent.handle(app, Trigger.ENROLLED)
            }
            is Outcome.Failed -> Log.w(Agent.TAG, "enroll with $host failed: ${outcome.problem.code}")
        }
        return outcome
    }

    /** What Belay holds now and the repair access open now, for core's Enrollment.receiverMayReplace. */
    private fun mayReplace(): Boolean {
        val store = AgentStore.get(app)
        val now = System.currentTimeMillis()
        val policy = DebugTools.policyOverride ?: store.policy()
        return Enrollment.receiverMayReplace(
            connected = true,
            held = store.applied().locks,
            maintenanceUntil = policy?.maintenanceUntil,
            recoveryUntil = RecoveryRules.openUntil(store.recovery(), now),
            now = now,
        )
    }

    private companion object {
        /** 256 random bits, base64url (docs/protocol.md); anything else can't go in a header. */
        val TOKEN = Regex("[A-Za-z0-9_-]{32,256}")
        const val MAX_NAME = 100
        const val MAX_DETAIL = 200
    }
}
