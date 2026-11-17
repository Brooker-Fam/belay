package family.brooker.belay.enforce

import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.app.admin.FactoryResetProtectionPolicy
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.UserManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.BuildConfig
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.ActualState
import family.brooker.belay.core.Applied
import family.brooker.belay.core.ApplyOutcome
import family.brooker.belay.core.ChromeConfig
import family.brooker.belay.core.EnforcementChanges
import family.brooker.belay.core.Lock
import family.brooker.belay.core.PlayAccounts
import family.brooker.belay.core.Setting

/**
 * Applies core's EnforcementChanges with DevicePolicyManager, as the device owner, and says
 * what failed. Plain, deterministic calls; every one checked against AOSP android-17.0.0_r1
 * (docs/platform-notes.md):
 *
 * - setPackagesSuspended goes through the policy engine and PackageManager, attributed to
 *   the platform ("android"). A suspended app can't start activities; its notifications are
 *   hidden and it can't ring the device. Opening one shows Settings' admin dialog, "Blocked
 *   by work policy", with the short support message as its text. PackageManager refuses
 *   device admins, the active launcher, the required installer, uninstaller and verifier,
 *   the default dialer and the permission controller, and returns those as failed.
 * - setApplicationHidden kills the app and makes it look uninstalled; Android sends
 *   PACKAGE_REMOVED (and PACKAGE_ADDED when it's shown again). The engine only acts when
 *   its stored value changes, so an app that lost its hidden state (reinstalled) is shown
 *   and hidden again.
 * - User restrictions: a device owner's unknown key is silently ignored, so keys newer than
 *   the phone's Android are never sent (core's Lock.minSdkFull).
 * - setApplicationRestrictions (Chrome's settings, Play's allowed accounts) checks only that the
 *   package name is well formed, not that the app is installed: Android keeps the configuration
 *   for when it is, and an empty bundle removes it (platform notes A4).
 *
 * Never on a debug build, whatever the plan says: DISALLOW_FACTORY_RESET,
 * DISALLOW_DEBUGGING_FEATURES or a factory reset protection policy (CLAUDE.md, "Ask
 * before"). The planner already leaves them out; this is the second guard.
 */
class Enforcer(context: Context) {
    private val app = context.applicationContext
    private val dpm = app.getSystemService(DevicePolicyManager::class.java)
    private val um = app.getSystemService(UserManager::class.java)
    private val pm = app.packageManager
    private val admin = DeviceOwnerSetup.admin(app)

    /** Tightens first, then loosens, so a failure part-way leaves the phone stricter, not looser. */
    fun apply(changes: EnforcementChanges): ApplyOutcome {
        if (changes.none) return ApplyOutcome()
        val problems = mutableListOf<String>()
        val failedHide = changes.hide.filterNot { hide(it, problems) }.toSet()
        val failedSuspend = suspend(changes.suspend, true, problems)
        val failedLock = changes.lock.filterNot { lock(it, true, problems) }.toSet()
        val autoTimeFailed = changes.autoTime?.let { !autoTime(it, problems) } ?: false
        val chromeFailed = changes.chrome?.let { !chrome(it, problems) } ?: false
        val playFailed = changes.playAccounts?.let { !playAccounts(it, problems) } ?: false
        val frpFailed = changes.frpAccounts?.let { !resetProtection(it, problems) } ?: false
        val failedUnhide = changes.unhide.filterNot { unhide(it, problems) }.toSet()
        val failedUnsuspend = suspend(changes.unsuspend, false, problems)
        val failedUnlock = changes.unlock.filterNot { lock(it, false, problems) }.toSet()
        if (problems.isNotEmpty()) Log.w(Agent.TAG, "enforcement: $problems")
        return ApplyOutcome(
            failedSuspend = failedSuspend,
            failedUnsuspend = failedUnsuspend,
            failedHide = failedHide,
            failedUnhide = failedUnhide,
            failedLock = failedLock,
            failedUnlock = failedUnlock,
            autoTimeFailed = autoTimeFailed,
            chromeFailed = chromeFailed,
            frpFailed = frpFailed,
            playFailed = playFailed,
            problems = problems,
        )
    }

