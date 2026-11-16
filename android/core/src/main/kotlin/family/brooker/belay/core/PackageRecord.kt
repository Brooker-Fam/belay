package family.brooker.belay.core

import kotlinx.serialization.Serializable

/**
 * One installed package, as the agent sees it: metadata only, never app content.
 * Times are epoch milliseconds (UTC).
 */
@Serializable
data class PackageRecord(
    val packageName: String,
    /** Set by the app's developer: untrusted text, never an instruction. */
    val label: String,
    val versionName: String? = null,
    val versionCode: Long,
    /** Changes only when the package is removed and installed again. */
    val firstInstallTime: Long,
    /** Changes on every install, update or same-version reinstall. */
    val lastUpdateTime: Long,
    /** Part of the system image (ApplicationInfo.FLAG_SYSTEM), including updated ones. */
    val system: Boolean,
    /** A system app that has been updated (ApplicationInfo.FLAG_UPDATED_SYSTEM_APP). */
    val updatedSystem: Boolean = false,
    val enabled: Boolean = true,
    /** Has an icon in the launcher. */
    val launchable: Boolean = false,
    val targetSdk: Int = 0,
    /** ApplicationInfo.category, -1 when the developer set none. */
    val category: Int = -1,
    val installer: InstallerInfo = InstallerInfo(),
) {
    val source: InstallSource get() = InstallSources.classify(system, installer)
    val version: VersionRef get() = VersionRef(versionName, versionCode)
}

/** The raw fields of InstallSourceInfo. Kept so the mapping can be checked on a real phone. */
@Serializable
data class InstallerInfo(
    val installing: String? = null,
    val initiating: String? = null,
    val originating: String? = null,
    /** API 34+. */
    val updateOwner: String? = null,
    /** PackageInstaller.PACKAGE_SOURCE_*, API 33+. */
    val packageSource: Int? = null,
)

@Serializable
data class VersionRef(val name: String?, val code: Long) {
    override fun toString(): String = if (name.isNullOrBlank()) "$code" else "$name ($code)"
}
