package family.brooker.belay.inventory

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.os.Build

// The *Flags overloads are API 33+; minSdk is 31.

fun PackageManager.packageInfoCompat(name: String, flags: Int): PackageInfo =
    if (Build.VERSION.SDK_INT >= 33) {
        getPackageInfo(name, PackageManager.PackageInfoFlags.of(flags.toLong()))
    } else {
        @Suppress("DEPRECATION")
        getPackageInfo(name, flags)
    }

fun PackageManager.installedPackagesCompat(flags: Int): List<PackageInfo> =
    if (Build.VERSION.SDK_INT >= 33) {
        getInstalledPackages(PackageManager.PackageInfoFlags.of(flags.toLong()))
    } else {
        @Suppress("DEPRECATION")
        getInstalledPackages(flags)
    }

fun PackageManager.queryActivitiesCompat(intent: Intent, flags: Int = 0): List<ResolveInfo> =
    if (Build.VERSION.SDK_INT >= 33) {
        queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(flags.toLong()))
    } else {
        @Suppress("DEPRECATION")
        queryIntentActivities(intent, flags)
    }

fun PackageManager.resolveActivityCompat(intent: Intent, flags: Int = 0): ResolveInfo? =
    if (Build.VERSION.SDK_INT >= 33) {
        resolveActivity(intent, PackageManager.ResolveInfoFlags.of(flags.toLong()))
    } else {
        @Suppress("DEPRECATION")
        resolveActivity(intent, flags)
    }
