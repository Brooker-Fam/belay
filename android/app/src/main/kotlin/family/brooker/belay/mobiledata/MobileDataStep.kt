package family.brooker.belay.mobiledata

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.PackageRecord
import family.brooker.belay.core.Protection
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.mobiledata.DataUse
import family.brooker.belay.core.mobiledata.DataUseUploads
import family.brooker.belay.core.mobiledata.MobileDataState
import family.brooker.belay.core.mobiledata.WifiOnly
import family.brooker.belay.core.mobiledata.WireMobileDataDay
import family.brooker.belay.core.mobiledata.WireMobileDataStatus
import family.brooker.belay.inventory.packageInfoCompat
import family.brooker.belay.store.AgentStore
import java.time.ZoneId

/**
 * Phase 13's mobile data on the phone, in every enforcement step, on the agent thread
 * (docs/design/phase13-mobile-data.md; platform notes Q1 to Q9).
 *
 * - Wi-Fi only: the policy's `mobile_data.wifi_only`, as core's WifiOnly plans it (installed and
 *   not hidden, never a package Belay never blocks or one sharing its uid), given to Android with
 *   DevicePolicyManager.setMeteredDataDisabledPackages (device owner only), which keeps each one
 *   off every metered network: mobile data, another phone's hotspot, Wi-Fi marked metered. Belay
 *   calls only when what it wants differs from what Android has, or an app on it was installed
 *   again (a new uid); a package Android refused isn't asked for again until something changes.
 *   The report (`enforcement.mobile_data`) is what Android keeps off mobile data for Belay now.
 * - Mobile data use, only while `measure` is on and Belay is device owner: the days core's
 *   DataUseUploads says are due (today about hourly, a day once more when it's complete), read
 *   from Android's own accounting (DataUseReader) and folded by core's DataUse, never naming the
 *   apps Belay never blocks, queued for `POST /mobile-data`. With `measure` off, Belay's record of
 *   it and every unsent day go: collecting is a parent's decision.
 *
 * Idempotent: a second step with nothing new calls nothing and queues nothing.
 */
class MobileDataStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext
    private val dpm = app.getSystemService(DevicePolicyManager::class.java)
    private val admin = DeviceOwnerSetup.admin(app)

    /** What the step stores (null: nothing changed), the problems for the report, and what the kid's screens list. */
    class Done(val write: AgentStore.MobileDataWrite?, val problems: List<String>, val report: WireMobileDataStatus?)

    /**
     * [inventory] is everything installed (hidden apps too), [hidden] what Belay hid, [protected]
     * NeverBlocked.of's map. [force]: read today's use now (a debug build's test hook).
     */
    fun run(
        policy: WirePolicy,
        owner: Boolean,
        inventory: Map<String, PackageRecord>,
        hidden: Set<String>,
        protected: Map<String, Protection>,
        now: Long,
        force: Boolean = false,
    ): Done {
        val stored = store.mobileDataState()
        val listed = WifiOnly.listed(policy.mobileData.wifiOnly)
        val problems = mutableListOf<String>()

        // Wi-Fi only.
        var android = if (owner) androidList() else null
        val plan = WifiOnly.plan(listed, inventory, hidden, protected, identities(listed.filter { it in inventory }))
        var applied = stored?.wifiOnly ?: WifiOnly.Applied()
        val call = WifiOnly.call(plan, applied, android)
        if (call != null) {
            try {
                // Android takes out what it can't restrict and returns it (an admin, a package that isn't there).
                val refused = dpm.setMeteredDataDisabledPackages(admin, call).orEmpty()
                applied = WifiOnly.asked(plan, call, refused)
                Log.i(Agent.TAG, "mobile data: Android keeps ${call.size} app${if (call.size == 1) "" else "s"} off mobile data" + if (refused.isEmpty()) "" else "; it refused $refused")
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "mobile data: Android refused the Wi-Fi-only apps", e)
                problems += "Android didn't let Belay keep apps off mobile data: ${e.javaClass.simpleName}."
            }
            android = androidList()
        }
        problems += plan.problems + WifiOnly.refusedProblems(applied.refused)
        val report = WifiOnly.report(listed, android)

        // Mobile data use: only as device owner (anyone else reads only their own).
        val measure = policy.mobileData.measure
        var uploads = stored?.uploads ?: DataUseUploads.State()
        val days = mutableListOf<WireMobileDataDay>()
        if (!measure) {
            uploads = DataUseUploads.State()
        } else if (owner) {
            val due = DataUseUploads.plan(true, uploads, ZoneId.systemDefault(), now, force)
            try {
                val reader = DataUseReader(app)
                for (range in due.read) {
                    val (rows, wifi) = reader.read(range)
                    days += DataUse.day(range, rows, wifi, protected.keys)
                }
                uploads = due.state
                if (days.isNotEmpty()) {
                    // Totals only: never an app's name in Belay's log.
                    Log.i(Agent.TAG, "mobile data: read ${days.size} day${if (days.size == 1) "" else "s"} of use (${days.joinToString { "${it.day}${if (it.complete) ", complete" else ""}" }})")
                }
            } catch (e: RuntimeException) {
                // Nothing is queued, and the same days are due at the next step.
                days.clear()
                Log.w(Agent.TAG, "mobile data: Android's accounting couldn't be read", e)
                problems += "Belay couldn't read how much mobile data apps use: ${e.javaClass.simpleName}."
            }
        }

        // The row stays while anything is listed, Android holds anything for Belay, or measuring is on.
        val anything = listed.isNotEmpty() || android.orEmpty().isNotEmpty() || applied.asked.isNotEmpty() || measure
        val state = if (anything) MobileDataState(wifiOnly = applied, report = report, uploads = uploads) else null
        val dropUnsent = !measure && store.pendingMobileDataCount() > 0
        val write = if (state != stored || days.isNotEmpty() || dropUnsent) AgentStore.MobileDataWrite(state, days, dropUnsent) else null
        return Done(write, problems, report)
    }

    /** Android's list for Belay (getMeteredDataDisabledPackages); null when it can't say. */
    private fun androidList(): List<String>? = try {
        dpm.getMeteredDataDisabledPackages(admin).orEmpty()
    } catch (e: SecurityException) {
        null
    }

    /**
     * Each installed package's uid and whether it shares it with another package (Android restricts
     * by uid: platform notes Q2, Q8). Hidden apps too (MATCH_UNINSTALLED_PACKAGES), so a blocked app
     * is told apart from one that isn't installed; a package PackageManager can't find is left out.
     */
    private fun identities(packages: List<String>): Map<String, WifiOnly.Identity> {
        val pm = app.packageManager
        return packages.mapNotNull { name ->
            val uid = try {
                pm.packageInfoCompat(name, PackageManager.MATCH_UNINSTALLED_PACKAGES).applicationInfo?.uid
            } catch (e: PackageManager.NameNotFoundException) {
                null
            } ?: return@mapNotNull null
            val sharing = pm.getPackagesForUid(uid).orEmpty().toSet() - name
            name to WifiOnly.Identity(uid, shared = sharing.isNotEmpty())
        }.toMap()
    }
}
