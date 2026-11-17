package family.brooker.belay.core.calls

import family.brooker.belay.core.WireLimits
import family.brooker.belay.core.WireParentNumber
import family.brooker.belay.core.WirePolicy

/**
 * The approved contacts from the policy (docs/protocol.md, Policy `contacts`). They live in the
 * policy and Belay's own storage only; Belay never writes them into Android's Contacts. Names are
 * the family's words, shown as plain text.
 */
object CallContacts {
    /** The contacts as the phone uses them: at most 500, ids unique (the first counts), names trimmed and capped. */
    fun of(policy: WirePolicy?): List<WireContact> =
        policy?.contacts.orEmpty()
            .distinctBy { it.id }
            .take(CallsWireLimits.MAX_CONTACTS)
            .map { contact ->
                contact.copy(
                    name = contact.name.trim().take(CallsWireLimits.MAX_CONTACT_NAME),
                    numbers = contact.numbers.mapNotNull(PhoneNumbers::e164).distinct().take(CallsWireLimits.MAX_NUMBERS_PER_CONTACT),
                )
            }

    /** The contact one of whose numbers is [number] (as PhoneNumbers.key makes it); the first in the list wins. */
    fun find(number: String?, contacts: List<WireContact>): WireContact? {
        val key = PhoneNumbers.key(number) ?: return null
        return contacts.firstOrNull { contact -> contact.numbers.any { PhoneNumbers.key(it) == key } }
    }

    /** Contacts the kid can call: with `calls` on, or a parent, and a number. Parents first, then by name. */
    fun callable(contacts: List<WireContact>): List<WireContact> =
        contacts.filter { (it.calls || it.parent) && it.numbers.isNotEmpty() }
            .sortedWith(compareBy<WireContact> { !it.parent }.thenBy { it.name.lowercase() })

    /**
     * The emergency card's people (Phase 7): the `parent` contacts, each with its first number, else
     * the policy's `parent_numbers`; at most 4, names at most 40 characters.
     */
    fun emergencyCard(policy: WirePolicy?): List<WireParentNumber> {
        val parents = of(policy).filter { it.parent && it.numbers.isNotEmpty() }
            .map { WireParentNumber(it.name.take(WireLimits.MAX_PARENT_NAME), it.numbers.first()) }
        val numbers = parents.ifEmpty { policy?.parentNumbers.orEmpty() }
        return numbers.filter { it.number.isNotBlank() }.take(WireLimits.MAX_PARENT_NUMBERS)
    }

    /** The policy's blocked numbers, as Belay compares them; never an always-allowed number. */
    fun blocked(policy: WirePolicy?, android: EmergencyNumbers): Set<String> =
        policy?.blockedNumbers.orEmpty()
            .take(CallsWireLimits.MAX_BLOCKED_NUMBERS)
            .mapNotNullTo(LinkedHashSet()) { PhoneNumbers.e164(it) }
            .filterTo(LinkedHashSet()) { !AlwaysAllowed.allows(it, android) }

    /** The policy's private numbers (never recorded or read), as Belay compares them. */
    fun private(policy: WirePolicy?): Set<String> =
        policy?.privateNumbers.orEmpty().take(CallsWireLimits.MAX_PRIVATE_NUMBERS).mapNotNullTo(HashSet()) { PhoneNumbers.e164(it) }
}
