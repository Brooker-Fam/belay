package family.brooker.belay.update

import android.content.Context
import android.content.pm.PackageInstaller
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.BuildConfig
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger
import family.brooker.belay.core.AgentUpdates
import family.brooker.belay.core.AgentUpdates.failed
import family.brooker.belay.core.UpdateCheck
import family.brooker.belay.core.UpdateRecord
import family.brooker.belay.core.UpdateStep
import family.brooker.belay.core.WireAgentUpdate
import family.brooker.belay.core.WireUpdateState
import family.brooker.belay.service.ParentNotice
import family.brooker.belay.settings.ConnectionStore
import family.brooker.belay.settings.TokenVault
import family.brooker.belay.store.AgentStore
import family.brooker.belay.sync.Sync
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Phase 6: Belay updates itself to the version a parent approved (the policy's agent_update),
 * on its own thread, never the agent's: download (UpdateDownload: resuming, capped, hashed),
 * check (core's AgentUpdates.check: the offered file, Belay itself, exactly the offered version
 * code, newer, the same signing certificates), install (SelfInstaller: a device owner's
 * session, silent). What to do next is core's AgentUpdates.next; this thread is the only
 * writer of the agent_update row, and records each state before the next step, since an
 * install ends with Android killing this Belay and starting the new one (MY_PACKAGE_REPLACED,
 * the agent's AGENT_UPDATED step), which then sees by its version code that it's done.
 *
 * Each recorded state reaches the server within seconds (an agent step, whose report changed,
 * checks in). Failures wait (a minute, doubling to six hours), and a file that can't pass the
 * checks is never tried again: no loops.
 */
object AgentUpdater {
    private val executor = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "belay-update") }
    private val queued = AtomicBoolean(false)

    @Volatile
    private var offer: WireAgentUpdate? = null

    @Volatile
    private var later: ScheduledFuture<*>? = null

    /** From every agent step: the update the applied policy offers (null: none). */
    fun offered(context: Context, offer: WireAgentUpdate?) {
        this.offer = offer
        poke(context.applicationContext)
    }

    /** A network came back: a download that waited for one goes now. */
    fun networkBack(context: Context) {
        if (offer != null) poke(context.applicationContext)
    }

    /** Android's answer to the session (InstallStatusReceiver); [done] runs afterwards. */
    fun installed(context: Context, sha256: String?, status: Int, message: String?, sessionId: Int, done: () -> Unit) {
        val app = context.applicationContext
        executor.execute {
            try {
                answer(app, sha256, status, message, sessionId)
            } catch (t: Throwable) {
                Log.e(Agent.TAG, "update: Android's answer not recorded", t)
            } finally {
                done()
            }
        }
    }

    private fun poke(app: Context) {
        if (!queued.compareAndSet(false, true)) return
        executor.execute {
            queued.set(false)
            try {
                step(app)
            } catch (t: Throwable) {
                Log.e(Agent.TAG, "update step failed", t)
            }
        }
    }

    private fun step(app: Context) {
        val store = AgentStore.get(app)
        val offer = offer
        val record = store.agentUpdate()
        val now = System.currentTimeMillis()
        when (val next = AgentUpdates.next(offer, record, BuildConfig.VERSION_CODE.toLong(), now)) {
            UpdateStep.Idle -> if (offer == null || record?.final == true) UpdateDownload.keepOnly(app, null)
            is UpdateStep.Save -> save(app, store, record, next.record)
            is UpdateStep.Later -> wake(app, next.at - now)
            is UpdateStep.Start -> if (offer != null) run(app, store, record, next.record, offer)
        }
    }

    /** Download, check and install [start]'s offer. Each state is recorded before it begins. */
    private fun run(app: Context, store: AgentStore, before: UpdateRecord?, start: UpdateRecord, offer: WireAgentUpdate) {
        if (!DeviceOwnerSetup.isDeviceOwner(app)) {
            return save(app, store, before, start.failed("Belay isn't the device owner, so it can't update itself.", System.currentTimeMillis()))
        }
        val connection = ConnectionStore.read(app)
        val server = connection.server
        val token = connection.sealedToken?.let(TokenVault::decrypt)
        if (!connection.connected || server == null || token == null) {
            return save(app, store, before, start.failed("Belay isn't connected to its server, so it can't download the update.", System.currentTimeMillis()))
        }
        if (!Sync.online(app)) {
            // Not a failure: the next network (networkBack) or step goes on.
            if (before?.state != WireUpdateState.DOWNLOADING || before.sha256 != start.sha256) save(app, store, before, start)
            Log.i(Agent.TAG, "update: offline; downloading when there's a network")
            return
        }
        save(app, store, before, start)
        Log.i(Agent.TAG, "update: downloading version ${offer.versionCode} (${offer.size} bytes)")
        val download = when (val result = UpdateDownload(app).fetch(server, token, offer)) {
            is UpdateDownload.Result.Failed -> {
                if (result.disconnect) Sync.disconnect(app, "HTTP 401 invalid_token (update)")
                return save(app, store, start, start.failed(result.problem, System.currentTimeMillis(), retryAfterMs = result.retryAfterMs))
            }
            is UpdateDownload.Result.Done -> result
        }

        val checking = start.copy(state = WireUpdateState.CHECKING, at = System.currentTimeMillis())
        save(app, store, start, checking)
        val verdict = AgentUpdates.check(offer, download.facts, Apks.archive(app, download.file), Apks.self(app))
        if (verdict is UpdateCheck.Refused) {
            // A file that isn't the offered one is fetched again from the start.
            if (!verdict.final) download.file.delete()
            Log.w(Agent.TAG, "update: refused: ${verdict.problem}")
            return save(app, store, checking, checking.failed(verdict.problem, System.currentTimeMillis(), final = verdict.final))
        }

        // Recorded before the commit: Android kills this Belay once the new one is installed.
        val installing = checking.copy(state = WireUpdateState.INSTALLING, at = System.currentTimeMillis(), installed = true)
        save(app, store, checking, installing)
        Log.i(Agent.TAG, "update: installing version ${offer.versionCode}")
        try {
            SelfInstaller.commitSelf(app, download.file, offer.sha256)
        } catch (e: IOException) {
            save(app, store, installing, installing.copy(installed = false).failed(androidCouldNot(e), System.currentTimeMillis()))
        } catch (e: RuntimeException) {
            save(app, store, installing, installing.copy(installed = false).failed(androidCouldNot(e), System.currentTimeMillis()))
        }
    }

    private fun answer(app: Context, sha256: String?, status: Int, message: String?, sessionId: Int) {
        val store = AgentStore.get(app)
        val record = store.agentUpdate()
        if (record == null || record.sha256 != sha256 || record.state != WireUpdateState.INSTALLING) return
        val now = System.currentTimeMillis()
        when (status) {
            // Android kills this Belay next; the new one records that it's done.
            PackageInstaller.STATUS_SUCCESS -> Log.i(Agent.TAG, "update: installed; Android starts the new Belay")
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Never for a device owner. Nobody is asked: the session goes.
                SelfInstaller.abandon(app, sessionId)
                save(app, store, record, record.copy(installed = false).failed(ASKED_FOR_CONFIRMATION, now))
            }
            else -> {
                val problem = AgentUpdates.androidSaid(message, status)
                save(app, store, record, record.copy(installed = false).failed(problem, now, final = AgentUpdates.installFailureIsFinal(status)))
            }
        }
    }

    /** Records [after]; tells the kid when it finished Belay's own update, and the agent, which reports it. */
    private fun save(app: Context, store: AgentStore, before: UpdateRecord?, after: UpdateRecord) {
        store.saveAgentUpdate(after, System.currentTimeMillis())
        if (after.state != before?.state || after.sha256 != before.sha256) {
            Log.i(Agent.TAG, "update: version ${after.versionCode} ${after.state.name.lowercase()}" + (after.problem?.let { ": $it" } ?: ""))
        }
        if (AgentUpdates.justUpdated(before, after)) ParentNotice.updated(app, BuildConfig.VERSION_NAME)
        if (after.state == WireUpdateState.DONE || after.final) UpdateDownload.keepOnly(app, null)
        after.retryAt?.let { wake(app, it - System.currentTimeMillis()) }
        Agent.handle(app, Trigger.AGENT_UPDATE)
        Sync.checkinSoon(app)
    }

    /** Looks again in [delayMs]; replaces an earlier wake. Lost with the process: every agent step looks again too. */
    private fun wake(app: Context, delayMs: Long) {
        later?.cancel(false)
        later = executor.schedule({ poke(app) }, delayMs.coerceAtLeast(MIN_WAKE_MS), TimeUnit.MILLISECONDS)
    }

    private fun androidCouldNot(e: Exception) = "Android couldn't take the update: ${e.javaClass.simpleName}${e.message?.let { ": $it" } ?: ""}"

    private const val ASKED_FOR_CONFIRMATION =
        "Android asked for someone to confirm the update on the phone, so Belay stopped it. Is Belay still the device owner?"
    private const val MIN_WAKE_MS = 1_000L
}
