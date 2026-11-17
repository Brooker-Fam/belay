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
    fun `an installed event carries the package, so its details arrive with it`() {
        val record = app("com.example.drawing", code = 3).copy(permissions = listOf(SensitivePermissions.CAMERA))
        val change = AppChange(
            id = "e2", kind = ChangeKind.INSTALLED, packageName = record.packageName, label = record.label,
            to = record.version, happenedAt = T0, detectedAt = T0 + 1, detection = Detection.BROADCAST,
        )
        val event = change.toWire(record)
        assertEquals(record.toWire(), event.app)
        val obj = Json.parseToJsonElement(Wire.json.encodeToString(WireEvent.serializer(), event)).jsonObject
        val app = obj["app"] as JsonObject
        assertEquals("\"com.example.drawing\"", app["package"].toString())
        assertEquals("\"play_store\"", app["source"].toString())
        assertEquals("[\"camera\"]", app["permissions"].toString())
    }

    @Test
    fun `a removed event leaves the package out, even when one is passed`() {
        val record = app("com.example.drawing")
        val change = AppChange(
            id = "e3", kind = ChangeKind.REMOVED, packageName = record.packageName, label = record.label,
            from = record.version, detectedAt = T0, detection = Detection.BROADCAST,
        )
        val event = change.toWire(record)
        assertEquals(null, event.app)
        val obj = Json.parseToJsonElement(Wire.json.encodeToString(WireEvent.serializer(), event)).jsonObject
        assertFalse("app" in obj, "a null app is left out of the JSON")
    }

    @Test
    fun `an event never carries another package's record`() {
        val change = AppChange(
            id = "e4", kind = ChangeKind.UPDATED, packageName = "com.example.maps", label = "Maps",
            from = VersionRef("1", 1), to = VersionRef("2", 2), detectedAt = T0, detection = Detection.SNAPSHOT,
        )
        assertEquals(null, change.toWire(app("com.example.other")).app)
        assertEquals("com.example.maps", change.toWire(app("com.example.maps", code = 2)).app?.packageName)
    }

    @Test
    fun `a Phase 1 policy enforces nothing`() {
        val policy = Wire.json.decodeFromString(CheckinResponse.serializer(), """{"server_time":1,"policy":{"version":0}}""").policy
        assertEquals(WireNewApps.ALLOW, policy.apps.newApps)
        assertEquals(null, policy.pause)
        assertFalse(policy.restrictions.factoryReset || policy.restrictions.debugging || policy.restrictions.safeBoot)
        assertEquals(null, policy.web.privateDns)
    }

    @Test
    fun `a Phase 2 policy parses, with the server's snake_case names`() {
        val json = """{"server_time":5,"policy":{"version":7,"issued_at":4,
            "apps":{"new_apps":"ask","decisions":[{"package":"com.example.chat","state":"blocked"}]},
            "pause":{"until":null,"note":"Dinner"},
            "restrictions":{"safe_boot":true,"add_user":true,"unknown_sources":true,"config_vpn":true,
              "config_private_dns":true,"config_date_time":true,"config_default_apps":true,
              "modify_accounts":false,"sim":false,"factory_reset":false,"debugging":false},
            "web":{"private_dns":"family-filter-dns.cleanbrowsing.org","chrome":{"incognito":false,"safe_search":true,
              "youtube_restrict":"strict","safe_sites":true,"allow_downloads":false,"url_allowlist":null,"url_blocklist":[]},
              "hide_browsers":false},
            "maintenance_until":null,"frp_accounts":[],"support_message":"Ask a parent",
            "requests":[{"id":"request-0001","status":"talk","note":"Let's talk at dinner","answered_at":3,"answered_by":"Sam"}]}}"""
        val policy = Wire.json.decodeFromString(PolicyResponse.serializer(), json).policy
        assertEquals(7, policy.version)
        assertEquals(WireNewApps.ASK, policy.apps.newApps)
        assertEquals(WireAppState.BLOCKED, policy.apps.decisions.single().state)
        assertEquals("Dinner", policy.pause?.note)
        assertTrue(policy.restrictions.safeBoot)
        assertEquals("family-filter-dns.cleanbrowsing.org", policy.web.privateDns)
        assertEquals("strict", policy.web.chrome?.youtubeRestrict)
        assertEquals(WireRequestStatus.TALK, policy.requests.single().status)
    }

    @Test
    fun `a request uses the names the server expects`() {
        val json = Wire.json.encodeToString(
            RequestsRequest.serializer(),
            RequestsRequest(listOf(WireRequest("request-0001", WireRequestKind.APP, "com.example.chat", "Chatter Box", "My friends use it", T0))),
        )
        val request = (Json.parseToJsonElement(json).jsonObject["requests"] as kotlinx.serialization.json.JsonArray).single().jsonObject
        assertEquals(setOf("id", "kind", "package", "label", "reason", "asked_at"), request.keys)
        assertEquals("\"app\"", request["kind"].toString())
    }

    @Test
    fun `a Phase 6 policy parses, with an update, the recovery check and commands`() {
        val policy = Wire.json.decodeFromString(
            WirePolicy.serializer(),
            """
            {"version":9,
             "agent_update":{"version_code":4,"version_name":"0.4.0","sha256":"${"ab".repeat(32)}","size":12345678},
             "recovery":{"version":2,"salt":"000102030405060708090a0b0c0d0e0f","hash":"${"cd".repeat(32)}"},
             "commands":[{"id":"command-0001","kind":"remove_other_users","issued_at":$T0},
                         {"id":"command-0002","kind":"from_a_newer_server","issued_at":$T0}]}
            """.trimIndent(),
        )
        assertEquals(4L, policy.agentUpdate?.versionCode)
        assertEquals(12345678L, policy.agentUpdate?.size)
        assertEquals(2, policy.recovery?.version)
        assertEquals(listOf(WireCommand.REMOVE_OTHER_USERS, "from_a_newer_server"), policy.commands.map { it.kind })
    }

    @Test
    fun `the Phase 6 enforcement report uses the server's names`() {
        val report = WireEnforcement(
            policyVersion = 9,
            agentUpdate = WireAgentUpdateState(4, WireUpdateState.FAILED, "Android said: INSTALL_FAILED_VERIFICATION_FAILURE", T0),
            recovery = WireRecoveryUse(version = 2, usedAt = T0, until = T0 + 24 * 3_600_000L),
            commands = listOf(WireCommandResult("command-0001", T0, ok = true)),
            neverBlocked = listOf("com.android.dialer"),
        )
        val json = Json.parseToJsonElement(Wire.json.encodeToString(WireEnforcement.serializer(), report)).jsonObject
        assertEquals(
            setOf("policy_version", "suspended_count", "problems", "agent_update", "recovery", "commands", "never_blocked"),
            json.keys,
        )
        assertEquals("\"failed\"", json["agent_update"]!!.jsonObject["state"].toString())
        assertEquals(setOf("id", "done_at", "ok"), (json["commands"] as kotlinx.serialization.json.JsonArray).single().jsonObject.keys)
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
