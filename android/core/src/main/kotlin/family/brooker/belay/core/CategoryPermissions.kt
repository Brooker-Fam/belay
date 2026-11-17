package family.brooker.belay.core

import family.brooker.belay.core.location.LocationRules

/**
 * Which of Belay's runtime permissions it holds, by policy (DevicePolicyManager.setPermissionGrantState
 * on itself, as device owner; docs/platform-notes.md R2 and L1). Phase 4's rule: a permission tied
 * to a data category is granted by policy only while the policy turns that category on, and denied
 * by policy otherwise, so Settings shows Belay without it and the kid can't grant it either. The
 * same rule will cover Phase 5's call and text permissions. Every other runtime permission Belay
 * declares is granted, as before (POST_NOTIFICATIONS, ACCESS_LOCAL_NETWORK), except CAMERA, which
 * is never granted by policy (enroll/CameraGate.kt).
 */
object CategoryPermissions {
    const val CAMERA = "android.permission.CAMERA"
    const val FINE_LOCATION = "android.permission.ACCESS_FINE_LOCATION"
    const val COARSE_LOCATION = "android.permission.ACCESS_COARSE_LOCATION"
    const val BACKGROUND_LOCATION = "android.permission.ACCESS_BACKGROUND_LOCATION"

    /** The data category each such permission belongs to (DataCategory ids). */
    val CATEGORY: Map<String, String> = mapOf(
        FINE_LOCATION to DataCategories.LOCATION_ID,
        COARSE_LOCATION to DataCategories.LOCATION_ID,
        BACKGROUND_LOCATION to DataCategories.LOCATION_ID,
    )

    /** Never granted by policy: the camera, only for the enrollment QR code (CameraGate). */
    val NEVER_GRANTED: Set<String> = setOf(CAMERA)

    /** What to set: grants in an order Android takes (foreground location before background), denies the other way round. */
    data class Plan(val grant: List<String>, val deny: List<String>)

    /**
     * The categories that need a permission now: location while the family has a mode on or the
     * phone is in lost mode ([LocationRules.collecting]), or while [helpFix] (the one fix a kid
     * chose to share with a help request, even with location off).
     */
    fun categoriesOn(policy: WirePolicy?, helpFix: Boolean): Set<String> =
        if (LocationRules.collecting(policy?.location) || helpFix) setOf(DataCategories.LOCATION_ID) else emptySet()

    /**
     * For each of [declared] (Belay's runtime permissions): granted unless it's tied to a category
     * that isn't in [on] (denied), or never granted (left to its own gate). CAMERA is denied here
     * unless [cameraInUse], while the enrollment screen scans.
     */
    fun plan(declared: Collection<String>, on: Set<String>, cameraInUse: Boolean): Plan {
        val grant = mutableListOf<String>()
        val deny = mutableListOf<String>()
        for (permission in declared.distinct()) {
            val category = CATEGORY[permission]
            when {
                permission in NEVER_GRANTED -> if (permission == CAMERA && !cameraInUse) deny += permission
                category == null || category in on -> grant += permission
                else -> deny += permission
            }
        }
        // ACCESS_BACKGROUND_LOCATION only takes effect with a foreground location permission.
        return Plan(
            grant = grant.sortedBy { if (it == BACKGROUND_LOCATION) 1 else 0 },
            deny = deny.sortedBy { if (it == BACKGROUND_LOCATION) 0 else 1 },
        )
    }

    /** Whether [permission] is tied to a data category (and so may be denied when it's off). */
    fun tied(permission: String): Boolean = permission in CATEGORY
}
