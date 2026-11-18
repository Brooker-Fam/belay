package family.brooker.belay.core.kid

import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireCaregiver
import family.brooker.belay.core.WireCommand
import family.brooker.belay.core.WirePause
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.location.FixReading
import family.brooker.belay.core.location.LocationState
import family.brooker.belay.core.location.LocationWork
import family.brooker.belay.core.location.ToldKind
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.core.location.WireLocationProvider
import family.brooker.belay.core.screentime.KidArg
import family.brooker.belay.core.screentime.KidMessage
import family.brooker.belay.core.screentime.KidText
import family.brooker.belay.core.screentime.Reason
import family.brooker.belay.core.screentime.Rules
import family.brooker.belay.core.screentime.WireScreenTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Phase 12: the caregivers a parent gave some access to this phone, as the kid's screens list
 * them, and a caregiver's pause and check named for the kid. Made-up names only.
 */
class CaregiversTest {
    private val zone: ZoneId = ZoneId.of("UTC")
    private val day = 24 * HOUR
    private val checks = WireLocation(mode = WireLocationMode.ON_DEMAND)
    private fun grandma(until: Long = T0 + 2 * day, can: List<String> = listOf("status", "pause", "help")) = WireCaregiver("Grandma", until, can)

    @Test
    fun `lists those whose access lasts by the phone's own clock, the soonest end first, then by name, at most 20`() {
        val list = listOf(
            WireCaregiver("Coach Lee", T0 + 3 * day, listOf("status")),
            grandma(),
            WireCaregiver("aunt Robin", T0 + 2 * day, listOf("help")),
            WireCaregiver("Gone already", T0, listOf("status")),
        )
        val shown = Caregivers.current(list, T0, locateWorks = true)
        assertEquals(listOf("aunt Robin", "Grandma", "Coach Lee"), shown.map { it.name })
        // At their until, by the phone's clock, before a new policy comes: no longer listed.
        assertEquals(listOf("Coach Lee"), Caregivers.current(list, T0 + 2 * day, locateWorks = true).map { it.name })
        assertEquals(emptyList(), Caregivers.current(list, T0 + 3 * day, locateWorks = true))
        val many = (1..25).map { WireCaregiver("Helper $it", T0 + it * HOUR, listOf("status")) }
        assertEquals(20, Caregivers.current(many, T0, locateWorks = true).size)
        assertEquals("Helper 1", Caregivers.current(many, T0, locateWorks = true).first().name)
    }

    @Test
    fun `a name is the parent's words, tidied to one line without what hides or reorders text, at most 40 characters`() {
        assertEquals("Grandma Jo", Caregivers.name("  Grandma\n  Jo  "))
        assertEquals("Granma", Caregivers.name("Gran‮ma​\u0007"))
        assertEquals("G".repeat(40), Caregivers.name("G".repeat(60)))
        // Never half of a character made of two: an emoji at the cut goes whole.
        assertEquals("G".repeat(39), Caregivers.name("G".repeat(39) + "😀"))
        assertNull(Caregivers.name("‏ ‪"))
        assertNull(Caregivers.name(null))
        // A caregiver is never left unlisted, nor called "your parent".
        assertEquals(listOf(Caregivers.UNNAMED), Caregivers.current(listOf(WireCaregiver("⁦⁩", T0 + day)), T0, locateWorks = true).map { it.name })
        assertEquals(Caregivers.UNNAMED, Caregivers.who("​"))
        assertNull(Caregivers.who(null))
    }

