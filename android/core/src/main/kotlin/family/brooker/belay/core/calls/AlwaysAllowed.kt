package family.brooker.belay.core.calls

/**
 * What the phone's Android says about emergency numbers (TelephonyManager.isEmergencyNumber: the
 * SIM's, the network's, the modem's and Android's own list for the country), and how it writes a
 * number in E.164. A seam, so the rules can be tested on the JVM.
 */
fun interface EmergencyNumbers {
    /** True or false; null when Android can't say (telephony isn't running, or the phone has none). */
    fun isEmergency(number: String): Boolean?

    /**
     * [number] (dialable, as the kid may type it) in E.164 for the phone's country, as Android's
     * formatter writes it (PhoneNumberUtils.formatNumberToE164); null when it can't be. Without
     * the phone, only a number already written in E.164.
     */
    fun e164(number: String): String? = PhoneNumbers.e164(number)
}

/** Why a number always works: an emergency number (911 and Android's own), or 988. */
enum class AlwaysAllowedKind { EMERGENCY, CRISIS_988 }

/**
 * The numbers that always work whatever the policy says (docs/protocol.md, "Calls rules"): 911,
 * every number Android reports as an emergency number, and 988. The kid can always call them, in
 * every mode, stage, pause, schedule and quiet time, also with a caller-id code dialed before
 * them ("*67 988", [dialed]). A call from 911 or an emergency number always rings, unless the
 * network's check of the caller id failed (CallRules). They're decided here, in code, never from
 * the policy, so no policy or server bug can remove them; calls with them are never recorded or
 * sent (CallRecords).
 *
 * 988 is an ordinary number to Android (platform notes T3), so it's here by name, with the
 * Lifeline's older number (1-800-273-8255), which still reaches it; the server treats that one as
 * 988 too (never blocked, never recorded). When Android
 * can't say whether a number is an emergency number, Belay uses Android's own list for a phone
 * with no SIM (AOSP's EmergencyNumberTracker: 112, 911, 000, 08, 110, 118, 119 and 999), so a
 * broken telephony service never makes an emergency number stop working.
 */
object AlwaysAllowed {
    const val EMERGENCY_911 = "911"
    const val CRISIS_988 = "988"

    /** The 988 Lifeline's older number, 1-800-273-8255 ("TALK"), which still reaches it: it counts as 988. */
    const val LIFELINE_800 = "+18002738255"

    /** How the older number is dialed: in E.164, with the 1, or as a 10-digit US number. */
    private val LIFELINE_800_FORMS: Set<String> = setOf(LIFELINE_800, "18002738255", "8002738255")

    /** AOSP 17 EmergencyNumberTracker's numbers for a phone without a SIM. */
    val WHEN_ANDROID_CANT_SAY: Set<String> = setOf("112", "911", "000", "08", "110", "118", "119", "999")

    /** Why [number] always works, or null when it's an ordinary number (or there's none). */
    fun kind(number: String?, android: EmergencyNumbers): AlwaysAllowedKind? {
        val dialable = PhoneNumbers.dialable(number)
        if (dialable.isEmpty()) return null
        if (dialable == EMERGENCY_911) return AlwaysAllowedKind.EMERGENCY
        if (dialable == CRISIS_988 || dialable in LIFELINE_800_FORMS) return AlwaysAllowedKind.CRISIS_988
        val emergency = try {
            android.isEmergency(dialable)
        } catch (e: RuntimeException) {
            // Telephony threw (IllegalStateException while it restarts): Android can't say.
            null
        }
        return when (emergency) {
            true -> AlwaysAllowedKind.EMERGENCY
            false -> null
            null -> AlwaysAllowedKind.EMERGENCY.takeIf { dialable in WHEN_ANDROID_CANT_SAY }
        }
    }

    fun allows(number: String?, android: EmergencyNumbers): Boolean = kind(number, android) != null

    /**
     * Why a call the kid dials to [number] always works: as [kind] says, or once the caller-id codes
     * dialed before it are taken off (PhoneNumbers.withoutCodes: "*67 911", "#31#988"). Android
     * itself sees only the whole string, so it calls "*67911" an ordinary number (platform notes
     * T17); Belay lets it through, and whatever the network does with it is the network's.
     */
    fun dialed(number: String?, android: EmergencyNumbers): AlwaysAllowedKind? =
        kind(number, android) ?: PhoneNumbers.withoutCodes(number).firstNotNullOfOrNull { kind(it, android) }

    /** Whether a call or text the kid makes to [number] opens the 2-hour window in which every caller rings. */
    fun opensCallbackWindow(number: String?, android: EmergencyNumbers): Boolean = dialed(number, android) != null
}
