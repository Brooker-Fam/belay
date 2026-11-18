package family.brooker.belay.core

/**
 * What the parents' AI app can always read about this phone, whatever categories a parent lets it
 * read (the policy's `ai_reads`): docs/mcp.md's "Always included", one entry per item there (the
 * sixth review's G4). The kid's "What your parent can see" lists these words while the phone is
 * connected, so it never says the AI app reads less than it does: with every category off, it
 * still reads the phone's status and problems (the restart note among them), when it last checked
 * in, the rules, and how the last screen lock went. AiAlwaysTest holds docs/mcp.md's list to this one.
 * Nothing about caregivers (Phase 12): an AI app reads none of it (a caregiver's pause reads like
 * any other), so their cards, after this list, are what the kid reads about them.
 */
object AiAlways {
    /** One thing always read: [docLabel] is its bold label in docs/mcp.md's list; [words], for the kid. */
    data class Item(val docLabel: String, val words: String)

    val ITEMS: List<Item> = listOf(
        // "When it last connected", as a caregiver's card says it (DataCategories.caregiver).
        Item(
            "The phone",
            "This phone's name, whether it's OK, the problems Belay tells your parent about (like that " +
                "the phone stayed locked a long time after it restarted), and when it last connected",
        ),
        Item(
            "Its rules",
            "Your parent's rules for this phone, like which settings are locked, the website filter " +
                "and whether the phone is paused",
        ),
        Item(
            "Screen time's rules",
            "Your time limits and schedules, extra time you got today, and whether the last screen " +
                "lock your parent sent worked",
        ),
        // Only what's always read: where the phone is, and calls, are each category's (listed above them).
        Item("Location's", "Whether this phone shares where it is, how often, and whether it's in lost mode"),
        Item("Calls'", "Whether calls are on, the call rules, and your contacts' names"),
    )
}
