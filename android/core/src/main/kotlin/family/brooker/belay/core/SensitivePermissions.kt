package family.brooker.belay.core

/**
 * The sensitive permissions an app can hold, grouped the way a parent thinks about them.
 * These are what make an AI review of an app useful ("why does a flashlight want the
 * microphone?"). The agent reports the categories an app currently holds.
 */
object SensitivePermissions {
    const val CAMERA = "camera"
    const val MICROPHONE = "microphone"
    const val LOCATION = "location"
    const val CONTACTS = "contacts"
    const val SMS = "sms"
    const val CALL_LOG = "call_log"
    const val PHOTOS_MEDIA = "photos_media"
    const val NEARBY_DEVICES = "nearby_devices"

    // Special access, granted in Settings rather than by a runtime permission dialog.
    const val NOTIFICATION_ACCESS = "notification_access"
    const val ACCESSIBILITY = "accessibility"
    const val DEVICE_ADMIN = "device_admin"

    /**
     * WRITE_SECURE_SETTINGS: changes Android's protected settings, and reaches what only the adb
     * shell should (Belay's enrollment receiver among them). Android's own apps hold it; any other
     * app only once someone granted it over adb (`pm grant`, its "development" protection level),
     * and it keeps it after the debugging lock (platform notes T21).
     */
    const val SECURE_SETTINGS = "secure_settings"

    /** Every category, in the order they are shown. */
    val categories: List<String> = listOf(
        CAMERA, MICROPHONE, LOCATION, CONTACTS, SMS, CALL_LOG, PHOTOS_MEDIA, NEARBY_DEVICES,
        NOTIFICATION_ACCESS, ACCESSIBILITY, DEVICE_ADMIN, SECURE_SETTINGS,
    )

    private const val P = "android.permission."

    /** Runtime permissions (and WRITE_SECURE_SETTINGS), by category. */
    val runtime: Map<String, String> = buildMap {
        put(P + "CAMERA", CAMERA)
        put(P + "RECORD_AUDIO", MICROPHONE)
        listOf("ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION")
            .forEach { put(P + it, LOCATION) }
        listOf("READ_CONTACTS", "WRITE_CONTACTS").forEach { put(P + it, CONTACTS) }
        listOf("READ_SMS", "SEND_SMS", "RECEIVE_SMS", "RECEIVE_MMS", "RECEIVE_WAP_PUSH")
            .forEach { put(P + it, SMS) }
        listOf("READ_CALL_LOG", "WRITE_CALL_LOG", "PROCESS_OUTGOING_CALLS").forEach { put(P + it, CALL_LOG) }
        listOf(
            "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "READ_MEDIA_VISUAL_USER_SELECTED",
            "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "ACCESS_MEDIA_LOCATION",
        ).forEach { put(P + it, PHOTOS_MEDIA) }
        listOf(
            "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "BLUETOOTH_ADVERTISE", "NEARBY_WIFI_DEVICES",
            "UWB_RANGING", "ACCESS_LOCAL_NETWORK",
        ).forEach { put(P + it, NEARBY_DEVICES) }
        // Not a runtime permission, but granted the same way when adb grants it (pm grant).
        put(P + "WRITE_SECURE_SETTINGS", SECURE_SETTINGS)
    }

    /**
     * The categories an app holds: from its granted runtime permissions, and from the
     * special access it has (enabled notification listener or accessibility service,
     * active device admin). Sorted in [categories] order, without duplicates.
     */
    fun held(
        grantedPermissions: Collection<String>,
        notificationListener: Boolean = false,
        accessibilityService: Boolean = false,
        deviceAdmin: Boolean = false,
    ): List<String> {
        val found = grantedPermissions.mapNotNullTo(HashSet()) { runtime[it] }
        if (notificationListener) found += NOTIFICATION_ACCESS
        if (accessibilityService) found += ACCESSIBILITY
        if (deviceAdmin) found += DEVICE_ADMIN
        return categories.filter { it in found }
    }

    /**
     * Packages named in a colon-separated list of flattened component names, as Android
     * stores enabled notification listeners and accessibility services
     * ("com.example/.Listener:org.example/org.example.Service").
     */
    fun packagesInComponentList(value: String?): Set<String> =
        value.orEmpty().split(':')
            .mapNotNullTo(HashSet()) { it.substringBefore('/').trim().takeIf { name -> name.isNotEmpty() } }
}