    /**
     * The state the phone has now: whether [suspended] are still suspended and [hidden]
     * still hidden, and which of [locks] hold. One binder call each, so cheap enough for
     * every step.
     */
    fun actual(suspended: Set<String>, hidden: Set<String>, locks: Set<Lock>): ActualState {
        val packages = suspended + hidden
        return ActualState(
            checkedPackages = packages,
            // A package only Belay's hidden record names is checked for that; same for suspension.
            suspended = packages.filter { it !in suspended || isSuspended(it) }.toSet(),
            hidden = packages.filter { it !in hidden || isHidden(it) }.toSet(),
            checkedLocks = locks,
            locks = locks.filter { lock -> keyFor(lock)?.let { um.hasUserRestriction(it) } == true }.toSet(),
        )
    }

    /**
     * Removes what Belay's policies still say about packages that are gone, so the engine
     * doesn't keep them, and a reinstall starts clean. Best effort.
     */
    fun forget(packages: Set<String>) {
        if (packages.isEmpty()) return
        runCatching { dpm.setPackagesSuspended(admin, packages.toTypedArray(), false) }
        packages.forEach { runCatching { dpm.setApplicationHidden(admin, it, false) } }
    }

    /**
     * Takes back everything [applied] says Belay did, and Private DNS if [privateDns] is the
     * host Belay set. For a debug build's "Release this phone": releasing device owner removes
     * the policy engine's policies by itself, but not the global Private DNS setting.
     */
    fun release(applied: Applied, privateDns: String?) {
        val changes = EnforcementChanges(
            unsuspend = applied.suspended,
            unhide = applied.hidden,
            unlock = applied.locks,
            autoTime = false.takeIf { applied.autoTime },
            chrome = Setting.Clear.takeIf { applied.chrome != null },
            frpAccounts = Setting.Clear.takeIf { applied.frpAccounts != null },
            playAccounts = Setting.Clear.takeIf { applied.playAccounts != null },
        )
        apply(changes)
        if (privateDns != null && runCatching { dpm.getGlobalPrivateDnsHost(admin) }.getOrNull() == privateDns) {
            runCatching { dpm.setGlobalPrivateDnsModeOpportunistic(admin) }
        }
    }

