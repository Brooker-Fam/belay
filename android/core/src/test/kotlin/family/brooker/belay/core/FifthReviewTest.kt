package family.brooker.belay.core

import family.brooker.belay.core.calls.AfterRestart
import family.brooker.belay.core.calls.AlwaysAllowed
import family.brooker.belay.core.calls.AndroidLogCall
import family.brooker.belay.core.calls.CallRecords
import family.brooker.belay.core.calls.CallRules
import family.brooker.belay.core.calls.CallsNow
import family.brooker.belay.core.calls.CallsPlan
import family.brooker.belay.core.calls.EmergencyNumbers
import family.brooker.belay.core.calls.IncomingCall
import family.brooker.belay.core.calls.PhoneNumbers
import family.brooker.belay.core.calls.Presentation
import family.brooker.belay.core.calls.Ring
import family.brooker.belay.core.calls.RingBecause
import family.brooker.belay.core.calls.Verification
import family.brooker.belay.core.calls.WireCallAction
import family.brooker.belay.core.calls.WireCallDirection
import family.brooker.belay.core.calls.WireCallMode
import family.brooker.belay.core.calls.WireCallOutcome
import family.brooker.belay.core.calls.WireCalls
import family.brooker.belay.core.calls.WireContact
import family.brooker.belay.core.calls.WireOutgoing
import family.brooker.belay.core.location.LostApplied
import family.brooker.belay.core.network.DnsLookup
import family.brooker.belay.core.network.Domains
import family.brooker.belay.core.network.NetworkDay
import family.brooker.belay.core.network.NetworkDigest
import family.brooker.belay.core.network.NetworkKey
import family.brooker.belay.core.network.WireNetworkDay
import family.brooker.belay.core.network.WireNetworkEntry
import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.ScreenTimeState
import family.brooker.belay.core.screentime.Upkeep
import family.brooker.belay.core.screentime.WireDay
import family.brooker.belay.core.screentime.WireSchedule
import family.brooker.belay.core.screentime.WireScheduleKind
import family.brooker.belay.core.screentime.WireScreenTime
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The fifth security review's probes on the phone (commit 960874a), turned to assert what holds
 * now: the fixes (F1, F1b, F2's phone half, F3), what the threat model accepts and documents (P2,
 * I1 to I4, I7's `*70`), and what the review found sound (N1, N7, N8, private websites). The
 * restart's steps run through core's own functions, as calls/CallsStep.kt runs them. Made-up
 * 555-01xx numbers and .example domains only; nothing dials anything.
 */
class FifthReviewTest {
    private val ny: ZoneId = ZoneId.of("America/New_York")
    private fun at(local: String): Long = LocalDateTime.parse(local).atZone(ny).toInstant().toEpochMilli()
    private val minute = 60_000L
    private val day = 86_400_000L

    /** A US phone whose formatter works like libphonenumber's for these: 10 digits, 1 + 10, and 011 + a country code. */
    private val us = object : EmergencyNumbers {
        override fun isEmergency(number: String) = number in setOf("911", "112")
        override fun e164(number: String): String? {
            PhoneNumbers.e164(number)?.let { return it }
            if (!number.all(Char::isDigit)) return null
            return when {
                number.length == 10 -> "+1$number"
                number.length == 11 && number.startsWith("1") -> "+$number"
                number.startsWith("011") && number.length in 11..18 -> "+" + number.drop(3)
                else -> null
            }
        }
    }

    /** The same phone when Android can't say its country: only E.164 as written. */
    private val noCountry = EmergencyNumbers { number -> number in setOf("911", "112") }

    private val mom = WireContact("c-mom", "Mom", listOf("+15555550100"), calls = true, parent = true)
    private val sam = WireContact("c-sam", "Sam", listOf("+15555550123"), calls = true)
    private val strict = WireCalls(
        mode = WireCallMode.CONTACTS, unknown = WireCallAction.REJECT, withheld = WireCallAction.REJECT,
        outgoing = WireOutgoing.CONTACTS, quiet = true, log = true,
    )
    private val rules = CallsNow(calls = strict, contacts = listOf(mom, sam), now = 0)
    private val private = setOf("+15555550177")

    private fun incoming(number: String?, at: Long, durationS: Int = 600) =
        AndroidLogCall(number ?: "", at, WireCallDirection.IN, durationS, withheld = number == null, outcome = WireCallOutcome.ANSWERED)

    private fun outgoing(number: String, at: Long, durationS: Int = 60) =
        AndroidLogCall(number, at, WireCallDirection.OUT, durationS, outcome = if (durationS > 0) WireCallOutcome.ANSWERED else WireCallOutcome.MISSED)

    private var ids = 0
    private fun take(log: List<AndroidLogCall>, from: Long, until: Long, emergencyAt: List<Long>, seen: List<Long> = emptyList(), android: EmergencyNumbers = us) =
        CallRecords.whileLocked(log, from, until, seen, emptyList(), rules, { false }, emergencyAt, private, android) { "call-${++ids}" }

    /**
     * One agent step's restart part, as CallsStep runs it: the times Belay knows now ([known]: its
     * record of the last emergency contact, and the time kept before the unlock) kept with the
     * restart, then Android's log read when a read is due, from 2 hours before the restart. [log]
     * is the whole call log as it is at that step; [elsewhere]: Telecom has a call Belay doesn't.
     */
    private fun step(spell: AfterRestart, known: List<Long>, log: List<AndroidLogCall>, elsewhere: Boolean): Pair<AfterRestart, List<family.brooker.belay.core.calls.CallEntry>> {
        val kept = CallsPlan.keepEmergencies(spell, known)
        if (!CallsPlan.readLockedCalls(kept, callsOn = true) { elsewhere }) return kept to emptyList()
        val readable = log.filter { it.at in CallRecords.spellReadFrom(kept.bootAt)..kept.unlockedAt }
        val taken = CallRecords.whileLocked(readable, kept.bootAt, kept.unlockedAt, kept.seen, emptyList(), rules, { false }, kept.emergencyAt + known, private, us) { "call-${++ids}" }
        return CallsPlan.afterRead(kept, taken) { elsewhere } to taken.entries
    }

    private fun sent(entries: List<family.brooker.belay.core.calls.CallEntry>) = entries.mapNotNull { CallRecords.toWire(it, private, us) }

    // ── F1: the second read after a restart ─────────────────────────────────────────────

    /**
     * F1, fixed. A 911 call from the lock screen at 20:05 (Telecom doesn't log it; LockedCalls keeps
     * its time), the dispatcher's callback answered on the lock screen at 21:30, the unlock at 21:35
     * during it, and the callback lasting until 22:30, past the window. The steps in between forget
     * Belay's record and LockedCalls' copy; the second read still decides by the window the first
     * had, so nothing is sent.
     */
    @Test
    fun `F1 - a callback still on at the unlock is never sent, though the window it rang in is forgotten by then`() {
        val bootAt = at("2026-11-18T20:00:00")
        val t911 = at("2026-11-18T20:05:00")
        val unlockedAt = at("2026-11-18T21:35:00")
        val callback = incoming("5555550160", at("2026-11-18T21:30:00"), durationS = 3600)
        var spell = CallsPlan.afterRestart(
            AfterRestart(bootCount = 11, bootAt = bootAt - day, unlockedAt = bootAt - day + minute, callsOn = true, read = true),
            bootCount = 12, bootAt = bootAt, unlockedAt = unlockedAt, callsWasOn = true,
        )
        // The first step: Belay's record has nothing from before the restart, LockedCalls has 20:05;
        // the callback isn't in the log yet (Android logs a call when it ends).
        val (afterFirst, first) = step(spell, known = listOf(t911), log = emptyList(), elsewhere = true)
        spell = afterFirst
        assertEquals(emptyList(), first)
        assertTrue(spell.again)
        assertEquals(listOf(t911), spell.emergencyAt)
        var stored = CallsPlan.emergencyContact(null, t911, unlockedAt)
        // A step at 22:10, the call still on: past 20:05's 2 hours, Belay forgets both copies.
        val during = at("2026-11-18T22:10:00")
        spell = step(spell, known = listOfNotNull(stored, t911), log = emptyList(), elsewhere = true).first
        stored = CallsPlan.emergencyContact(stored, t911, during)
        assertNull(stored, "Belay's record of the window is forgotten")
        assertFalse(CallRules.callbackWindow(t911, null, during), "LockedCalls' copy is deleted at this step")
        assertEquals(listOf(t911), spell.emergencyAt, "kept with the restart while the second read is due")
        // The call ends at 22:30; the next step reads again with nothing else left.
        val (afterSecond, second) = step(spell, known = emptyList(), log = listOf(callback), elsewhere = false)
        assertTrue(second.single().callback, "it rang only because of the window")
        assertEquals(emptyList(), sent(second), "nothing is sent")
        assertEquals(emptyList(), afterSecond.emergencyAt, "and the times go after the last read")
        assertFalse(afterSecond.again)
        // What the review saw without them: the same call sent with the dispatcher's number.
        val without = take(listOf(callback), bootAt, unlockedAt, emergencyAt = emptyList())
        assertEquals("+15555550160", CallRecords.toWire(without.entries.single(), private, us)?.number)
    }

    /** F1b, fixed: 988 called just before the restart; the counselor's callback still on at the unlock. */
    @Test
    fun `F1b - a 988 counselor's callback is never sent, from Belay's record or from the log before the restart`() {
        val t988 = at("2026-11-18T19:55:00")
        val bootAt = at("2026-11-18T20:00:00")
        val unlockedAt = at("2026-11-18T21:45:00")
        val counselor = incoming("+15555550161", at("2026-11-18T21:40:00"), durationS = 50 * 60)
        val logged988 = outgoing("988", t988, durationS = 900)
        val fresh = AfterRestart(bootCount = 12, bootAt = bootAt, unlockedAt = unlockedAt, callsOn = true)
        // Belay placed it, so its record has 19:55; a step at 22:00 forgets it; the call ends at 22:30.
        var spell = step(fresh, known = listOf(t988), log = listOf(logged988), elsewhere = true).first
        assertNull(CallsPlan.emergencyContact(t988, null, at("2026-11-18T22:00:00")))
        spell = step(spell, known = emptyList(), log = listOf(logged988), elsewhere = true).first
        val second = step(spell, known = emptyList(), log = listOf(logged988, counselor), elsewhere = false).second
        assertTrue(second.single().callback)
        assertEquals(emptyList(), sent(second))
        // The preloaded dialer placed it, so Belay's record missed it: the log from 2 hours before the
        // restart has it at the first read, and it holds even if the kid deletes that entry before the second.
        val missed = step(fresh, known = emptyList(), log = listOf(logged988), elsewhere = true).first
        assertEquals(listOf(t988), missed.emergencyAt)
        val deleted = step(missed, known = emptyList(), log = listOf(counselor), elsewhere = false).second
        assertTrue(deleted.single().callback)
        assertEquals(emptyList(), sent(deleted))
    }

    @Test
    fun `sound - never a call with 911, 988, an emergency or a private number, also with codes or without the area code`() {
        val bootAt = at("2026-11-18T22:00:00")
        val unlockedAt = at("2026-11-18T23:30:00")
        val numbers = listOf("911", "988", "+18002738255", "18002738255", "8002738255", "112", "+15555550177", "15555550177", "5555550177", "5550177", "555-0177")
        val log = numbers.mapIndexed { i, n -> incoming(n, bootAt + (i + 1) * minute) } +
            listOf("*67911", "#31#988", "*82 1 800 273 8255", "*67112", "*67 555 555 0177", "#31#5550177", "*31#15555550177")
                .mapIndexed { i, n -> outgoing(n, bootAt + (30 + i) * minute) }
        for (android in listOf(us, noCountry)) {
            assertEquals(emptyList(), take(log, bootAt, unlockedAt, emergencyAt = emptyList(), android = android).entries)
        }
    }

    /**
     * P2, accepted and documented (threat model, platform notes T22): Belay takes Android's call log
     * as it is. A made-up outgoing 988 entry makes the spell's refused strangers callbacks, never
     * sent; a made-up entry with a contact's number is that contact's call. An app able to write one
     * holds WRITE_CALL_LOG, which a parent sees as "call history" before approving it.
     */
    @Test
    fun `P2 accepted - a made-up call log entry is taken as Android keeps it, and writing the log is call history`() {
        val bootAt = at("2026-11-18T22:00:00")
        val unlockedAt = at("2026-11-19T01:00:00")
        val strangers = listOf(incoming("+15555550190", at("2026-11-18T22:40:00")), incoming("+15555550191", at("2026-11-18T23:50:00")))
        assertEquals(2, sent(take(strangers, bootAt, unlockedAt, emergencyAt = emptyList()).entries).size)
        val fake988 = outgoing("988", at("2026-11-18T22:30:00"), durationS = 0)
        val hidden = take(strangers + fake988, bootAt, unlockedAt, emergencyAt = emptyList())
        assertTrue(hidden.entries.all { it.callback })
        assertEquals(emptyList(), sent(hidden.entries))
        val framed = take(listOf(incoming("+15555550123", at("2026-11-19T00:10:00"), durationS = 45 * 60)), bootAt, unlockedAt, emergencyAt = emptyList())
        assertEquals("c-sam", sent(framed.entries).single().contactId)
        assertEquals(listOf(SensitivePermissions.CALL_LOG), SensitivePermissions.held(listOf("android.permission.WRITE_CALL_LOG")))
    }

    // ── N2 and N8: numbers as dialed ─────────────────────────────────────────────────────

    /** I2, documented: without the phone's country, a private number dialed with an international prefix isn't private. */
    @Test
    fun `I2 documented - the suffix match misses a private number dialed with an international prefix when Android can't format`() {
        val privateNumbers = setOf("+15555550177", "+448088005000")
        for (dialed in listOf("011 1 555 555 0177", "1 555 555 0177", "555 555 0177", "555 0177", "*67 555 0177", "011 44 808 800 5000")) {
            assertTrue(CallRecords.isPrivate(PhoneNumbers.dialable(dialed), privateNumbers, us), dialed)
        }
        val missed = listOf("011 1 555 555 0177", "011 44 808 800 5000", "0808 800 5000").filter { !CallRecords.isPrivate(PhoneNumbers.dialable(it), privateNumbers, noCountry) }
        assertEquals(listOf("011 1 555 555 0177", "011 44 808 800 5000", "0808 800 5000"), missed)
        val entry = assertNotNull(CallRecords.entry("x", 0, WireCallDirection.OUT, "01115555550177", null, 1200, WireCallOutcome.ANSWERED, null, privateNumbers, noCountry))
        assertNull(assertNotNull(CallRecords.toWire(entry, privateNumbers, noCountry)).number, "sent without the digits")
    }

    /** I1, documented: 988's old number dialed with 011 isn't always allowed, and is kept on the phone, never sent. */
    @Test
    fun `I1 documented - 988's old number dialed with 011 is refused under only contacts, and never sent`() {
        val dialed = PhoneNumbers.dialable("011 1 800 273 8255")
        assertNull(AlwaysAllowed.dialed(dialed, us))
        assertFalse(CallRules.outgoing(dialed, rules, us).allowed)
        val entry = assertNotNull(CallRecords.entry("x", 0, WireCallDirection.OUT, dialed, null, 600, WireCallOutcome.ANSWERED, null, emptySet(), us))
        assertEquals("+18002738255", entry.number)
        assertNull(CallRecords.toWire(entry, emptySet(), us))
    }

    @Test
    fun `sound - every caller-ID code before 911, 988, 112 and 988's old number always goes, under only contacts`() {
        val codes = listOf("*67", "*82", "#31#", "*31#", "*67*82", "#31#*67", "*82#31#", "*67#31#")
        val targets = listOf("911", "988", "112", "18002738255", "+18002738255", "8002738255", "1 800 273 8255", "(800) 273-8255")
        val failed = mutableListOf<String>()
        for (code in codes) for (sep in listOf("", " ", "-")) for (target in targets) {
            val dialed = code + sep + target
            for (android in listOf(us, noCountry, EmergencyNumbers { null })) {
                val key = PhoneNumbers.key(dialed, android)
                val d = CallRules.outgoing(key, rules, android)
                if (!d.allowed || d.alwaysAllowed == null || CallRecords.keepable(key, private, android)) failed += dialed
            }
        }
        // Only a code that makes the string a supplementary service request: "*67#…" is call forwarding's to GSM.
        assertTrue(failed.distinct().isNotEmpty())
        assertTrue(failed.distinct().all { it.startsWith("*67#31#") || it.startsWith("*82#31#") }, failed.distinct().toString())
    }

    /** I4, the comment fixed: "*67 #31# 911" is no call to Android, so withoutCodes stops at "*67#". */
    @Test
    fun `I4 - withoutCodes stops at star-67-hash, and its comment says so`() {
        assertNull(PhoneNumbers.withoutCodes("*67 #31# 911"))
        assertEquals("911", PhoneNumbers.withoutCodes("#31# *67 911"))
        assertEquals("911", PhoneNumbers.withoutCodes("*67 911"))
        assertNull(PhoneNumbers.withoutCodes("*67*31#911"))
        assertNull(PhoneNumbers.withoutCodes("*67#911"))
    }

    /**
     * I7, decided (platform notes T17): `*70` stays an ordinary number. AOSP 17 reads only `*67` and
     * `*82`, Verizon documents `*70` before a 10-digit number only, and nothing says a network
     * connects "*70911" to 911; it would come off once one is known to.
     */
    @Test
    fun `I7 decided - star-70 before 911 isn't taken for 911`() {
        for (dialed in listOf("*70911", "*70 911", "*70 988")) {
            assertNull(PhoneNumbers.withoutCodes(dialed), dialed)
            assertNull(AlwaysAllowed.dialed(PhoneNumbers.key(dialed, us), us), dialed)
        }
    }

    // ── N5: screen locks during calls ────────────────────────────────────────────────────

    /**
     * F3, fixed: while Belay is the dialer it asks Telecom's isInManagedCall, which leaves an app's
     * self-managed calls out (platform notes T20), so a VoIP call left open all night holds no
     * lock; a managed call (a carrier call) still holds one as long as it lasts, and one only the
     * audio mode shows, 30 minutes.
     */
    @Test
    fun `F3 - an app's own call holds no lock, a managed one holds it as long as it lasts, the audio mode's 30 minutes`() {
        val bedtime = WireSchedule("s-bed", WireScheduleKind.BEDTIME, "Bedtime", WireDay.entries.toList(), "21:00", "07:00", lock = true)
        val policy = WireScreenTime(schedules = listOf(bedtime))
        fun locksAt(call: () -> CallNow): List<Int> {
            var state = ScreenTimeState()
            var carrierSince: Long? = null
            val lockedAt = mutableListOf<Int>()
            for (m in 0 until (10 * 60) step 5) {
                val now = at("2026-11-18T21:00:00") + m * minute
                val decision = Rules.evaluate(Rules.Input(policy = policy, now = now, phoneZone = ny, usage = null, measured = true, apps = setOf("com.example.voice"), neverBlocked = emptySet()))
                val wait = ScreenLocks.wait(call(), carrierSince, now)
                carrierSince = wait.carrierSince
                val (due, next) = Upkeep.locks(decision, state, now, callOn = wait.waits)
                if (due.isNotEmpty()) lockedAt += m
                state = next
            }
            return lockedAt
        }
        // An app's self-managed call: Telecom's isInManagedCall says no; the audio mode isn't asked.
        assertEquals(listOf(0), locksAt { CallNow.of(belays = false, managed = { false }) { error("not asked while Telecom answers") } })
        // A carrier call all night: no lock, as designed (the screen never goes off mid-call).
        assertEquals(emptyList(), locksAt { CallNow.of(belays = false, managed = { true }) { false } })
        // Belay not the dialer, a carrier call only the audio mode shows: 30 minutes at most.
        assertEquals(listOf(30), locksAt { CallNow.of(belays = false, managed = { null }) { true } })
        // Lost mode's lock waits only for a managed call.
        assertFalse(ScreenLocks.lostLockWaits(LostApplied(since = 0), telecom = CallNow.of(false, { false }) { true }.telecom))
    }

    /** F2's phone half, fixed: a lock_now during a call is done at once, never expired for the call, and no result says one was on. */
    @Test
    fun `F2 - a lock_now during a call is reported done when the phone has it, and nothing in it says a call was on`() {
        val lock = WireCommand("lock-1", WireCommand.LOCK_NOW, issuedAt = 0, expiresAt = 10 * minute)
        val plan = Commands.plan(listOf(lock), emptySet(), now = minute, runs = setOf(WireCommand.LOCK_NOW))
        val during = ScreenLocks.lockNow(plan, due = null, bootCount = 1, bootAt = 0) { true }
        val quiet = ScreenLocks.lockNow(plan, due = null, bootCount = 1, bootAt = 0) { false }
        assertEquals(quiet.report, during.report, "reported at the same step, call or not")
        val log = CommandLog().record(during.report.map { CommandLog.done(it, minute) }).due(during.due)
        // 11 minutes later, the call still on: nothing expires, nothing more is reported.
        val later = Commands.plan(listOf(lock), log.doneIds, now = 11 * minute, runs = setOf(WireCommand.LOCK_NOW))
        assertEquals(emptyList(), CommandLog.notRun(later, 11 * minute))
        assertEquals(listOf(WireCommandResult("lock-1", WireCommandOutcome.DONE, minute)), log.results)
        assertEquals("""[{"id":"lock-1","result":"done","at":60000}]""", Wire.json.encodeToString(kotlinx.serialization.builtins.ListSerializer(WireCommandResult.serializer()), log.results))
        // The kid's screen says what a parent can still learn about locks, and what it can't.
        assertTrue(DataCategories.DEVICE_STATUS.details.any { it.startsWith("Whether the phone got a screen lock your parent sent in time") && it.contains("Belay doesn't say when that was") })
    }

    // ── N7: a parent's number whose check failed ─────────────────────────────────────────

    @Test
    fun `sound - a failed caller ID showing a parent's number never rings past what a stranger's would`() {
        for (mode in WireCallMode.entries) for (unknown in WireCallAction.entries) for (quiet in listOf(false, true)) for (window in listOf(false, true)) {
            val now = at("2026-11-18T23:00:00")
            val calls = WireCalls(mode = mode, unknown = unknown, withheld = WireCallAction.REJECT, quiet = true)
            val state = CallsNow(calls = calls, contacts = listOf(mom, sam), quietSchedule = quiet, lastEmergencyContactAt = if (window) now - 30 * minute else null, now = now)
            val spoofed = CallRules.incoming(IncomingCall("+15555550100", Presentation.NUMBER, Verification.FAILED), state, us)
            val stranger = CallRules.incoming(IncomingCall("+15555550199", Presentation.NUMBER, Verification.FAILED), state, us)
            val case = "$mode/$unknown/quiet=$quiet/window=$window"
            assertNull(spoofed.contact, case)
            assertTrue(spoofed.because != RingBecause.PARENT, case)
            assertEquals(if (stranger.action == Ring.REJECT) Ring.VOICEMAIL else stranger.action, spoofed.action, case)
        }
    }

    // ── Private websites on the phone ────────────────────────────────────────────────────

    @Test
    fun `sound - a private website's lookups are dropped in any form, counted as PRIVATE, and move no day's newest time`() {
        val private = Domains.privateSet(listOf("helpline.example", "not a name", "xn--bcher-kva.example"))
        assertEquals(setOf("helpline.example", "xn--bcher-kva.example"), private)
        val t = at("2026-11-18T20:00:00")
        val lookups = listOf(
            DnsLookup("com.example.browser", "news.example", t),
            DnsLookup("com.example.browser", "HELPLINE.Example.", t + minute),
            DnsLookup("com.example.browser", "chat.cdn.helpline.example", t + 2 * minute),
            DnsLookup("com.example.chat", "bücher.example", t + 3 * minute),
            DnsLookup("com.example.chat", "988lifeline.org", t + 4 * minute),
        )
        val batch = NetworkDigest.reduce(lookups, never = emptySet(), zone = ny, now = t + 5 * minute, private = private)
        assertEquals(mapOf("2026-11-18" to mapOf(NetworkKey("com.example.browser", "news.example") to 1)), batch.days)
        assertEquals(t, batch.newest["2026-11-18"])
        assertEquals(4, batch.skipped[NetworkDigest.Skip.PRIVATE])
    }

    /** I3, documented: a day kept from before keeps the private lookup's time as its as_of (a time, never a name). */
    @Test
    fun `I3 documented - a day kept from before keeps its as_of, and a queued report goes cleaned`() {
        val t = at("2026-11-18T20:00:00")
        val kept = NetworkDay("2026-11-18", ny.id, asOf = t + 30 * minute, counts = mapOf(
            NetworkKey("com.example.browser", "news.example") to 3,
            NetworkKey("com.example.browser", "helpline.example") to 9,
        ))
        val cleared = assertNotNull(NetworkDigest.without(kept, setOf("helpline.example")))
        assertEquals(setOf(NetworkKey("com.example.browser", "news.example")), cleared.counts.keys)
        assertEquals(t + 30 * minute, cleared.asOf)
        val queued = Wire.json.encodeToString(WireNetworkDay.serializer(), NetworkDigest.wire(kept))
        val sent = NetworkDigest.sendable(queued, setOf("helpline.example"))
        assertFalse(sent.contains("helpline"))
        assertEquals(listOf(WireNetworkEntry("com.example.browser", "news.example", 3)), Wire.json.decodeFromString(WireNetworkDay.serializer(), sent).entries)
    }
}
