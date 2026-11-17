package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.location.WireFix
import family.brooker.belay.core.location.WireFixReason
import family.brooker.belay.core.location.WireLocationProvider
import family.brooker.belay.core.screentime.WireAgreementAnswer
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Phase 7: "I need help", "Talk to my parent", editing and taking back a request. Made-up words only. */
class KidRequestsTest {
    private val chat = KidRequest("request-1", "com.example.chat", "Chatter Box", "My friends use it", T0)
    private val fix = WireFix("fix-0001", T0 + 5, 40.0, -75.0, 12, WireLocationProvider.GPS, WireFixReason.HELP)

    private fun answered(vararg requests: KidRequest, policy: WirePolicy? = null) = Requests.answered(requests.toList(), policy)

    private fun wire(request: KidRequest) =
        Wire.json.parseToJsonElement(Wire.json.encodeToString(WireRequest.serializer(), Requests.toWire(request))).jsonObject

    @Test
    fun `I need help needs no words, and can carry some`() {
        val help = Requests.help(null, sharing = false, T0, ids())
        assertEquals(WireRequestKind.HELP, help.kind)
        assertNull(help.reason)
        assertEquals(setOf("id", "kind", "asked_at"), wire(help).keys)
        val words = Requests.help("  I got lost after practice  ", sharing = true, T0, ids())
        assertEquals("I got lost after practice", words.reason)
        assertTrue(words.sharing)
        assertEquals(setOf("id", "kind", "reason", "asked_at"), wire(words).keys, "sharing is the phone's own note, not sent")
    }

    @Test
    fun `the shared fix goes in the help request, sent again`() {
        val help = Requests.help(null, sharing = true, T0, ids())
        val withFix = Requests.withHelpFix(listOf(help), help.id, fix)
        assertNotNull(withFix)
        assertEquals(fix, withFix.location)
        assertFalse(withFix.sharing)
        assertEquals(1, withFix.revision)
        assertTrue(Requests.itemId(withFix) != Requests.itemId(help))
        assertEquals("\"help\"", wire(withFix)["location"]!!.jsonObject["reason"].toString())
        // No fix: only no longer finding it, not sent again.
        val none = Requests.withHelpFix(listOf(help), help.id, null)
        assertEquals(help.copy(sharing = false), none)
        assertNull(Requests.withHelpFix(listOf(chat), chat.id, fix), "only a help request takes a fix")
    }

    @Test
    fun `talk needs the kid's words`() {
        assertNull(Requests.talk("   ", T0, ids()))
        val talk = Requests.talk("Can we talk about bedtime?", T0, ids())!!
        assertEquals(WireRequestKind.TALK, talk.kind)
        assertEquals(setOf("id", "kind", "reason", "asked_at"), wire(talk).keys)
    }

    @Test
    fun `a pending request's words can be changed, an answered one's can't`() {
        val edited = Requests.edit(answered(chat), chat.id, "  It's for my book club  ")!!
        assertEquals("It's for my book club", edited.reason)
        assertEquals(1, edited.revision)
        assertEquals(T0, edited.askedAt)
        val declined = WirePolicy(version = 2, requests = listOf(WireRequestAnswer(chat.id, WireRequestStatus.DECLINED)))
        assertNull(Requests.edit(answered(chat, policy = declined), chat.id, "Please?"))
        assertNull(Requests.edit(answered(chat), chat.id, "My friends use it"), "nothing changed")
        val talk = Requests.talk("Bedtime", T0, ids())!!
        assertNull(Requests.edit(answered(talk), talk.id, " "), "a talk request keeps its words")
        assertNull(Requests.edit(answered(chat), "request-404", "Hi"))
    }

    @Test
    fun `a pending request can be taken back, and then it's no longer open`() {
        val withdrawn = Requests.withdraw(answered(chat), chat.id, T0 + HOUR)!!
        assertEquals(T0 + HOUR, withdrawn.withdrawnAt)
        assertEquals(1, withdrawn.revision)
        assertEquals(T0 + HOUR, Wire.json.decodeFromJsonElement(WireRequest.serializer(), wire(withdrawn)).withdrawnAt)
        val after = answered(withdrawn).single()
        assertTrue(after.withdrawn)
        assertFalse(after.open)
        assertNull(Requests.withdraw(listOf(after), chat.id, T0 + 2 * HOUR), "once is enough")
        // Asking for the app again makes a new request.
        val again = Requests.send(listOf(after), chat.packageName, chat.label, "Please", T0 + 3 * HOUR, ids())
        assertTrue(again.id != chat.id)
    }

    @Test
    fun `an answered request, or I agree, can't be taken back`() {
        val approved = WirePolicy(version = 2, requests = listOf(WireRequestAnswer(chat.id, WireRequestStatus.APPROVED)))
        assertNull(Requests.withdraw(answered(chat, policy = approved), chat.id, T0))
        val agree = Requests.agreement(emptyList(), 1, WireAgreementAnswer.AGREE, null, T0, ids())
        assertNull(Requests.withdraw(answered(agree), agree.id, T0))
        val talk = Requests.agreement(emptyList(), 1, WireAgreementAnswer.TALK, "The bedtime part", T0, ids())
        assertNotNull(Requests.withdraw(answered(talk), talk.id, T0))
    }

    @Test
    fun `every kind carries withdrawn_at once taken back`() {
        val kinds = listOf(
            chat,
            Requests.moreTime(emptyList(), "limit-games", 15, null, null, null, T0, T0, ids()),
            Requests.agreement(emptyList(), 1, WireAgreementAnswer.TALK, null, T0, ids()),
            Requests.help(null, false, T0, ids()),
            Requests.talk("Hi", T0, ids())!!,
        )
        for (request in kinds) {
            assertFalse("withdrawn_at" in wire(request).keys)
            assertTrue("withdrawn_at" in wire(request.copy(withdrawnAt = T0 + 1)).keys, "${request.kind}")
        }
    }

    @Test
    fun `a parent seeing a help request shows`() {
        val help = Requests.help(null, false, T0, ids())
        val policy = WirePolicy(
            version = 3,
            helpSeen = listOf(WireHelpSeen(help.id, T0 + 2 * HOUR, "Sam"), WireHelpSeen(help.id, T0 + HOUR, "Alex")),
        )
        val seen = answered(help, policy = policy).single().seen
        assertEquals(WireHelpSeen(help.id, T0 + HOUR, "Alex"), seen, "the first parent who saw it")
        assertNull(answered(chat, policy = policy).single().seen)
    }
}
