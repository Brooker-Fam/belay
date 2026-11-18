package family.brooker.belay.core.mobiledata

import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.Protection
import kotlinx.serialization.Serializable

/**
 * Phase 13's Wi-Fi-only apps (docs/design/phase13-mobile-data.md): the policy's
 * `mobile_data.wifi_only`, kept off every metered network by Android's own per-app restriction
 * (DevicePolicyManager.setMeteredDataDisabledPackages, device owner only: platform notes Q1, Q2).
 * Pure: :app reads the phone and applies what this decides.
 *
 * Never restricted, whatever the policy says: every package Belay never blocks ([Protection]:
 * Belay, the phone and texting apps, emergency apps, the keyboard, the home screen, Settings and
 * Android's own packages, Carrier Services and Play services among them), so calls, texts (RCS
 * needs data), 911 and 988 always work; and any package that shares its uid with another, since
 * Android restricts by uid and would cut the others off too (Q8). Android itself refuses Belay
 * (an admin), and a package that isn't installed or that Belay hid; Belay doesn't ask for those.
 */
object WifiOnly {
    /** Why a package the policy lists isn't asked of Android. */
    enum class Skip {
        /** Not on the phone: it's restricted once it's installed (the next step asks for it). */
        NOT_INSTALLED,

        /** Blocked: Belay hid it, and Android refuses a hidden app (Q1). It's restricted if it's unblocked. */
        BLOCKED,

        /** One of the packages Belay never blocks. */
        NEVER,

        /** It shares its uid with other packages (Q8). */
        SHARED_UID,
    }

    /** What PackageManager says of a package's network identity: its uid, and whether others share it. */
    data class Identity(val uid: Int, val shared: Boolean)

    data class Plan(
        /** The packages to keep off mobile data now, sorted. */
        val wanted: List<String>,
        /** Each wanted package's uid, as PackageManager has it now. */
        val uids: Map<String, Int>,
        /** The policy's other packages, and why each isn't asked for. */
        val skipped: Map<String, Skip>,
        /** In the parent's words, for the enforcement report: the packages that can't be Wi-Fi only. */
        val problems: List<String>,
    )

    /** What Belay last asked of Android, and what Android said it couldn't restrict. Stored. */
    @Serializable
    data class Applied(
        /** Sorted. */
        val asked: List<String> = emptyList(),
        /** Their uids when Belay asked: Android resolves a package to its uid only then (Q2). */
        val uids: Map<String, Int> = emptyMap(),
        val refused: List<String> = emptyList(),
    )

    /**
     * The plan for the policy's [wifiOnly] list. [apps] is the inventory (hidden apps included),
     * [hidden] what Belay hid, [protected] NeverBlocked.of's map, [identities] PackageManager's uid
     * for each listed package that's installed (a package missing from it counts as not installed).
     */
    fun plan(
        wifiOnly: List<String>,
        apps: Map<String, PackageRecord>,
        hidden: Set<String>,
        protected: Map<String, Protection>,
        identities: Map<String, Identity>,
    ): Plan {
        val wanted = sortedSetOf<String>()
        val uids = sortedMapOf<String, Int>()
        val skipped = sortedMapOf<String, Skip>()
        val problems = mutableListOf<String>()
        for (name in listed(wifiOnly)) {
            val why = protected[name]
            val identity = identities[name]
            when {
                why != null -> {
                    skipped[name] = Skip.NEVER
                    // Only about an app on the phone: the server refuses the well-known ones up front.
                    if (name in apps) problems += "$name can't be Wi-Fi only: ${why.words}."
                }
                name !in apps || identity == null -> skipped[name] = Skip.NOT_INSTALLED
                name in hidden -> skipped[name] = Skip.BLOCKED
                identity.shared -> {
                    skipped[name] = Skip.SHARED_UID
                    problems += "$name can't be Wi-Fi only: it shares its connection with other parts of the phone, " +
                        "which would lose mobile data too."
                }
                else -> {
                    wanted += name
                    uids[name] = identity.uid
                }
            }
        }
        return Plan(wanted.toList(), uids, skipped, problems)
    }

    /**
     * The list to give Android now, or null when there's nothing to do: what Belay wants differs
     * from what it last asked, an app on it has a new uid (installed again), or Android's own list
     * ([android], getMeteredDataDisabledPackages) isn't what that ask left. A package Android refused
     * isn't asked for again until something changes, so a refusal doesn't become a call at every
     * step. [android] null: Belay can't read it (not device owner), so it changes nothing either.
     */
    fun call(plan: Plan, applied: Applied, android: List<String>?): List<String>? {
        if (android == null) return null
        val same = plan.wanted == applied.asked && plan.uids == applied.uids
        val holds = android.toSet() == (applied.asked - applied.refused.toSet()).toSet()
        return if (same && holds) null else plan.wanted
    }

    /** After a call with [asked]: what to keep, with Android's answer ([refused]). */
    fun asked(plan: Plan, asked: List<String>, refused: List<String>): Applied =
        Applied(asked = asked, uids = plan.uids.filterKeys { it in asked }.toSortedMap(), refused = refused.filter { it in asked }.distinct().sorted())

    /**
     * The parent's words for the packages Android refused, by package name, as Phase 2's problems
     * name apps (a label is its developer's words).
     */
    fun refusedProblems(refused: List<String>): List<String> =
        refused.distinct().sorted().map { "Android didn't keep $it off mobile data." }

    /**
     * The report (`enforcement.mobile_data`): what Android restricts for Belay now ([android]),
     * sorted, at most 100; null while the policy lists nothing and Android has nothing.
     */
    fun report(wifiOnly: List<String>, android: List<String>?): WireMobileDataStatus? {
        val held = android.orEmpty().distinct().sorted().take(MobileDataWireLimits.MAX_WIFI_ONLY)
        if (listed(wifiOnly).isEmpty() && held.isEmpty()) return null
        return WireMobileDataStatus(held)
    }

    /**
     * What the kid's screens list as Wi-Fi only: what Android restricts for Belay now and the
     * policy asks for, never more ([report]'s list, as the last step left it).
     */
    fun forKid(wifiOnly: List<String>, report: WireMobileDataStatus?): List<String> {
        val listed = listed(wifiOnly).toSet()
        return report?.wifiOnly.orEmpty().filter { it in listed }.distinct().sorted()
    }

    /** The policy's list as Belay reads it: package names only, each once, at most 100. */
    fun listed(wifiOnly: List<String>): List<String> =
        wifiOnly.map { it.trim() }.filter { PACKAGE.matches(it) }.distinct().take(MobileDataWireLimits.MAX_WIFI_ONLY)

    /** A Java-style package name, as the server checks it (`packageName` in schemas.ts). */
    private val PACKAGE = Regex("^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$")
}
