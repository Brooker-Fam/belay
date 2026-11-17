package family.brooker.belay.core

import family.brooker.belay.core.Fixtures.T0
import family.brooker.belay.core.screentime.WireLimitState
import family.brooker.belay.core.screentime.WireLimitStatus
import family.brooker.belay.core.screentime.WireScheduleNow
import family.brooker.belay.core.screentime.WireScreenTimeStatus
import family.brooker.belay.core.screentime.WireSelfServeTake
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * How big a check-in gets (the server takes at most 32 KB). Made-up package names, as long as
 * real ones get. The sizes are printed for docs/protocol.md and the reports.
 */
class CheckinSizeTest {
    /** A made-up package name of exactly [length] characters. */
    private fun pkg(n: Int, length: Int) = "com.example.app$n.".padEnd(length, 'x')

    private fun device(enforcement: WireEnforcement, foreign: List<String> = emptyList()) = WireDevice(
        manufacturer = "Google",
        model = "Pixel 8",
        androidRelease = "17",
        sdk = 37,
        sdkFull = "37",
        securityPatch = "2026-11-05",
        agentVersionName = "0.3.0-phase3",
        agentVersionCode = 4,
        bootCount = 31,
        lastBootAt = T0,
        timezone = "America/New_York",
        deviceTime = T0,
        batteryPercent = 64,
        charging = false,
        storageFreeBytes = 80_000_000_000,
        storageTotalBytes = 128_000_000_000,
        health = WireHealth(
            deviceOwner = true,
            uninstallBlocked = true,
            batteryExempt = true,
            usageAccess = true,
            notificationsShown = true,
            permissions = listOf("POST_NOTIFICATIONS", "ACCESS_LOCAL_NETWORK", "CAMERA").map { WirePermission(it, granted = it != "CAMERA", fixedByPolicy = true) },
            standbyBucket = 5,
            backgroundRestricted = false,
            serviceRunning = true,
            testOnly = false,
            otherUsers = 0,
            foreignRestrictions = foreign,
        ),
        enforcement = enforcement,
        agentSigningSha256 = "ab".repeat(32),
    )

    private fun screenTime(limits: Int, idLength: Int, takes: Int, packageLength: Int) = WireScreenTimeStatus(
        day = "2026-11-17",
        measured = true,
        usedMinutes = 1500,
        limits = (1..limits).map { WireLimitStatus("l$it".padEnd(idLength, 'x'), used = 1500, left = 1500, state = WireLimitState.USED_UP) },
        schedule = WireScheduleNow("s-bedtime".padEnd(idLength, 'x'), T0),
        selfServe = (1..takes).map { WireSelfServeTake("l$it".padEnd(idLength, 'x'), pkg(it, packageLength), 240, T0 + it) },
    )

    /** A busy family: 100 never-blocked packages, a dozen limits, a few problems, commands and takes. */
    private val busy = device(
        WireEnforcement(
            policyVersion = 412,
            appliedAt = T0,
            suspendedCount = 40,
            problems = (1..5).map { "${pkg(it, 40)} can't have a time limit: Belay never pauses it." },
            commands = (1..5).map { WireCommandResult("2f1c6b0e-8a4d-4f2b-9c3e-$it".padEnd(36, '0'), WireCommandOutcome.DONE, T0 + it) },
            neverBlocked = (1..100).map { pkg(it, 40) },
            screenTime = screenTime(limits = 12, idLength = 21, takes = 3, packageLength = 40),
        ),
        foreign = listOf("no_factory_reset"),
    )

    /** Every list at its cap, with long names and words. */
    private val everything = device(
        WireEnforcement(
            policyVersion = 1_000_000,
            appliedAt = T0,
            suspendedCount = 300,
            problems = (1..WireLimits.MAX_PROBLEMS).map { "p$it ".padEnd(WireLimits.MAX_PROBLEM, 'x') },
            agentUpdate = WireAgentUpdateState(5, WireUpdateState.FAILED, "x".repeat(WireLimits.MAX_PROBLEM), T0),
            recovery = WireRecoveryUse(3, T0, T0),
            commands = (1..WireLimits.MAX_COMMAND_RESULTS).map {
                WireCommandResult("c$it".padEnd(64, 'x'), WireCommandOutcome.FAILED, T0 + it, "y".repeat(WireLimits.MAX_PROBLEM))
            },
            neverBlocked = (1..WireLimits.MAX_NEVER_BLOCKED).map { pkg(it, 60) },
            screenTime = screenTime(limits = 50, idLength = 64, takes = 20, packageLength = 60),
        ),
        foreign = (1..WireLimits.MAX_FOREIGN_RESTRICTIONS).map { "no_restriction_$it".padEnd(WireLimits.MAX_RESTRICTION_KEY, 'x') },
    )

    @Test
    fun `a busy phone's check-in is well under the server's 32 KB`() {
        val bytes = Checkins.bytes(CheckinRequest(busy))
        println("check-in, busy: $bytes bytes")
        assertTrue(bytes < 12 * 1024, "$bytes bytes")
        assertEquals(CheckinRequest(busy), Checkins.fit(busy), "nothing trimmed")
    }

    @Test
    fun `with every list at its cap, it still fits`() {
        val bytes = Checkins.bytes(CheckinRequest(everything))
        println("check-in, every list at its cap: $bytes bytes")
        assertTrue(bytes < Checkins.TARGET_BYTES, "$bytes bytes")
    }

    @Test
    fun `a check-in that would be too big is trimmed, least important first`() {
        val huge = everything.copy(
            enforcement = everything.enforcement!!.copy(neverBlocked = (1..WireLimits.MAX_NEVER_BLOCKED).map { pkg(it, 200) }),
        )
        assertTrue(Checkins.bytes(CheckinRequest(huge)) > Checkins.TARGET_BYTES)
        val fit = Checkins.fit(huge)
        assertTrue(Checkins.bytes(fit) <= Checkins.TARGET_BYTES)
        val enforcement = fit.status.enforcement!!
        assertEquals(huge.enforcement!!.screenTime, enforcement.screenTime, "screen time is kept")
        assertEquals(WireLimits.MAX_NEVER_BLOCKED / 2, enforcement.neverBlocked.size, "the never-blocked list's tail goes first")
        assertEquals(huge.health, fit.status.health)
    }
}
