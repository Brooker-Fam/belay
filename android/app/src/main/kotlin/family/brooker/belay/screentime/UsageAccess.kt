package family.brooker.belay.screentime

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/** Phase 3: where the kid turns usage access back on (docs/platform-notes.md U4, U9). */
object UsageAccess {
    /**
     * Settings' usage access switch for Belay. Settings.ACTION_USAGE_ACCESS_SETTINGS documents no
     * input, but AOSP 17's Settings opens the one app's page for a `package:` address
     * (Settings$AppUsageAccessSettingsActivity); where nothing handles that, the list of apps.
     */
    fun settings(context: Context): Intent {
        val own = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        return if (own.resolveActivity(context.packageManager) != null) own else Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
    }
}
