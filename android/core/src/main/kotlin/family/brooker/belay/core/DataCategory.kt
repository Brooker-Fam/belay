package family.brooker.belay.core

import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.WireLocation
import family.brooker.belay.core.location.WireLocationMode
import family.brooker.belay.core.location.WireLocationProvider

/**
 * A kind of data the agent collects. The kid-facing list "What your parent can see" is
 * built from the categories of the collectors that actually run, so it can't drift from
 * what is collected. The same ids become the AI data scopes on the server.
 */
data class DataCategory(
    val id: String,
    /** Plain words for a 12-year-old. */
    val title: String,
    val details: List<String>,
)

object DataCategories {
    val APPS = DataCategory(
        id = "apps",
        title = "The apps on this phone",
        details = listOf(
            "Each app's name, version and kind (like game or social), when it was installed " +
                "or last updated, and whether it came with the phone",
            "Where each app came from, like the Play Store or a computer",
            // SensitivePermissions.categories, in words.
            "What each app is allowed to use: the camera, microphone, location, contacts, " +
                "texts, call history, photos and media, or nearby devices, and whether it can " +
                "read notifications, use accessibility controls or act as a device admin",
            "When an app is installed, updated or removed",
        ),
    )

    val DEVICE_STATUS = DataCategory(
        id = "device_status",
        title = "How Belay and the phone are doing",
        details = listOf(
            "The phone's model, Android version and security update date, and Belay's version " +
                "and which key it's signed with",
            "Whether Belay is still set up and has the permissions it needs",
            "When the phone last restarted, and how many times it has started",
            "The battery level and whether it's charging, and how much storage is free",
            "The phone's time zone, and its clock, to check that the time is right",
            "Which of your parent's rules Belay is using, how many apps it's holding back, " +
                "which apps it never blocks (like the phone and texting apps), and anything it couldn't do",
            "Whether Belay is the phone's calling app, when your parent turned calls on",
            "Whether the SIM card was changed, how many other users or profiles are on the phone, " +
                "and which settings something other than Belay has locked (not the phone number, " +
                "and nothing about what's on them)",
            "How an update of Belay that your parent chose is going, when the recovery key was " +
                "last used, and whether Belay did what your parent asked, like removing another user",
        ),
    )

    /**
     * Phase 2: what the kid asks a parent for, from Belay's screen; Phase 3 adds more time and the
     * agreement; Phase 7 "I need help" (with where the phone is, only when the kid shares it),
     * "Talk to my parent", and changing or taking back a request.
     */
    val REQUESTS = DataCategory(
        id = "requests",
        title = "What you ask for, and what you write about why",
        details = listOf(
            "Which apps you ask your parent for, and when. When a new app waits for your " +
                "parent, Belay asks for it right away.",
            "What you write in \"Why I want it\", if you write something",
            "When you ask for more time: how many minutes, for which time limit and app, and " +
                "what you write about why",
            "Your answer to your family agreement, and what you write with it",
            "When you tap \"I need help\": that you need help, what you write with it, and where " +
                "this phone is, only if you choose to share it",
            "What you write in \"Talk to my parent\"",
            "When you ask to add a contact: the name and number you give, and what you write about why",
            "When you change what you wrote, or take a request back",
        ),
    )

    /** Phase 5: the calls category's id, which is also the server's AI scope. */
    const val CALLS_ID = "calls"

    /**
     * Phase 5, while the policy's calls has `log` on: the call records Belay sends
     * (POST /api/v1/calls). Calls with 911, Android's emergency numbers, 988 and the family's
     * private numbers are never recorded or sent (core's CallRecords).
     */
    val CALLS = DataCategory(
        id = CALLS_ID,
        title = "Your calls",
        details = listOf(
            "Who you call and who calls you, when, and for how long: the contact's name, or the " +
                "number of someone who isn't one of your contacts",
            "Calls Belay didn't let through, and why, like a number that isn't in your contacts",
            "Never what anyone says. Calls with 911, 988 and the numbers your parent made private " +
                "are never recorded or sent.",
        ),
    )

    /** Phase 4: the location category's id, which is also the server's AI scope. */
    const val LOCATION_ID = "location"

