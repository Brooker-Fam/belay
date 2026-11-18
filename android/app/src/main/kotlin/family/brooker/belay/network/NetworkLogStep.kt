package family.brooker.belay.network

import android.app.admin.DevicePolicyManager
import android.app.admin.DnsEvent
import android.content.Context
import android.provider.Settings
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DebugTools
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.core.NeverBlocked
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.network.DnsLookup
import family.brooker.belay.core.network.Domains
import family.brooker.belay.core.network.NetworkDay
import family.brooker.belay.core.network.NetworkDigest
import family.brooker.belay.core.network.NetworkLog
import family.brooker.belay.core.network.NetworkLogState
import family.brooker.belay.enforce.PhoneFacts
import family.brooker.belay.store.AgentStore
import java.time.ZoneId

/**
 * Phase 3's network logging on the phone, on the agent thread (docs/platform-notes.md W1, W6 to W9).
 *
 * - [run], in every enforcement step: Android's network logging on exactly while the policy's
 *   `network_log` is (DevicePolicyManager.setNetworkLoggingEnabled, device owner only), and the
 *   report: whether Android logs, and whether it paused (another user or profile on the phone).
 *   With logging off, the days Belay was counting and every unsent day are deleted: collecting is a
 *   parent's decision, and nothing more is sent. When the family's private websites change, what
 *   the days kept counted of them goes, and each day that changed is queued again, in place of an
 *   unsent report (which never goes).
 * - [take], when Android says a batch is ready (AdminReceiver.onNetworkLogsAvailable): Belay takes
 *   it at once (Android discards a batch 5 minutes after it's taken), and any it missed, reads only
 *   the DNS lookups (never the connect events, an address and a port), reduces them to counts per
 *   app, per domain, per day (core's NetworkDigest), never keeping 988's websites or the family's
 *   private ones, and queues each changed day for the server. The raw events never reach storage,
 *   the outbox or Belay's log, and neither do the private websites' names: the log counts their
 *   lookups with 988's, as "private".
 *
 * Idempotent: a batch is taken once (core's NetworkLog.tokens), and a second step changes nothing.
 */
class NetworkLogStep(context: Context, private val store: AgentStore) {
    private val app = context.applicationContext
    private val dpm = app.getSystemService(DevicePolicyManager::class.java)
    private val admin = DeviceOwnerSetup.admin(app)

    /** What the step stores (null: nothing changed), and the problems for the report. */
    class Done(val write: AgentStore.NetworkWrite?, val problems: List<String>)

    /** What [take] did: how many days it queued, or that Android refused. */
    class Taken(val days: Int, val refused: Boolean = false)

