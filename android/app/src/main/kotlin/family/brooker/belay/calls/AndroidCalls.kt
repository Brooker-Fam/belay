package family.brooker.belay.calls

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.telephony.PhoneNumberUtils
import android.telephony.TelephonyManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.calls.AndroidLogCall
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.PhoneNumbers
import family.brooker.belay.core.calls.WireCallDirection
import family.brooker.belay.core.calls.WireCallOutcome
import java.util.Locale

/**
 * What Belay reads from Android about calls, for core's rules (docs/platform-notes.md T2, T3, T7):
 * - Android's emergency numbers: TelephonyManager.isEmergencyNumber needs no permission; it throws
 *   while the phone process is down, which core reads as "Android can't say".
 * - A number as Belay compares it: E.164 from Android's own formatter with the phone's country, so
 *   "5555550123" from the network matches a contact's "+15555550123". An always-allowed number
 *   (911, 988, Android's emergency numbers) is never reformatted.
 * - Android's own call log (READ_CALL_LOG, held only while calls is on), read for three things: a
 *   call to 911 or 988 Belay's dialer didn't see (the callback window), and the calls with
 *   always-allowed or private numbers that Belay's recent calls show while Android still has them
 *   (neither stored nor sent); and, after a restart, the calls that rang in the phone's own app
 *   before the unlock, which Belay keeps and sends like its own, by the same rules (CallsStep,
 *   core's CallRecords.whileLocked).
 */
object AndroidCalls {
    /** Android's emergency numbers, and its E.164 formatter with the phone's country, for core's rules. */
    fun emergencyNumbers(context: Context): EmergencyNumbers {
        val app = context.applicationContext
        val telephony = app.getSystemService(TelephonyManager::class.java)
        return object : EmergencyNumbers {
            override fun isEmergency(number: String): Boolean? {
                if (telephony == null) return null
                return try {
                    telephony.isEmergencyNumber(number)
                } catch (e: RuntimeException) {
                    // IllegalStateException while telephony restarts, UnsupportedOperationException without it.
                    null
                }
            }

            override fun e164(number: String): String? = PhoneNumbers.e164(number) ?: formatE164(app, number)
        }
    }

    /** [dialable] (national) in E.164 by Android's own formatter with the phone's country; null when it can't. */
    private fun formatE164(context: Context, dialable: String): String? {
        val country = country(context) ?: return null
        val formatted = try {
            PhoneNumberUtils.formatNumberToE164(dialable, country)
        } catch (e: RuntimeException) {
            null
        }
        return formatted?.takeIf(PhoneNumbers::isE164)
    }

    /** The phone's country for numbers written nationally (ISO 3166, upper case): the network's, else the SIM's. */
    fun country(context: Context): String? = try {
        val telephony = context.getSystemService(TelephonyManager::class.java)
        listOfNotNull(telephony?.networkCountryIso, telephony?.simCountryIso)
            .map { it.trim().uppercase(Locale.ROOT) }
            .firstOrNull { it.length == 2 }
    } catch (e: RuntimeException) {
        null
    }

    /**
     * [raw] as Belay compares it (core's PhoneNumbers.key), in E.164 when Android can make it so. An
     * always-allowed number (911, 988, Android's emergency numbers) is never reformatted, and a number
     * with `*` or `#` (a caller-id code before it: core's PhoneNumbers.withoutCodes) stays as dialed.
     */
    fun key(context: Context, raw: String?, android: EmergencyNumbers = emergencyNumbers(context)): String? = PhoneNumbers.key(raw, android)

    /** Whether Belay may read Android's call log now (READ_CALL_LOG, granted by policy while calls is on). */
    fun canReadLog(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

    /**
     * Android's call log from [since] (to [until], when given), the newest first, at most [limit]
     * calls; empty without READ_CALL_LOG. After a restart the first read waits until Android has
     * moved in the calls it logged before the unlock (platform notes T22).
     */
    fun log(context: Context, since: Long, limit: Int = 500, until: Long? = null): List<AndroidLogCall> {
        if (!canReadLog(context)) return emptyList()
        val uri = CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, limit.toString()).build()
        val projection = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE, CallLog.Calls.NUMBER_PRESENTATION)
        val selection = "${CallLog.Calls.DATE} >= ?" + if (until != null) " AND ${CallLog.Calls.DATE} <= ?" else ""
        val args = listOfNotNull(since.toString(), until?.toString()).toTypedArray()
        return try {
            context.contentResolver.query(uri, projection, selection, args, "${CallLog.Calls.DATE} DESC")?.use { c ->
                val out = ArrayList<AndroidLogCall>(c.count)
                while (c.moveToNext()) {
                    val type = c.getInt(3)
                    val durationS = c.getLong(2).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
                    out += AndroidLogCall(
                        number = c.getString(0),
                        at = c.getLong(1),
                        direction = when (type) {
                            CallLog.Calls.OUTGOING_TYPE -> WireCallDirection.OUT
                            CallLog.Calls.INCOMING_TYPE, CallLog.Calls.MISSED_TYPE, CallLog.Calls.VOICEMAIL_TYPE,
                            CallLog.Calls.REJECTED_TYPE, CallLog.Calls.BLOCKED_TYPE -> WireCallDirection.IN
                            else -> null
                        },
                        durationS = durationS,
                        blocked = type == CallLog.Calls.BLOCKED_TYPE,
                        // Telecom writes no number for a withheld caller (CallLogUtils.addCall).
                        withheld = c.getInt(4) != CallLog.Calls.PRESENTATION_ALLOWED || c.getString(0).isNullOrBlank(),
                        outcome = when (type) {
                            CallLog.Calls.INCOMING_TYPE -> WireCallOutcome.ANSWERED
                            CallLog.Calls.MISSED_TYPE -> WireCallOutcome.MISSED
                            CallLog.Calls.REJECTED_TYPE -> WireCallOutcome.REJECTED
                            CallLog.Calls.OUTGOING_TYPE -> if (durationS > 0) WireCallOutcome.ANSWERED else WireCallOutcome.MISSED
                            // A voicemail, a blocked call, one answered on another device: never recorded.
                            else -> null
                        },
                    )
                }
                out
            }.orEmpty()
        } catch (e: RuntimeException) {
            // SecurityException if the permission went between the check and the query.
            Log.w(Agent.TAG, "calls: couldn't read Android's call log: ${e.javaClass.simpleName}")
            emptyList()
        }
    }
}
