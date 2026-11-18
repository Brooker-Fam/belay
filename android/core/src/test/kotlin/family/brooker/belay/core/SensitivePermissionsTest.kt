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
    fun `write secure settings, which adb can grant to any app that asks, is reported`() {
        val held = SensitivePermissions.held(listOf("android.permission.WRITE_SECURE_SETTINGS", "android.permission.CAMERA"), deviceAdmin = true)
        assertEquals(listOf("camera", "device_admin", "secure_settings"), held)
        assertEquals("secure_settings", SensitivePermissions.categories.last())
        // Asked for and not granted isn't held: the reader passes only granted ones.
        assertTrue(SensitivePermissions.held(listOf("android.permission.WRITE_SETTINGS")).isEmpty())
    }

    @Test
    fun `changing the call log is call history, as reading it is`() {
        // An app holding WRITE_CALL_LOG alone can add a made-up call to 988 that Belay's read after a
        // restart takes for a real one (the fifth review's plausible P2): a parent deciding on it sees it.
        assertEquals(listOf("call_log"), SensitivePermissions.held(listOf("android.permission.WRITE_CALL_LOG")))
        assertEquals(listOf("call_log"), SensitivePermissions.held(listOf("android.permission.READ_CALL_LOG", "android.permission.WRITE_CALL_LOG")))
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
