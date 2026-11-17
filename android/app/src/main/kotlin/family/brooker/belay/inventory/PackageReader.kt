package family.brooker.belay.inventory

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.InstallerInfo
import family.brooker.belay.core.PackagePresence
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.SensitivePermissions

/**
 * The apps collector (data category [DataCategories.APPS]): reads PackageManager into
 * [PackageRecord]s. Metadata only. Seeing every package relies on QUERY_ALL_PACKAGES.
 *
 * Apps Belay hides (blocked apps, Phase 2) are still installed: every read asks with
 * MATCH_UNINSTALLED_PACKAGES and keeps what core's [PackagePresence] says is installed, for
 * the launcher query too. So a blocked app stays in the inventory instead of reading as
 * removed, and keeps its launcher icon in the record.
 */
class PackageReader(context: Context) {
    private val app = context.applicationContext
    private val pm: PackageManager = app.packageManager

    fun readAll(): Map<String, PackageRecord> {
        val launchable = pm.queryActivitiesCompat(launcherIntent(), PackageManager.MATCH_UNINSTALLED_PACKAGES)
            .filter { installed(it.activityInfo?.applicationInfo) }
            .mapNotNullTo(HashSet()) { it.activityInfo?.packageName }
        val access = readSpecialAccess()
        return pm.installedPackagesCompat(PackageManager.GET_PERMISSIONS or PackageManager.MATCH_UNINSTALLED_PACKAGES)
            .filter { installed(it.applicationInfo) }
            .mapNotNull { toRecord(it, it.packageName in launchable, access) }
            .associateBy { it.packageName }
    }

    /** Only [names]; a package that isn't installed is simply absent from the result. */
    fun read(names: Collection<String>): Map<String, PackageRecord> {
        val access = readSpecialAccess()
        return names.mapNotNull { name ->
            val info = try {
                pm.packageInfoCompat(name, PackageManager.GET_PERMISSIONS or PackageManager.MATCH_UNINSTALLED_PACKAGES)
            } catch (e: PackageManager.NameNotFoundException) {
                return@mapNotNull null
            }
            if (!installed(info.applicationInfo)) return@mapNotNull null
            val launchable = pm.queryActivitiesCompat(launcherIntent().setPackage(name), PackageManager.MATCH_UNINSTALLED_PACKAGES)
                .any { installed(it.activityInfo?.applicationInfo) }
            toRecord(info, launchable, access)
        }.associateBy { it.packageName }
    }

    private fun launcherIntent() = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)

    /** Installed for this user, hidden or not (not just data left behind by an uninstall). */
    private fun installed(info: ApplicationInfo?): Boolean = info != null && PackagePresence.installed(info.flags)

    private fun toRecord(info: PackageInfo, launchable: Boolean, access: SpecialAccess): PackageRecord? {
        val app = info.applicationInfo ?: return null
        val name = info.packageName
        return PackageRecord(
            packageName = name,
            label = app.loadLabel(pm).toString().trim().take(MAX_TEXT),
            versionName = info.versionName?.take(MAX_TEXT),
            versionCode = info.longVersionCode,
            firstInstallTime = info.firstInstallTime,
            lastUpdateTime = info.lastUpdateTime,
            system = app.flags and ApplicationInfo.FLAG_SYSTEM != 0,
            updatedSystem = app.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP != 0,
            enabled = app.enabled,
            launchable = launchable,
            targetSdk = app.targetSdkVersion,
            category = app.category,
            installer = installerInfo(name),
            permissions = SensitivePermissions.held(
                grantedPermissions = granted(info),
                notificationListener = name in access.notificationListeners,
                accessibilityService = name in access.accessibilityServices,
                deviceAdmin = name in access.deviceAdmins,
            ),
        )
    }

    /** The runtime permissions it requested and holds right now. */
    private fun granted(info: PackageInfo): List<String> {
        val names = info.requestedPermissions ?: return emptyList()
        val flags = info.requestedPermissionsFlags ?: return emptyList()
        return names.indices
            .filter { it < flags.size && flags[it] and PackageInfo.REQUESTED_PERMISSION_GRANTED != 0 }
            .map { names[it] }
    }

    private fun installerInfo(name: String): InstallerInfo = try {
        val source = pm.getInstallSourceInfo(name)
        InstallerInfo(
            installing = source.installingPackageName,
            initiating = source.initiatingPackageName,
            originating = source.originatingPackageName,
            updateOwner = if (Build.VERSION.SDK_INT >= 34) source.updateOwnerPackageName else null,
            packageSource = if (Build.VERSION.SDK_INT >= 33) source.packageSource else null,
        )
    } catch (e: PackageManager.NameNotFoundException) {
        InstallerInfo()
    }

    /**
     * Special access is granted in Settings, not by a permission dialog, so it isn't in an
     * app's permission flags. Read once per scan, not per package.
     */
    private class SpecialAccess(
        val notificationListeners: Set<String>,
        val accessibilityServices: Set<String>,
        val deviceAdmins: Set<String>,
    )

    private fun readSpecialAccess(): SpecialAccess {
        val resolver = app.contentResolver
        // Both keys are @Readable in Android 17's Settings.java, so an app targeting 37 may
        // read them. The listener key is hidden from the SDK, hence the literal.
        val listeners = SensitivePermissions.packagesInComponentList(
            Settings.Secure.getString(resolver, ENABLED_NOTIFICATION_LISTENERS),
        )
        val accessibility = SensitivePermissions.packagesInComponentList(
            Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
        )
        val admins = app.getSystemService(DevicePolicyManager::class.java).activeAdmins
            .orEmpty().mapTo(HashSet()) { it.packageName }
        return SpecialAccess(listeners, accessibility, admins)
    }

    private companion object {
        /** Labels and version names come from developers: untrusted, and capped. */
        const val MAX_TEXT = 200
        const val ENABLED_NOTIFICATION_LISTENERS = "enabled_notification_listeners"
    }
}
