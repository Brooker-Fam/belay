package family.brooker.belay.core

/**
 * A kind of data the agent collects. The kid-facing list "What your parent can see" is
 * built from the categories of the collectors that actually run, so it can't drift from
 * what is collected. The same ids become the AI data scopes on the server (Phase 1).
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
            "Each app's name and version, and when it was installed or last updated",
            "Where each app came from, like the Play Store or a computer",
            "When an app is installed, updated or removed",
        ),
    )

    val DEVICE_STATUS = DataCategory(
        id = "device_status",
        title = "How Belay and the phone are doing",
        details = listOf(
            "The phone's model, Android version and security update date",
            "Whether Belay is still set up and has the permissions it needs",
            "When the phone last restarted",
        ),
    )
}