    @Test
    fun `what each may do is as the policy sends it, in order, known words only, and checking only while the phone answers a check`() {
        val sent = WireCaregiver("Grandma", T0 + day, listOf("locate", "help", "status", "help", "give_more_time"))
        assertEquals(
            listOf(CaregiverCan.STATUS, CaregiverCan.HELP, CaregiverCan.LOCATE),
            Caregivers.current(listOf(sent), T0, locateWorks = true).single().can,
        )
        assertEquals(listOf(CaregiverCan.STATUS, CaregiverCan.HELP), Caregivers.current(listOf(sent), T0, locateWorks = false).single().can)
        // From the policy: location off means no check, whatever was sent; on demand, as sent.
        val policy = WirePolicy(version = 3, caregivers = listOf(sent))
        assertEquals(listOf(CaregiverCan.STATUS, CaregiverCan.HELP), Caregivers.current(policy, T0).single().can)
        assertEquals(CaregiverCan.LOCATE, Caregivers.current(policy.copy(location = checks), T0).single().can.last())
        // Never inferred: not sent, not shown.
        assertEquals(listOf(CaregiverCan.STATUS, CaregiverCan.PAUSE, CaregiverCan.HELP), Caregivers.current(policy.copy(location = checks, caregivers = listOf(grandma())), T0).single().can)
        assertEquals(emptyList(), Caregivers.current(null, T0))
        assertEquals(listOf("Grandma"), Caregivers.gettingHelp(Caregivers.current(policy, T0)).map { it.name })
        assertEquals(emptyList(), Caregivers.gettingHelp(Caregivers.current(listOf(WireCaregiver("Coach Lee", T0 + day, listOf("status"))), T0, true)))
    }

    @Test
    fun `the kid's card says what each can see and do, until when, and what they never can`() {
        val all = Caregivers.current(listOf(grandma(can = listOf("status", "pause", "help", "locate"))), T0, locateWorks = true).single()
        val card = DataCategories.caregiver(all, "Sunday at 6:00 PM")
        assertEquals(DataCategories.CAREGIVER_ID, card.id)
        assertEquals("Grandma, until Sunday at 6:00 PM", card.title)
        assertEquals(
            listOf(
                "Can see whether this phone is online and when it last connected, its battery, and whether it's paused or on a schedule",
                "Can pause this phone, or pause it and lock the screen, for up to 4 hours at a time. Only your parent can end a pause early.",
                "Gets your \"I need help\" requests, with what you write, and where this phone is if you share it",
                "Can check where this phone is right now. You get a notification every time.",
                "Can't see your apps, your screen time, your calls, the websites apps look up, or where this phone has been",
                "Can't give you more time or let an app through. Only your parent can.",
            ),
            card.details,
        )
        // Only what a parent chose: help alone says nothing of pausing or checking.
        val help = DataCategories.caregiver(Caregivers.current(listOf(grandma(can = listOf("help"))), T0, true).single(), "8:00 PM")
        assertEquals(3, help.details.size)
        assertTrue(help.details.first().startsWith("Gets your \"I need help\""))
    }

    @Test
    fun `Home says a caregiver paused the phone, by their name, and a parent's pause stays the parent's`() {
        fun line(pause: WirePause) = Home.of(HomeInput(pause, now = T0, zone = zone)).line
        val until = KidArg.Moment.of(T0 + HOUR, T0, zone)
        assertEquals(KidText(KidMessage.HOME_PAUSED_BY_UNTIL, listOf(KidArg.Words("Grandma"), until)), line(WirePause(T0 + HOUR, caregiver = "Grandma")))
        assertEquals(KidText(KidMessage.HOME_PAUSED_BY, listOf(KidArg.Words("Grandma"))), line(WirePause(null, caregiver = "Grandma\n")))
        assertEquals(KidText(KidMessage.HOME_PAUSED_UNTIL, listOf(until)), line(WirePause(T0 + HOUR)))
        assertEquals(KidText(KidMessage.HOME_PAUSED_BY_UNTIL, listOf(KidArg.Words(Caregivers.UNNAMED), until)), line(WirePause(T0 + HOUR, caregiver = "‮")))
        // What works is the same as for any pause.
        assertTrue(Home.of(HomeInput(WirePause(T0 + HOUR, caregiver = "Grandma"), now = T0, zone = zone)).allPaused)
    }