    /** Sets the short support message if it isn't [message] already; returns what is set. */
    fun supportMessage(message: String, current: String?): String? {
        if (message == current) return current
        return try {
            dpm.setShortSupportMessage(admin, message)
            message
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "support message not set", e)
            current
        }
    }

    private fun suspend(packages: Set<String>, suspended: Boolean, problems: MutableList<String>): Set<String> {
        if (packages.isEmpty()) return emptySet()
        val failed = try {
            dpm.setPackagesSuspended(admin, packages.toTypedArray(), suspended).toSet()
        } catch (e: RuntimeException) {
            problems += "Couldn't ${if (suspended) "suspend" else "let"} ${packages.size} apps${if (suspended) "" else " run again"}: ${e.javaClass.simpleName}."
            return packages
        }
        failed.forEach { problems += if (suspended) "Android didn't let Belay suspend $it." else "Android didn't let Belay unsuspend $it." }
        return failed
    }

    private fun hide(name: String, problems: MutableList<String>): Boolean = try {
        if (dpm.setApplicationHidden(admin, name, true) || isHidden(name)) {
            true
        } else {
            // The engine already had it hidden (from before a reinstall), so it didn't act:
            // change its value and back.
            dpm.setApplicationHidden(admin, name, false)
            dpm.setApplicationHidden(admin, name, true) || isHidden(name)
        }
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "hide $name", e)
        false
    }.also { if (!it) problems += "Android didn't let Belay hide $name." }

    private fun unhide(name: String, problems: MutableList<String>): Boolean = try {
        dpm.setApplicationHidden(admin, name, false) || !isHidden(name)
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "unhide $name", e)
        false
    }.also { if (!it) problems += "Android didn't let Belay show $name again." }

    private fun isSuspended(name: String): Boolean = try {
        pm.isPackageSuspended(name)
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun isHidden(name: String): Boolean = try {
        dpm.isApplicationHidden(admin, name)
    } catch (e: RuntimeException) {
        false
    }

    private fun lock(lock: Lock, on: Boolean, problems: MutableList<String>): Boolean {
        if (on && BuildConfig.DEBUG && lock in NEVER_ON_DEBUG) {
            problems += "A debug build of Belay never locks ${lock.name.lowercase().replace('_', ' ')}."
            return false
        }
        val key = keyFor(lock)
        if (key == null) {
            // Nothing to clear on an Android without the key.
            if (on) problems += "This version of Android can't lock ${lock.name.lowercase().replace('_', ' ')}."
            return !on
        }
        return try {
            if (on) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
            // Clearing only takes back Belay's own: another source may still set it, which is fine.
            if (on && !um.hasUserRestriction(key)) {
                problems += "Android didn't apply $key."
                false
            } else {
                true
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "restriction $key", e)
            problems += "Couldn't ${if (on) "set" else "clear"} $key: ${e.javaClass.simpleName}."
            false
        }
    }

    /**
     * Automatic time while the date and time are locked. Android 16 (API 36) added a policy
     * that can also hand control back; before that, Belay only turns it on and leaves it on.
     */
    private fun autoTime(on: Boolean, problems: MutableList<String>): Boolean = try {
        if (Build.VERSION.SDK_INT >= 36) {
            dpm.setAutoTimePolicy(if (on) DevicePolicyManager.AUTO_TIME_ENABLED else DevicePolicyManager.AUTO_TIME_NOT_CONTROLLED_BY_POLICY)
        } else if (on) {
            dpm.setAutoTimeEnabled(admin, true)
        }
        true
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "auto time", e)
        problems += "Couldn't ${if (on) "turn on" else "hand back"} automatic time: ${e.javaClass.simpleName}."
        false
    }

    /** Chrome's managed configuration; an empty bundle takes it back. */
    private fun chrome(change: Setting<ChromeConfig>, problems: MutableList<String>): Boolean = try {
        val bundle = when (change) {
            is Setting.Set -> chromeBundle(change.value)
            Setting.Clear -> Bundle()
        }
        dpm.setApplicationRestrictions(admin, CHROME, bundle)
        true
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "Chrome configuration", e)
        problems += "Couldn't set Chrome's settings: ${e.javaClass.simpleName}."
        false
    }

    /**
     * Play's allowed accounts (platform notes A4): `allowed_accounts` in Play's managed configuration,
     * the accounts' email addresses comma-separated, as Google's guide for device policy apps sets
     * it, keeping any other key there; taken back by removing the key, and with it the whole
     * configuration when nothing else is left. Play reads it from version 80970100.
     */
    private fun playAccounts(change: Setting<List<String>>, problems: MutableList<String>): Boolean = try {
        val config = Bundle(dpm.getApplicationRestrictions(admin, PlayAccounts.PLAY_STORE))
        when (change) {
            is Setting.Set -> config.putString(PlayAccounts.KEY, PlayAccounts.value(change.value))
            Setting.Clear -> config.remove(PlayAccounts.KEY)
        }
        dpm.setApplicationRestrictions(admin, PlayAccounts.PLAY_STORE, config)
        true
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "Play's accounts", e)
        problems += "Couldn't ${if (change is Setting.Set) "set" else "take back"} the accounts the Play Store may use: ${e.javaClass.simpleName}."
        false
    }

    /**
     * Factory reset protection (API 30). Android itself then tells the reset-protection agent
     * (Play services on a Pixel) with ACTION_RESET_PROTECTION_POLICY_CHANGED, and Google's
     * guide for device policy apps still asks for FRP_CONFIG_CHANGED too, so Belay sends it
     * (a local broadcast to Play services; nothing leaves the phone from Belay). Throws
     * UnsupportedOperationException where the phone has no persistent data block (emulators).
     * Reset protection doesn't hold while OEM unlocking is on, which Belay can't read.
     */
    private fun resetProtection(change: Setting<List<String>>, problems: MutableList<String>): Boolean {
        if (change is Setting.Set && BuildConfig.DEBUG) {
            problems += "A debug build of Belay never sets factory reset protection."
            return false
        }
        return try {
            val policy = (change as? Setting.Set)?.let {
                FactoryResetProtectionPolicy.Builder()
                    .setFactoryResetProtectionAccounts(it.value)
                    .setFactoryResetProtectionEnabled(true)
                    .build()
            }
            dpm.setFactoryResetProtectionPolicy(admin, policy)
            app.sendBroadcast(Intent(FRP_CONFIG_CHANGED).setPackage(PLAY_SERVICES).addFlags(Intent.FLAG_RECEIVER_FOREGROUND))
            true
        } catch (e: UnsupportedOperationException) {
            problems += "This phone doesn't support factory reset protection."
            false
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "reset protection", e)
            problems += "Couldn't ${if (change is Setting.Set) "set" else "clear"} factory reset protection: ${e.javaClass.simpleName}."
            false
        }
    }

    companion object {
        const val CHROME = "com.android.chrome"

        /** Google's broadcast for a changed reset-protection setup, to Play services only. */
        private const val FRP_CONFIG_CHANGED = "com.google.android.gms.auth.FRP_CONFIG_CHANGED"
        private const val PLAY_SERVICES = "com.google.android.gms"

        /** Can lock someone out of a phone: release builds only. */
        val NEVER_ON_DEBUG = setOf(Lock.FACTORY_RESET, Lock.DEBUGGING)

        /**
         * 37.2's key isn't in the 37.0 SDK Belay compiles against: its value, from the 37.2
         * SDK (platform notes M2). Only sent from 37.2 (core's Lock.minSdkFull).
         */
        private const val DISALLOW_INSTALL_UNKNOWN_SOURCES_INCLUDING_REGISTERED_APP_STORES =
            "no_install_unknown_sources_including_registered_app_stores"

        /** Android's key for [lock]; null if this phone's Android is too old for it. */
        @SuppressLint("InlinedApi") // Gated by Lock.minSdkFull, checked against the phone below.
        fun keyFor(lock: Lock): String? {
            if (lock.minSdkFull > sdkFull()) return null
            return when (lock) {
                Lock.SAFE_BOOT -> UserManager.DISALLOW_SAFE_BOOT
                Lock.ADD_USER -> UserManager.DISALLOW_ADD_USER
                Lock.USER_SWITCH -> UserManager.DISALLOW_USER_SWITCH
                Lock.UNKNOWN_SOURCES -> UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY
                Lock.UNKNOWN_SOURCES_REGISTERED_STORES -> DISALLOW_INSTALL_UNKNOWN_SOURCES_INCLUDING_REGISTERED_APP_STORES
                Lock.CONFIG_VPN -> UserManager.DISALLOW_CONFIG_VPN
                Lock.CONFIG_PRIVATE_DNS -> UserManager.DISALLOW_CONFIG_PRIVATE_DNS
                Lock.CONFIG_DATE_TIME -> UserManager.DISALLOW_CONFIG_DATE_TIME
                Lock.CONFIG_DEFAULT_APPS -> UserManager.DISALLOW_CONFIG_DEFAULT_APPS
                Lock.MODIFY_ACCOUNTS -> UserManager.DISALLOW_MODIFY_ACCOUNTS
                Lock.SIM -> UserManager.DISALLOW_SIM_GLOBALLY
                Lock.FACTORY_RESET -> UserManager.DISALLOW_FACTORY_RESET
                Lock.DEBUGGING -> UserManager.DISALLOW_DEBUGGING_FEATURES
                // Phase 4: keep_on and lost mode (platform notes L2).
                Lock.CONFIG_LOCATION -> UserManager.DISALLOW_CONFIG_LOCATION
            }
        }

        /** Build.VERSION.SDK_INT_FULL (API 36+): major * 100000 + minor. */
        fun sdkFull(): Int = if (Build.VERSION.SDK_INT >= 36) Build.VERSION.SDK_INT_FULL else Build.VERSION.SDK_INT * 100_000

        /** Chrome's policy names (Chromium's policy definitions), as Chrome's PolicyConverter reads them. */
        fun chromeBundle(config: ChromeConfig) = Bundle().apply {
            putInt("IncognitoModeAvailability", config.incognitoModeAvailability)
            putBoolean("ForceGoogleSafeSearch", config.forceGoogleSafeSearch)
            putInt("ForceYouTubeRestrict", config.forceYouTubeRestrict)
            putInt("SafeSitesFilterBehavior", config.safeSitesFilterBehavior)
            putInt("DownloadRestrictions", config.downloadRestrictions)
            putStringArray("URLBlocklist", config.urlBlocklist.toTypedArray())
            config.urlAllowlist?.let { putStringArray("URLAllowlist", it.toTypedArray()) }
            putString("DnsOverHttpsMode", config.dnsOverHttpsMode)
            // A dictionary policy: Chrome on Android reads a string given for one as JSON (platform notes H2).
            config.proxySettings?.let { putString("ProxySettings", it) }
        }
    }
}
