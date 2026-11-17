package family.brooker.belay.core

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
            "Whether the SIM card was changed, how many other users or profiles are on the phone, " +
                "and which settings something other than Belay has locked (not the phone number, " +
                "and nothing about what's on them)",
            "How an update of Belay that your parent chose is going, when the recovery key was " +
                "last used, and whether Belay did what your parent asked, like removing another user",
        ),
    )

    /** Phase 2: what the kid asks a parent for, from Belay's screen; Phase 3 adds more time and the agreement. */
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
        ),
    )

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
}
