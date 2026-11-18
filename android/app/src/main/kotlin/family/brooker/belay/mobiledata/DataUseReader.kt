package family.brooker.belay.mobiledata

import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.os.Process
import android.os.UserHandle
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.mobiledata.DataUse

/**
 * The mobile data collector (data category [DataCategories.MOBILE_DATA]), Phase 13: Android's own
 * accounting of how many bytes each uid used on mobile data in a range of time, and the phone's
 * total on Wi-Fi, from NetworkStatsManager (platform notes Q6 to Q8). A device owner reads every
 * app's, with no permission and whether or not usage access is on. Counts only: Android's
 * accounting has nothing about websites or what's inside the traffic, and Belay never asks per
 * Wi-Fi network (that would need location). Each uid is named as core's DataUse takes it.
 * Blocking calls into Android: the agent thread only.
 */
class DataUseReader(context: Context) {
    private val app = context.applicationContext
    private val stats = app.getSystemService(NetworkStatsManager::class.java)
    private val pm = app.packageManager
    private val me = Process.myUserHandle()

    /** [range]'s rows on mobile data (every mobile network, metered ones: Q6), and its bytes on Wi-Fi. */
    fun read(range: DataUse.Range): Pair<List<DataUse.Row>, Long> {
        if (range.from >= range.to) return emptyList<DataUse.Row>() to 0L
        val owners = HashMap<Int, DataUse.Owner>()
        val rows = ArrayList<DataUse.Row>()
        // Per uid, state, metered and roaming; untagged, so each row is all of that uid's traffic in it.
        stats.querySummary(ConnectivityManager.TYPE_MOBILE, null, range.from, range.to)?.use { summary ->
            val bucket = NetworkStats.Bucket()
            while (summary.hasNextBucket() && summary.getNextBucket(bucket)) {
                val owner = owners.getOrPut(bucket.uid) { ownerOf(bucket.uid) }
                rows += DataUse.Row(owner, bucket.rxBytes + bucket.txBytes)
            }
        }
        val wifi = stats.querySummaryForDevice(ConnectivityManager.TYPE_WIFI, null, range.from, range.to)
        return rows to (wifi?.let { it.rxBytes + it.txBytes } ?: 0L)
    }

    /** Who a uid is: an app, Android's own (several packages, other users', none), removed apps, the hotspot. */
    private fun ownerOf(uid: Int): DataUse.Owner {
        if (uid == NetworkStats.Bucket.UID_REMOVED) return DataUse.Owner.Removed
        if (uid == NetworkStats.Bucket.UID_TETHERING) return DataUse.Owner.Hotspot
        // Android's own uids (under 10000 in any user), the other special ones, and other users' apps.
        if (uid < 0 || uid % PER_USER_RANGE < Process.FIRST_APPLICATION_UID || UserHandle.getUserHandleForUid(uid) != me) return DataUse.Owner.Android
        // An app's SDK sandbox (ads, measurement) is the app's: Android gives it the app's rules too (Q2). Public from API 35.
        val appUid = if (Build.VERSION.SDK_INT >= 35 && Process.isSdkSandboxUid(uid)) Process.getAppUidForSdkSandboxUid(uid) else uid
        val packages = pm.getPackagesForUid(appUid)
        return if (packages?.size == 1) DataUse.Owner.App(packages[0]) else DataUse.Owner.Android
    }

    private companion object {
        /** AOSP's UserHandle.PER_USER_RANGE (not in the SDK): a uid is its user's id times this, plus its app id. */
        const val PER_USER_RANGE = 100_000
    }
}