    /**
     * Phase 4, while the policy's location is on ([LocationRules.collecting]): where the phone is,
     * as the mode takes it. [clock] shows a policy's "HH:MM" the way the kid's phone shows times.
     */
    fun location(location: WireLocation, clock: (String) -> String): DataCategory {
        val details = mutableListOf<String>()
        val checks = "Where this phone is when your parent checks. You get a notification every time."
        when (location.mode) {
            WireLocationMode.OFF -> {}
            WireLocationMode.ON_DEMAND -> details += checks
            WireLocationMode.PERIODIC -> {
                val every = LocationRules.everyMinutes(location)
                val hours = location.hours
                details += if (hours == null || hours.start == hours.end) {
                    "Where this phone is, every $every minutes, all day"
                } else {
                    "Where this phone is, every $every minutes, between ${clock(hours.start)} and ${clock(hours.end)}"
                }
                val names = LocationRules.places(location).map { it.name.trim() }.filter { it.isNotEmpty() }
                if (names.isNotEmpty()) details += "When you arrive at or leave: ${list(names)}"
                details += checks
            }
        }
        if (location.lost != null) {
            details += "Lost mode: where this phone is every 5 minutes, until your parent turns lost mode off"
        }
        val source = when {
            location.provider == WireLocationProvider.FUSED -> "Android's location service"
            location.fallbackFused -> "the phone's GPS or Android's location service"
            else -> "the phone's GPS"
        }
        details += "How close each check is (like \"within 20 meters\"), that it came from $source, " +
            "and whether an app was faking the location"
        details += "Whether location is on, and whether Belay can use it"
        details += "Where this phone is when you choose to share it with \"I need help\""
        return DataCategory(LOCATION_ID, "Where this phone is", details)
    }

    /** "a", "a and b", "a, b and c". */
    private fun list(parts: List<String>): String = when (parts.size) {
        0 -> ""
        1 -> parts.single()
        else -> parts.dropLast(1).joinToString(", ") + " and " + parts.last()
    }

    /**
     * Phase 3, while the policy's screen_time measures (`measure` on): the usage days Belay
     * sends (POST /api/v1/usage) and the minutes in its report. Its id is the server's AI scope.
     */
    val SCREEN_TIME = DataCategory(
        id = "screen_time",
        title = "How long you use apps",
        details = listOf(
            "How many minutes each app is on your screen each day, and how many times you open it " +
                "(not the phone app, your texting app or the other apps that always work)",
            "How long the screen is on in each hour, and how many times you unlock the phone",
            "When Belay couldn't count, like when usage access was off",
            "How many minutes are used and left on each of your time limits, and when you take " +
                "extra minutes yourself",
        ),
    )

    /**
     * Phase 3, while the policy has screen_time but doesn't measure: Belay counts on the phone to
     * keep the limits, and reports only where each one stands.
     */
    val SCREEN_TIME_LIMITS = DataCategory(
        id = "screen_time",
        title = "Whether your time limits are used up",
        details = listOf(
            "Belay counts how long you use apps, on this phone, to keep your time limits. It " +
                "doesn't send the minutes.",
            "Whether each time limit is open, used up or running on extra time today, and which " +
                "schedule is on",
            "When you take extra minutes yourself, and whether Belay can count (usage access is on)",
        ),
    )

    /** What screen time collects under a policy that [measures] or doesn't. */
    fun screenTime(measures: Boolean): DataCategory = if (measures) SCREEN_TIME else SCREEN_TIME_LIMITS

    /** Phase 3: the network category's id, which is also the server's AI scope. */
    const val NETWORK_ID = "network"

    /**
     * Phase 3, while the policy's `network_log` is on: the domains each app looks up, per day, that
     * Belay sends (POST /api/v1/network), reduced on the phone to counts (core's NetworkDigest).
     */
    val NETWORK = DataCategory(
        id = NETWORK_ID,
        title = "Which websites and services apps look up, per day",
        details = listOf(
            "The names of the websites and online services each app looks up, like example.com, and how " +
                "many times a day. Not the pages, messages, searches or anything you type.",
            "Not what the phone app, your texting app or the other apps that always work look up, and " +
                "never 988's websites",
        ),
    )
}
