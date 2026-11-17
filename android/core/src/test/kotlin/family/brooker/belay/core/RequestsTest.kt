package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.HOUR
import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import family.brooker.belay.core.Fixtures.ids
import family.brooker.belay.core.Fixtures.inventory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Made-up apps and words only. */
class RequestsTest {
    private val chat = KidRequest("request-1", "com.example.chat", "Chatter Box", null, T0)

    private fun answer(status: WireRequestStatus, id: String = chat.id) =
        WireRequestAnswer(id, status, note = "Let's look at it together", answeredAt = T0 + HOUR, answeredBy = "Sam")

    private fun policyWith(vararg answers: WireRequestAnswer) = WirePolicy(version = 3, requests = answers.toList())

    /** Every app here was installed just before [T0]. */
    private val installedBeforeT0: (String) -> Long? = { T0 - 1000 }

    @Test
    fun `a waiting app without a request gets one at once, and only once`() {
        val waiting = listOf("com.example.chat", "com.example.game")
        assertEquals(listOf("com.example.game"), Requests.toMake(waiting, listOf(chat), installedBeforeT0))
        assertEquals(
            emptyList(),
            Requests.toMake(waiting, listOf(chat, chat.copy(id = "request-2", packageName = "com.example.game")), installedBeforeT0),
        )
    }

    @Test
    fun `an answered request isn't made again by itself`() {
        // Declined, but not blocked: the app still waits, and the kid sees the answer.
        assertEquals(emptyList(), Requests.toMake(listOf(chat.packageName), listOf(chat), installedBeforeT0))
    }

    @Test
    fun `an app removed and installed again is asked for again`() {
        assertEquals(listOf(chat.packageName), Requests.toMake(listOf(chat.packageName), listOf(chat)) { T0 + HOUR })
    }

    @Test
    fun `sending again before an answer updates the same request`() {
        for (policy in listOf(null, policyWith(answer(WireRequestStatus.PENDING)))) {
            val answered = Requests.answered(listOf(chat), policy)
            val sent = Requests.send(answered, chat.packageName, "Chatter Box", "  My friends use it  ", T0 + HOUR, ids())
            assertEquals(chat.id, sent.id)
            assertEquals("My friends use it", sent.reason)
            assertEquals(1, sent.revision)
            assertEquals(T0, sent.askedAt, "asked_at is when the kid first asked")
            assertTrue(Requests.itemId(sent) != Requests.itemId(chat), "each send is its own outbox item")
        }
    }

    @Test
    fun `after an answer, asking again is a new request`() {
        for (status in listOf(WireRequestStatus.APPROVED, WireRequestStatus.DECLINED, WireRequestStatus.TALK)) {
            val answered = Requests.answered(listOf(chat), policyWith(answer(status)))
            assertFalse(answered.single().open)
            val sent = Requests.send(answered, chat.packageName, "Chatter Box", "Please", T0 + 2 * HOUR, ids())
            assertEquals("id-1", sent.id, "$status")
            assertEquals(T0 + 2 * HOUR, sent.askedAt)
            assertEquals(0, sent.revision)
        }
    }

    @Test
    fun `the kid's words are trimmed and capped at 500 characters, and blank is none`() {
        assertEquals(WireLimits.MAX_REASON, Requests.cleanReason("x".repeat(600))!!.length)
        assertNull(Requests.cleanReason("   "))
        assertNull(Requests.cleanReason(null))
        val wire = Requests.toWire(chat.copy(reason = "y".repeat(700), label = "z".repeat(300)))
        assertEquals(WireLimits.MAX_REASON, wire.reason!!.length)
        assertEquals(WireLimits.MAX_LABEL, wire.label.length)
        assertEquals(WireRequestKind.APP, wire.kind)
        assertEquals(T0, wire.askedAt)
    }

