package family.brooker.belay.core

/** Phase 10: what remove_other_users found, in Belay's words for the parent. */
object OtherUsers {
    /**
     * [before]: users and profiles there were; [left]: still there afterwards; [refused]: how
     * many removeUser calls Android said no to; [error]: the exception one threw, if any.
     */
    fun removalProblem(before: Int, left: Int, refused: Int, error: String?): String? {
        if (left == 0) return null
        val what = if (before == 1) "the other user or profile" else "$left of the $before other users or profiles"
        val why = when {
            error != null -> ": $error"
            refused > 0 -> ". Something other than Belay may stop users from being removed."
            else -> "."
        }
        return "Android didn't remove $what$why".take(WireLimits.MAX_PROBLEM)
    }

    /**
     * The user restrictions in force ([inForce], UserManager.getUserRestrictions) that Belay
     * didn't set ([setByBelay], DevicePolicyManager.getUserRestrictions for its own admin):
     * health.foreign_restrictions, in name order, at most 20 keys of at most 64 characters.
     */
    fun foreignRestrictions(inForce: Set<String>, setByBelay: Set<String>): List<String> =
        (inForce - setByBelay)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { it.take(WireLimits.MAX_RESTRICTION_KEY) }
            .distinct()
            .sorted()
            .take(WireLimits.MAX_FOREIGN_RESTRICTIONS)
}
