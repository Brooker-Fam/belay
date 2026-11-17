package family.brooker.belay.core.calls

import family.brooker.belay.core.WireParentNumber
import family.brooker.belay.core.WirePolicy
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Made-up names and numbers only. */
class CallContactsTest {
    private val android = EmergencyNumbers { it == "911" }
    private val mom = WireContact("c-mom", "  Mom  ", listOf("+15555550100", "+15555550102"), parent = true)
    private val sam = WireContact("c-sam", "Sam", listOf("+1 555 555 0123"))
    private val riley = WireContact("c-riley", "Riley", listOf("+15555550124"), calls = false)
    private val noNumber = WireContact("c-empty", "Nobody", emptyList(), parent = true)

    private fun policy(vararg contacts: WireContact, parentNumbers: List<WireParentNumber> = emptyList()) =
        WirePolicy(version = 1, contacts = contacts.toList(), parentNumbers = parentNumbers)

    @Test
    fun `contacts are tidied, unique ids, trimmed names, E164 numbers`() {
        val tidy = CallContacts.of(policy(mom, sam, sam.copy(name = "Sam again"), WireContact("c-x", "X".repeat(80), listOf("not a number"))))
        assertEquals(listOf("c-mom", "c-sam", "c-x"), tidy.map { it.id })
        assertEquals("Mom", tidy[0].name)
        assertEquals(listOf("+15555550123"), tidy[1].numbers)
        assertEquals(CallsWireLimits.MAX_CONTACT_NAME, tidy[2].name.length)
        assertEquals(emptyList(), tidy[2].numbers)
    }

    @Test
    fun `a contact is found by any of its numbers, exactly`() {
        val contacts = CallContacts.of(policy(mom, sam, riley))
        assertEquals("c-mom", CallContacts.find("+15555550102", contacts)?.id)
        assertEquals("c-sam", CallContacts.find("+1 (555) 555-0123", contacts)?.id)
        // The national form doesn't match: the phone makes E.164 with Android's formatter first.
        assertNull(CallContacts.find("5555550123", contacts))
        assertNull(CallContacts.find("+15555550199", contacts))
        assertNull(CallContacts.find(null, contacts))
    }

    @Test
    fun `the kid can call parents and contacts with calls, parents first`() {
        val callable = CallContacts.callable(CallContacts.of(policy(sam, riley, mom, noNumber)))
        assertEquals(listOf("c-mom", "c-sam"), callable.map { it.id })
    }

    @Test
    fun `the emergency card lists parent contacts, else the parent numbers`() {
        assertEquals(listOf(WireParentNumber("Mom", "+15555550100")), CallContacts.emergencyCard(policy(mom, sam, noNumber)))
        val numbers = listOf(WireParentNumber("Grandma", "+15555550140"))
        assertEquals(numbers, CallContacts.emergencyCard(policy(sam, noNumber, parentNumbers = numbers)))
        assertEquals(numbers, CallContacts.emergencyCard(policy(parentNumbers = numbers)))
        val five = (1..5).map { WireContact("c-p$it", "Parent $it", listOf("+1555555011$it"), parent = true) }
        assertEquals(4, CallContacts.emergencyCard(policy(*five.toTypedArray())).size)
        assertEquals(emptyList(), CallContacts.emergencyCard(null))
    }

    @Test
    fun `blocked and private numbers are read as E164, and an always-allowed number is never blocked`() {
        val policy = WirePolicy(version = 1, blockedNumbers = listOf("+15555550177", "+1 555 555 0178", "911", "junk"), privateNumbers = listOf("+15555550150"))
        assertEquals(setOf("+15555550177", "+15555550178"), CallContacts.blocked(policy, android))
        val emergencyE164 = EmergencyNumbers { it == "+15555550177" }
        assertEquals(setOf("+15555550178"), CallContacts.blocked(policy, emergencyE164))
        assertEquals(setOf("+15555550150"), CallContacts.private(policy))
    }
}
