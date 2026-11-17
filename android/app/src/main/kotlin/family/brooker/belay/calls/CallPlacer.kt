package family.brooker.belay.calls

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.TelecomManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.calls.OutgoingDecision
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Every call Belay starts (its dial pad, contacts, recent calls, and the 911 and 988 buttons) goes
 * through TelecomManager.placeCall (docs/platform-notes.md T2): Telecom hands an emergency call to
 * the preloaded dialer by itself, and lets the default dialer place one whatever its permissions.
 * The outgoing rule (core's CallRules.outgoing) is checked first; a call to 911, an emergency number
 * or 988 opens the 2-hour window in which every caller rings, before it's placed. If placeCall
 * fails, the number opens in the preloaded dialer instead, where the kid taps Call.
 */
object CallPlacer {
    sealed interface Result {
        data object Placed : Result

        /** Not allowed by the family's rules; [decision] says whether it's a contact without calls. */
        data class NotAllowed(val decision: OutgoingDecision) : Result

        /** Nothing could place it; the kid was shown the preloaded dialer if there is one. */
        data object Failed : Result
    }

    private data class Placement(val at: Long, val decision: OutgoingDecision)

    /** Calls Belay placed in the last moments, by number, so onCallAdded knows them (CallFlow). */
    private val placed = ConcurrentHashMap<String, Placement>()
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-dial") }
    private val main = Handler(Looper.getMainLooper())

    /** The decision Belay already made for a call it placed to [key] in the last 30 seconds, if any. */
    fun placedRecently(key: String?, now: Long): OutgoingDecision? {
        placed.entries.removeIf { now - it.value.at > RECENT_MS || it.value.at > now }
        return key?.let { placed[it]?.decision }
    }

    /** Places a call to [raw] (as typed or from a contact); [done] gets the result on the main thread. */
    fun place(context: Context, raw: String, done: (Result) -> Unit = {}) {
        val app = context.applicationContext
        worker.execute {
            val result = try {
                placeNow(app, raw)
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "calls: couldn't place a call", e)
                openInPreloadedDialer(app, raw)
                Result.Failed
            }
            main.post { done(result) }
        }
    }

    private fun placeNow(app: Context, raw: String): Result {
        val now = System.currentTimeMillis()
        val android = AndroidCalls.emergencyNumbers(app)
        val key = AndroidCalls.key(app, raw, android) ?: return Result.Failed
        val decision = CallsGate.outgoing(app, key, now)
        if (!decision.allowed) {
            Log.i(Agent.TAG, "calls: not placed, the family's rules don't allow that number")
            return Result.NotAllowed(decision)
        }
        if (decision.alwaysAllowed != null) CallsGate.emergencyContact(app, now)
        placed[key] = Placement(now, decision)
        if (placeCall(app, key)) return Result.Placed
        openInPreloadedDialer(app, key)
        return Result.Failed
    }

    /**
     * The default dialer may place any call to an emergency number even without CALL_PHONE (Telecom's
     * canCallPhone); every other call needs CALL_PHONE, which Belay holds by policy while calls is on.
     */
    @SuppressLint("MissingPermission")
    private fun placeCall(app: Context, number: String): Boolean {
        val telecom = app.getSystemService(TelecomManager::class.java) ?: return false
        if (app.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED && !Dialer.isDialer(app)) {
            Log.w(Agent.TAG, "calls: Belay may not place calls right now")
            return false
        }
        return try {
            telecom.placeCall(Uri.fromParts("tel", number, null), Bundle())
            Log.i(Agent.TAG, "calls: placed a call")
            true
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "calls: Android refused to place the call", e)
            false
        }
    }

    /** The number in the preloaded dialer (ACTION_DIAL needs no permission), so the kid can tap Call there. */
    fun openInPreloadedDialer(context: Context, number: String): Boolean {
        val intent = Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val preloaded = Dialer.systemDialer(context)?.takeIf { it != context.packageName }
        for (candidate in listOfNotNull(preloaded?.let { Intent(intent).setPackage(it) }, intent.takeIf { preloaded == null })) {
            try {
                context.startActivity(candidate)
                return true
            } catch (e: ActivityNotFoundException) {
                Log.w(Agent.TAG, "calls: no dialer takes ACTION_DIAL")
            } catch (e: SecurityException) {
                Log.w(Agent.TAG, "calls: ACTION_DIAL refused", e)
            }
        }
        return false
    }

    private const val RECENT_MS = 30_000L
}
