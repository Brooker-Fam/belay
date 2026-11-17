package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SensitivePermissionsTest {
    @Test
    fun `granted runtime permissions map to categories, in display order, once each`() {
        val held = SensitivePermissions.held(
            listOf(
                "android.permission.ACCESS_FINE_LOCATION",
                "android.permission.ACCESS_COARSE_LOCATION",
                "android.permission.CAMERA",
                "android.permission.INTERNET",
                "android.permission.READ_MEDIA_IMAGES",
            ),
        )
        assertEquals(listOf("camera", "location", "photos_media"), held)
    }

    @Test
    fun `special access counts too`() {
        val held = SensitivePermissions.held(emptyList(), notificationListener = true, accessibilityService = true, deviceAdmin = true)
        assertEquals(listOf("notification_access", "accessibility", "device_admin"), held)
    }

    @Test
    fun `ordinary permissions are not sensitive`() {
        assertTrue(SensitivePermissions.held(listOf("android.permission.INTERNET", "android.permission.VIBRATE")).isEmpty())
    }

    @Test
    fun `packages are read from Android's component lists`() {
        assertEquals(
            setOf("com.example.watch", "org.example.helper"),
            SensitivePermissions.packagesInComponentList("com.example.watch/.Listener:org.example.helper/org.example.helper.Svc:"),
        )
        assertTrue(SensitivePermissions.packagesInComponentList(null).isEmpty())
    }
}
