package family.brooker.belay.core

/** Made-up apps only (public-repo hygiene: no real device data in fixtures). */
object Fixtures {
    const val T0 = 1_760_000_000_000L
    const val HOUR = 60L * 60 * 1000

    fun app(
        name: String,
        label: String = name.substringAfterLast('.').replaceFirstChar { it.uppercase() },
        code: Long = 1,
        versionName: String? = "1.0",
        installed: Long = T0,
        updated: Long = installed,
        system: Boolean = false,
        installer: InstallerInfo = InstallerInfo(installing = InstallSources.PLAY_STORE_PACKAGE),
    ) = PackageRecord(
        packageName = name,
        label = label,
        versionName = versionName,
        versionCode = code,
        firstInstallTime = installed,
        lastUpdateTime = updated,
        system = system,
        launchable = true,
        targetSdk = 36,
        installer = installer,
    )

    fun inventory(vararg apps: PackageRecord) = apps.associateBy { it.packageName }

    fun ids(): () -> String {
        var n = 0
        return { "id-${++n}" }
    }
}