    fun run(policy: WirePolicy, owner: Boolean, otherUsers: Int, now: Long): Done {
        val wanted = policy.networkLog.enabled
        val stored = store.networkState()
        val problems = mutableListOf<String>()
        var state = stored ?: NetworkLogState()
        var android = owner && androidLogs()
        if (owner && android != wanted) {
            try {
                dpm.setNetworkLoggingEnabled(admin, wanted)
                Log.i(Agent.TAG, "network logging: Android's turned ${if (wanted) "on" else "off"}")
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "network logging: Android refused to turn it ${if (wanted) "on" else "off"}", e)
                problems += "Android didn't let Belay turn network logging ${if (wanted) "on" else "off"}: ${e.javaClass.simpleName}."
            }
            android = androidLogs()
            // Android counts its batches from 1 again every time logging is turned on.
            if (wanted && android) state = NetworkLog.turnedOn(now, bootCount())
        }
        if (!wanted) {
            val report = NetworkLog.report(policyOn = false, androidOn = android, otherUsers = otherUsers, state = null)
            val anything = stored != null || report != null || store.networkDaySizes().isNotEmpty() || store.pendingNetworkCount() > 0
            return Done(if (anything) AgentStore.NetworkWrite(report?.let { NetworkLogState(report = it) }, dropDays = true) else null, problems)
        }
        if (android && state.enabledAt == null) state = NetworkLog.turnedOn(now, bootCount())
        // The family's private websites changed: what the days kept counted of them before goes, and
        // each day that changed is sent again, in place of an unsent report (which never goes).
        val private = Domains.privateSet(policy.networkLog.privateDomains)
        val digest = NetworkLog.digest(private)
        var cleared = emptyList<NetworkDay>()
        if (state.privateDigest != digest) {
            if (private.isNotEmpty()) cleared = store.allNetworkDays().mapNotNull { NetworkDigest.without(it, private) }
            state = state.copy(privateDigest = digest)
            // Counts only: never a name.
            if (cleared.isNotEmpty()) Log.i(Agent.TAG, "network logging: private websites taken out of ${cleared.size} day${if (cleared.size == 1) "" else "s"} kept, sent again")
        }
        state = state.copy(report = NetworkLog.report(policyOn = true, androidOn = android, otherUsers = otherUsers, state = state))
        return Done(
            if (state != stored || cleared.isNotEmpty()) AgentStore.NetworkWrite(state, cleared = cleared, resend = cleared.map(NetworkDigest::wire)) else null,
            problems,
        )
    }

    /**
     * Android's batch [token] is ready: takes it, and the ones missed since the last, and keeps what
     * they say as counts. Null when there's nothing to take: the policy doesn't log (the next step
     * turns Android's logging off), Belay isn't device owner, or the batch was taken already.
     */
    fun take(token: Long, now: Long): Taken? {
        val policy = DebugTools.policyOverride ?: store.policy()
        if (policy?.networkLog?.enabled != true) {
            Log.i(Agent.TAG, "network logging: Android offered batch $token, but the policy doesn't log: not taken")
            return null
        }
        if (!DeviceOwnerSetup.isDeviceOwner(app)) return null
        val boot = bootCount()
        var state = store.networkState() ?: NetworkLog.turnedOn(now, boot)
        val tokens = NetworkLog.tokens(state, token, boot)
        if (tokens.isEmpty()) return null
        val lookups = ArrayList<DnsLookup>()
        var events = 0
        for (t in tokens) {
            val batch = try {
                dpm.retrieveNetworkLogs(admin, t)
            } catch (e: SecurityException) {
                // Another user or profile is on the phone: Android pauses logging (platform notes W1, V2).
                Log.w(Agent.TAG, "network logging: Android refused batch $t (another user or profile?): ${e.message}")
                store.saveNetworkState(NetworkLog.refused(state, now), now)
                return Taken(0, refused = true)
            } ?: continue
            for (event in batch) {
                events++
                if (event is DnsEvent) lookups += DnsLookup(event.packageName, event.hostname, event.timestamp)
            }
        }
        val zone = ZoneId.systemDefault()
        val never = NeverBlocked.of(PhoneFacts.roles(app), store.loadBaseline().inventory, store.applied().hidden).keys
        val private = Domains.privateSet(policy.networkLog.privateDomains)
        val reduced = NetworkDigest.reduce(lookups, never, zone, now, private)
        val days = NetworkDigest.merge(store.networkDays(reduced.days.keys), reduced, zone, private)
        val wire = days.map(NetworkDigest::wire)
        state = NetworkLog.took(state, token, boot, now, lookups.size)
        store.commitNetwork(days, wire, state, NetworkDigest.keepFrom(zone, now), now)
        // Counts only: never a name Android logged.
        Log.i(
            Agent.TAG,
            "network logging: took batch${if (tokens.size == 1) "" else "es"} ${tokens.joinToString()}: $events events, ${lookups.size} lookups, " +
                "${reduced.kept} kept in ${days.size} day${if (days.size == 1) "" else "s"}" +
                if (reduced.skipped.isEmpty()) "" else "; not kept: ${reduced.skipped.entries.joinToString { "${it.key.name.lowercase()} ${it.value}" }}",
        )
        return Taken(wire.size)
    }

    /** Whether Android's network logging is on for Belay (false when it can't say). */
    private fun androidLogs(): Boolean = try {
        dpm.isNetworkLoggingEnabled(admin)
    } catch (e: SecurityException) {
        false
    }

    private fun bootCount(): Int? = Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 }
}