    @Test
    fun `a paused app's words name the caregiver who paused the phone`() {
        val decision = Rules.evaluate(
            Rules.Input(
                policy = WireScreenTime(zone = "UTC"), now = T0, phoneZone = zone, usage = null, measured = true,
                apps = setOf("com.example.blocks"), neverBlocked = emptySet(), pause = WirePause(T0 + HOUR, caregiver = "Grandma"),
            ),
        )
        val paused = decision.suspend.getValue("com.example.blocks")
        assertEquals(Reason.Paused(T0 + HOUR, "Grandma"), paused.reason)
        assertEquals(KidText(KidMessage.PAUSED_BY_UNTIL, listOf(KidArg.Words("Grandma"), KidArg.Moment.of(T0 + HOUR, T0, zone))), paused.kidText)
        assertEquals(KidMessage.PAUSED_BY_UNTIL, decision.today().first().message)
    }

    @Test
    fun `a caregiver's check is named in the kid's notice and in What Belay told your parent, sent or not`() {
        val owner = LocationWork.Facts(owner = true, permission = true, locationOn = true)
        val asked = LocationWork.commands(checks, listOf(WireCommand("command-1", WireCommand.LOCATE_NOW, T0, caregiver = "Grandma")), owner, T0)
        assertEquals("Grandma", asked.wants.single().caregiver)
        val reading = FixReading(T0, 40.0, -75.0, 12, WireLocationProvider.GPS, mock = false)
        val recorded = LocationWork.record(checks, LocationState(wants = asked.wants), asked.wants, reading, null, T0, ids())
        assertEquals("Grandma", recorded.told.single().caregiver)
        assertEquals(null, recorded.told.single().via)
        assertEquals("Grandma", recorded.checks.single().caregiver)
        // Refused at once (location off): still named.
        val refused = LocationWork.commands(WireLocation(), listOf(WireCommand("command-2", WireCommand.LOCATE_NOW, T0, caregiver = "Grandma")), owner, T0).told.single()
        assertEquals(ToldKind.CHECK to "Grandma", refused.kind to refused.caregiver)
        // An AI app's name and a caregiver's never go together: the AI app's is the one the server meant.
        val both = LocationWork.commands(checks, listOf(WireCommand("command-3", WireCommand.LOCATE_NOW, T0, via = "Claude", caregiver = "Grandma")), owner, T0).wants.single()
        assertEquals("Claude" to null, both.via to both.caregiver)
        // A parent's check names no one.
        assertNull(LocationWork.commands(checks, listOf(WireCommand("command-4", WireCommand.LOCATE_NOW, T0)), owner, T0).wants.single().caregiver)
    }

    @Test
    fun `the policy's caregivers, a caregiver's pause and command parse, and a policy without them names no one`() {
        val json = """{"server_time":5,"policy":{"version":12,
            "pause":{"until":${T0 + HOUR},"note":null,"caregiver":"Grandma"},
            "commands":[{"id":"command-0001","kind":"locate_now","issued_at":$T0,"expires_at":${T0 + 120_000},"via":null,"caregiver":"Grandma"}],
            "caregivers":[{"name":"Grandma","until":${T0 + day},"can":["status","pause","help"]},{"name":"Coach Lee","until":${T0 + 2 * day},"can":["something_new"]}]}}"""
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), json).policy
        assertEquals("Grandma", policy.pause?.caregiver)
        assertEquals("Grandma", policy.commands.single().caregiver)
        assertEquals(listOf("Grandma", "Coach Lee"), policy.caregivers.map { it.name })
        assertEquals(listOf(emptyList<CaregiverCan>()), Caregivers.current(policy, T0).filter { it.name == "Coach Lee" }.map { it.can })
        val old = Wire.json.decodeFromString(PolicyResponse.serializer(), """{"server_time":5,"policy":{"version":3,"pause":{"until":null,"note":"Dinner"}}}""").policy
        assertEquals(emptyList(), old.caregivers)
        assertNull(old.pause?.caregiver)
    }
}
