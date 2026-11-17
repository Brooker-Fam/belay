package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.Fixtures.app
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProtocolTest {
    private fun fields(json: String): Set<String> = Json.parseToJsonElement(json).jsonObject.keys

    private val device = WireDevice(
        manufacturer = "Google", model = "Pixel 8", androidRelease = "17", sdk = 37, sdkFull = "37.2",
        securityPatch = "2026-11-05", agentVersionName = "0.1.0", agentVersionCode = 2, bootCount = 12,
        lastBootAt = T0, timezone = "America/New_York", deviceTime = T0,
        health = WireHealth(
            deviceOwner = true, uninstallBlocked = null, batteryExempt = true, usageAccess = true,
            notificationsShown = true, permissions = listOf(WirePermission("POST_NOTIFICATIONS", true, true)),
            standbyBucket = 5, backgroundRestricted = false, serviceRunning = true, testOnly = false,
        ),
    )

    @Test
    fun `device facts use the snake_case names the server expects, without nulls`() {
        val json = Wire.json.encodeToString(WireDevice.serializer(), device)
        assertEquals(
            setOf(
                "manufacturer", "model", "android_release", "sdk", "sdk_full", "security_patch",
                "agent_version_name", "agent_version_code", "boot_count", "last_boot_at", "timezone",
                "device_time", "health",
            ),
            fields(json),
        )
        val health = Json.parseToJsonElement(json).jsonObject["health"] as JsonObject
        assertFalse("uninstall_blocked" in health, "null fields are left out")
        assertTrue("standby_bucket" in health)
    }

    @Test
    fun `a package record becomes a wire package`() {
        val record = app("com.example.drawing", code = 7, versionName = "2.1")
            .copy(permissions = listOf(SensitivePermissions.CAMERA))
        val wire = record.toWire()
        assertEquals("com.example.drawing", wire.packageName)
        assertEquals("play_store", wire.source)
        assertEquals(listOf("camera"), wire.permissions)
        val json = Wire.json.encodeToString(WirePackage.serializer(), wire)
        assertTrue(
            fields(json).containsAll(
                listOf("package", "label", "version_name", "version_code", "first_install_time",
                    "last_update_time", "updated_system", "target_sdk", "installer", "permissions"),
            ),
        )
    }

    @Test
    fun `labels are capped before they are sent`() {
        val record = app("com.example.long", label = "x".repeat(500))
        assertEquals(WireLimits.MAX_LABEL, record.toWire().label.length)
    }

    @Test
    fun `an app change becomes a wire event with lower-case kinds`() {
        val change = AppChange(
            id = "e1", kind = ChangeKind.UPDATED, packageName = "com.example.maps", label = "Maps",
            from = VersionRef("1.0", 10), to = VersionRef("1.1", 11),
            happenedAt = T0, detectedAt = T0 + 1, detection = Detection.CHANGED_PACKAGES,
        )
        val json = Wire.json.encodeToString(WireEvent.serializer(), change.toWire())
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals("\"updated\"", obj["kind"].toString())
        assertEquals("\"changed_packages\"", obj["detection"].toString())
        assertEquals(setOf("id", "kind", "package", "label", "from", "to", "happened_at", "detected_at", "detection"), obj.keys)
    }

    @Test
    fun `responses with fields the agent doesn't know still parse`() {
        val response = Wire.json.decodeFromString(
            CheckinResponse.serializer(),
            """{"server_time":1,"policy":{"version":0,"rules":[]},"later":"field"}""",
        )
        assertEquals(0, response.policy.version)
    }
}