    @Test
    fun `answers are matched to requests by id, newest first`() {
        val game = KidRequest("request-2", "com.example.game", "Block Builder", null, T0 + HOUR)
        val answered = Requests.answered(listOf(chat, game), policyWith(answer(WireRequestStatus.DECLINED)))
        assertEquals(listOf("request-2", "request-1"), answered.map { it.request.id })
        assertEquals(WireRequestStatus.DECLINED, answered[1].answer?.status)
        assertNull(answered[0].answer)
        assertEquals(game, Requests.open(answered, game.packageName)?.request)
        assertNull(Requests.open(answered, chat.packageName))
    }

    // Which policy the phone keeps.

    @Test
    fun `a newer policy replaces the stored one, and the same version doesn't`() {
        val stored = WirePolicy(version = 4)
        assertTrue(PolicyRules.replaces(null, null, WirePolicy(version = 0), sentAt = T0))
        assertTrue(PolicyRules.replaces(stored, T0, WirePolicy(version = 5), sentAt = T0 - HOUR))
        assertTrue(PolicyRules.replaces(stored, T0, WirePolicy(version = 5), sentAt = T0 + HOUR))
        assertFalse(PolicyRules.replaces(stored, T0, WirePolicy(version = 4), sentAt = T0 + HOUR))
    }

    @Test
    fun `a lower version counts too, unless its request crossed a newer answer`() {
        val stored = WirePolicy(version = 9)
        assertTrue(PolicyRules.replaces(stored, T0, WirePolicy(version = 2), sentAt = T0 + 1), "a server restored from a backup")
        assertFalse(PolicyRules.replaces(stored, T0, WirePolicy(version = 8), sentAt = T0 - 1), "a check-in sent before the long-poll's answer")
    }

    @Test
    fun `the long-poll backs off like the outbox, but never past five minutes, and honors Retry-After`() {
        assertEquals(30_000, PolicyRules.pollRetryMs(1, null, 1.0))
        assertEquals(PolicyRules.POLL_BACKOFF_MAX_MS, PolicyRules.pollRetryMs(20, null, 1.0))
        assertEquals(10 * 60 * 1000L, PolicyRules.pollRetryMs(1, 10 * 60 * 1000L, 0.0))
    }

    // The kid's view of the rules.

    @Test
    fun `the kid sees only what Belay applies, so a debug build never shows reset or debugging locks`() {
        val policy = WirePolicy(
            version = 2,
            apps = WireAppPolicy(WireNewApps.ASK),
            restrictions = WireRestrictions(safeBoot = true, factoryReset = true, debugging = true),
        )
        val roles = PhoneRoles(self = "family.example.belay")
        val installed = inventory(app("com.example.chat"))
        for (debug in listOf(true, false)) {
            val plan = Enforcement.plan(Enforcement.Input(policy, installed, roles, Applied(), debug, Enforcement.sdkFull(37), T0))
            val applied = Enforcement.after(Applied(), plan, Enforcement.changes(plan, Applied()), ApplyOutcome(), T0)
            val rules = KidRules.of(policy, plan, applied, privateDns = null)
            assertTrue(KidRules.Rule.NEW_APPS_WAIT in rules)
            assertTrue(KidRules.Rule.NO_SAFE_MODE in rules)
            assertEquals(!debug, KidRules.Rule.NO_FACTORY_RESET in rules)
            assertEquals(!debug, KidRules.Rule.NO_DEBUGGING in rules)
        }
    }

    @Test
    fun `repair mode shows while maintenance lifts debugging`() {
        val policy = WirePolicy(version = 2, restrictions = WireRestrictions(debugging = true), maintenanceUntil = T0 + HOUR)
        val plan = Enforcement.plan(Enforcement.Input(policy, emptyMap(), PhoneRoles("family.example.belay"), Applied(), false, Enforcement.sdkFull(37), T0))
        val applied = Enforcement.after(Applied(), plan, Enforcement.changes(plan, Applied()), ApplyOutcome(), T0)
        val rules = KidRules.of(policy, plan, applied, privateDns = null)
        assertTrue(KidRules.Rule.REPAIR_MODE in rules)
        assertFalse(KidRules.Rule.NO_DEBUGGING in rules)
    }

    @Test
    fun `no policy, no rules`() {
        assertEquals(emptyList(), KidRules.of(null, null, Applied(), null))
    }
}
