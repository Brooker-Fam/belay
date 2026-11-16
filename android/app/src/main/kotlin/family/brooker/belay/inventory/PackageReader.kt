package family.brooker.belay.inventory

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.InstallerInfo
import family.brooker.belay.core.PackageRecord

/**
 * The apps collector (data category [DataCategories.APPS]): reads PackageManager into
 * [PackageRecord]s. Metadata only. Seeing every package relies on QUERY_ALL_PACKAGES.
 */
class PackageReader(context: Context) {
    private val pm: PackageManager = context.packageManager

    fun readAll(): Map<String, PackageRecord> {
        val launchable = pm.queryActivitiesCompat(launcherIntent())
            .mapNotNullTo(HashSet()) { it.activityInfo?.packageName }
        return pm.installedPackagesCompat(0)
            .mapNotNull { toRecord(it, it.packageName in launchable) }
            .associateBy { it.packageName }
    }

    /** Only [names]; a package that isn't installed is simply absent from the result. */
    fun read(names: Collection<String>): Map<String, PackageRecord> = names.mapNotNull { name ->
        val info = try {
            pm.packageInfoCompat(name, 0)
        } catch (e: PackageManager.NameNotFoundException) {
            return@mapNotNull null
        }
        toRecord(info, pm.queryActivitiesCompat(launcherIntent().setPackage(name)).isNotEmpty())
    }.associateBy { it.packageName }

    private fun launcherIntent() = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)

    private fun toRecord(info: PackageInfo, launchable: Boolean): PackageRecord? {
        val app = info.applicationInfo ?: return null
        return PackageRecord(
            packageName = info.packageName,
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
            installer = installerInfo(info.packageName),
        )
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

    private companion object {
        /** Labels and version names come from developers: untrusted, and capped. */
        const val MAX_TEXT = 200
    }
}
