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

    /** Phase 2: what the kid asks a parent for, from Belay's screen. */
    val REQUESTS = DataCategory(
        id = "requests",
        title = "What you ask for, and what you write about why",
        details = listOf(
            "Which apps you ask your parent for, and when. When a new app waits for your " +
                "parent, Belay asks for it right away.",
            "What you write in \"Why I want it\", if you write something",
        ),
    )
}
