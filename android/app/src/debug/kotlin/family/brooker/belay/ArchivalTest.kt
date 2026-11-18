package family.brooker.belay

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.AppOpsManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.RestrictionsManager
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.UserManager
import android.provider.Telephony
import android.util.AtomicFile
import android.util.Log
import androidx.core.os.BundleCompat
import family.brooker.belay.archival.ArchivalLog
import family.brooker.belay.archival.ArchivalRead
import family.brooker.belay.archival.ArchivalStop
import family.brooker.belay.archival.ArchivalTestState
import family.brooker.belay.archival.ArchivalVia
import family.brooker.belay.archival.UriRead
import family.brooker.belay.calls.Dialer
import family.brooker.belay.core.DataCategory
import family.brooker.belay.service.ManagedNotice
import family.brooker.belay.ui.KidWords
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonElement
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.time.ZoneId
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Debug builds only (this file, ArchivalService.kt, DebugArchivalReceiver.kt, the archival/ directory,
 * their manifest entries and strings are in src/debug; release builds have none of it, and CI checks
 * the release APK's manifest and classes): the archival test for the Pixel, T8 in
 * docs/phase5-checklist.md. For a time box, an hour unless asked (ArchivalLog), Belay is Google
 * Messages' archival app as its docs describe one (docs/platform-notes.md T8):
 *
 * - Google Messages' managed configuration gets `messages_archival` = Belay's package name
 *   (setApplicationRestrictions, keeping any other key). Android 17 then grants Belay the
 *   restricted-messages app-op while Google Messages is the SMS app (RcsArchivalAppTracker).
 * - Belay holds READ_SMS, granted by policy: DeviceOwnerSetup's plan wants it only while the test is
 *   on, and denies it by policy otherwise. An adb install allowlists it (platform notes I4).
 * - The archival service, and a receiver for the same update (the docs call it a broadcast too),
 *   are enabled; the manifest has them disabled.
 *
 * Each update is kept as ArchivalLog keeps it: never a value from a message, and nothing is sent.
 * Stopping (over adb, at the end of the time box, or for "Release this phone") takes it all back in
 * the other order: the configuration first, then the service, and READ_SMS last, after the answer is
 * out (denying a granted permission restarts Belay, platform notes L7). While it's on, the managed
 * notice and "What your parent can see" say so. The state is one small file,
 * no_backup/debug-archival-test.json, with one writer: this object's thread.
 */
object ArchivalTest {
    const val READ_SMS = Manifest.permission.READ_SMS

    /** AppOpsManager.OPSTR_READ_RESTRICTED_MESSAGES (a system API): Belay only reads its own mode. */
    private const val OP_READ_RESTRICTED = "android:read_restricted_messages"
    private const val FILE = "debug-archival-test.json"
    private const val CATEGORY_ID = "debug_archival_test"

    /** One thread for the test's own work (start, stop, each update), so its file has one writer. */
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-archival") }
    private val lock = Any()

    @Volatile
    private var cached: ArchivalTestState? = null
    private val seen = MutableStateFlow<List<DataCategory>>(emptyList())
    private val seenFlow = seen.asStateFlow()

    /** What the adb switch prints: [ok] is RESULT_OK, else 1. */
    class Answer(val ok: Boolean, val text: String)

    /**
     * The test's state, read from its file once per process. Before the first unlock after a restart
     * the file can't be read (no agent step runs then): off for now, and read once it can be.
     */
    fun state(context: Context): ArchivalTestState {
        cached?.let { return it }
        val app = context.applicationContext
        if (app.getSystemService(UserManager::class.java)?.isUserUnlocked == false) return ArchivalTestState()
        synchronized(lock) {
            cached?.let { return it }
            val loaded = load(app)
            cached = loaded
            publish(app, loaded)
            return loaded
        }
    }

    fun isOn(context: Context, now: Long = System.currentTimeMillis()): Boolean = ArchivalLog.isOn(state(context), now)

    /** "What your parent can see" while the test is on: what it collects, in the kid's words. */
    fun canSee(context: Context): StateFlow<List<DataCategory>> {
        state(context)
        return seenFlow
    }

    /** The managed notice's line while the test is on, in the kid's words; null otherwise. */
    fun noticeLine(context: Context): String? {
        val state = state(context)
        val now = System.currentTimeMillis()
        val until = state.until?.takeIf { ArchivalLog.isOn(state, now) } ?: return null
        return context.getString(R.string.archival_notice, KidWords(context) { it }.until(until, now))
    }

    /** The test's state for the debug state file (DebugTools.afterStep): counts and names, never a value. */
    fun json(context: Context): JsonElement = ArchivalLog.JSON.encodeToJsonElement(ArchivalTestState.serializer(), state(context))

    /**
     * The adb switch (DebugArchivalReceiver): [what] is "start", "stop" or "status". On the test's
     * thread; [done] gets the answer there, before anything restarts Belay.
     */
    fun command(context: Context, what: String?, minutes: Int?, done: (Answer) -> Unit) {
        val app = context.applicationContext
        executor.execute {
            val answer = try {
                when (what) {
                    "start" -> start(app, ArchivalLog.minutes(minutes))
                    "stop" -> stop(app, ArchivalStop.ADB)
                    "status", null -> Answer(true, "${ArchivalLog.summary(state(app), System.currentTimeMillis(), ZoneId.systemDefault())}; ${facts(app)}")
                    else -> Answer(false, "Say --es command start, stop or status.")
                }
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "archival test: $what failed", e)
                Answer(false, "failed: ${e.javaClass.simpleName}")
            }
            safely("answering") { done(answer) }
            settle(app)
        }
    }

    /**
     * An update from Google Messages (ArchivalService, ArchivalUpdateReceiver), on the test's thread:
     * when it came, how, its extras' names (never their values) and, for a message URI, what a query of
     * it gives: its column names and row count, and no value from any row. Kept only while the test is
     * on. [done] runs afterwards, there.
     */
    fun update(context: Context, via: ArchivalVia, intent: Intent?, done: () -> Unit) {
        val app = context.applicationContext
        val at = System.currentTimeMillis()
        executor.execute {
            try {
                val state = state(app)
                if (intent?.action != ArchivalLog.ACTION || !ArchivalLog.isOn(state, at)) {
                    Log.i(Agent.TAG, "archival test: an update by ${via.name.lowercase()} while the test is off, not kept")
                } else {
                    val extras = intent.extras
                    // Extras another app can't unparcel still leave the update counted, with no names.
                    val names = try {
                        extras?.keySet().orEmpty()
                    } catch (e: RuntimeException) {
                        Log.w(Agent.TAG, "archival test: an update's extras couldn't be read", e)
                        emptySet()
                    }
                    val read = if (extras != null && ArchivalLog.EXTRA_URI in names) read(app, extras) else null
                    save(app, ArchivalLog.record(state, ArchivalLog.update(at, via, names, read)))
                    Log.i(Agent.TAG, "archival test: an update by ${via.name.lowercase()}" + (read?.let { ", its URI: ${it.outcome.name.lowercase()}" } ?: ""))
                }
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "archival test: an update wasn't kept", e)
            } finally {
                safely("finishing an update") { done() }
            }
        }
    }

    /**
     * After each agent step, on the agent thread: a test whose time is up goes off (if the alarm came
     * while the phone was off, or never), and one that's on has its alarm, which a restart loses.
     */
    fun afterStep(context: Context) {
        val app = context.applicationContext
        val state = state(app)
        when {
            ArchivalLog.expired(state, System.currentTimeMillis()) -> expire(app) {}
            state.on -> ArchivalTimer.schedule(app, state.until)
        }
    }

    /** The time box's end (ArchivalTimerReceiver, or a step that found it past): the test goes off. */
    fun expire(context: Context, done: () -> Unit) {
        val app = context.applicationContext
        executor.execute {
            try {
                val state = state(app)
                if (ArchivalLog.expired(state, System.currentTimeMillis())) {
                    stop(app, ArchivalStop.TIME_UP)
                } else if (state.on) {
                    ArchivalTimer.schedule(app, state.until)
                }
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "archival test: the time box couldn't end it", e)
            } finally {
                safely("finishing the time box") { done() }
            }
            settle(app)
        }
    }

    /**
     * "Release this phone" (DebugTools.releasePhone): off before Belay stops being device owner, while
     * it can still take Google Messages' configuration back (releasing drops Belay's policies, but
     * Android's archival tracker only hears of a change made with setApplicationRestrictions). READ_SMS
     * stays granted: denying it would restart Belay before the release; uninstalling takes it.
     */
    fun stopForRelease(context: Context) {
        val app = context.applicationContext
        try {
            executor.submit { stop(app, ArchivalStop.RELEASED) }.get(10, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w(Agent.TAG, "archival test: not stopped before the release", e)
        }
    }

    private fun start(app: Context, minutes: Int): Answer {
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val pkg = app.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return Answer(false, "Belay isn't the device owner.")
        if (googleMessages(app) == null) return Answer(false, "Google Messages isn't installed.")
        val now = System.currentTimeMillis()
        // First: from here on a step's permission plan wants READ_SMS (DeviceOwnerSetup), so none takes it.
        save(app, ArchivalLog.start(state(app), now, minutes))
        components(app, on = true)
        val admin = DeviceOwnerSetup.admin(app)
        val granted = try {
            dpm.setPermissionGrantState(admin, pkg, READ_SMS, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "archival test: READ_SMS not granted", e)
            false
        }
        // Last: Google Messages names Belay only once its service is there.
        try {
            config(dpm, admin, pkg, on = true)
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "archival test: Google Messages' configuration refused", e)
            stop(app, ArchivalStop.START_FAILED)
            return Answer(false, "Google Messages' configuration was refused (${e.javaClass.simpleName}), so the test is off again.")
        }
        val state = state(app)
        ArchivalTimer.schedule(app, state.until)
        views(app, state)
        Log.i(Agent.TAG, "archival test: on until ${state.until}")
        val refused = if (granted) "" else "; READ_SMS was refused"
        return Answer(true, "${ArchivalLog.summary(state, now, ZoneId.systemDefault())}; ${facts(app)}$refused")
    }

    private fun stop(app: Context, why: ArchivalStop): Answer {
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val pkg = app.packageName
        val owner = dpm.isDeviceOwnerApp(pkg)
        val problems = mutableListOf<String>()
        // First: Google Messages stops naming Belay.
        if (owner) {
            try {
                config(dpm, DeviceOwnerSetup.admin(app), pkg, on = false)
            } catch (e: RuntimeException) {
                Log.w(Agent.TAG, "archival test: Google Messages' configuration not taken back", e)
                problems += "Google Messages' configuration wasn't taken back (${e.javaClass.simpleName})"
            }
        }
        components(app, on = false)
        val now = System.currentTimeMillis()
        val state = ArchivalLog.stop(state(app), now, why)
        save(app, state)
        ArchivalTimer.schedule(app, null)
        views(app, state)
        Log.i(Agent.TAG, "archival test: off (${why.name.lowercase()})")
        val readSms = when {
            !granted(app) -> ""
            owner && why != ArchivalStop.RELEASED -> "; READ_SMS is denied by policy next, and Android restarts Belay"
            else -> "; Belay still holds READ_SMS (uninstalling it takes it)"
        }
        val text = "${ArchivalLog.summary(state, now, ZoneId.systemDefault())}$readSms" + problems.joinToString("") { "; $it" }
        return Answer(problems.isEmpty(), text)
    }

    /**
     * Last, after the answer is out: with the test off and READ_SMS still granted, a step and then its
     * permissions' last word (DeviceOwnerSetup.revokeUnwanted) deny it by policy; Android then restarts
     * Belay, and its service comes back by itself (platform notes L7).
     */
    private fun settle(app: Context) = safely("looking at READ_SMS") {
        if (isOn(app) || !granted(app) || !DeviceOwnerSetup.isDeviceOwner(app)) return@safely
        Agent.handle(app, Trigger.POLICY_TIMER) { safely("denying READ_SMS") { DeviceOwnerSetup.revokeUnwanted(app) } }
    }

    /** Google Messages' managed configuration with `messages_archival` naming Belay ([on]), or without it, keeping any other key. */
    private fun config(dpm: DevicePolicyManager, admin: ComponentName, pkg: String, on: Boolean) {
        val config = Bundle(dpm.getApplicationRestrictions(admin, ArchivalLog.GOOGLE_MESSAGES))
        if (on) {
            if (config.getString(ArchivalLog.KEY) == pkg) return
            config.putString(ArchivalLog.KEY, pkg)
        } else {
            if (!config.containsKey(ArchivalLog.KEY)) return
            config.remove(ArchivalLog.KEY)
        }
        dpm.setApplicationRestrictions(admin, ArchivalLog.GOOGLE_MESSAGES, config)
    }

    /** The archival service and receiver: enabled while the test is on, as the manifest has them (disabled) otherwise. */
    private fun components(app: Context, on: Boolean) {
        val state = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
        for (component in components(app)) app.packageManager.setComponentEnabledSetting(component, state, PackageManager.DONT_KILL_APP)
    }

    private fun components(app: Context) = listOf(ComponentName(app, ArchivalService::class.java), ComponentName(app, ArchivalUpdateReceiver::class.java))

    /**
     * What an update's message URI gives Belay: only a URI in the phone's message store is read, once,
     * for its column names and row count. No value is read from any row, and the URI isn't kept.
     */
    private fun read(app: Context, extras: Bundle): UriRead {
        val uri = try {
            BundleCompat.getParcelable(extras, ArchivalLog.EXTRA_URI, Uri::class.java) ?: extras.getString(ArchivalLog.EXTRA_URI)?.let(Uri::parse)
        } catch (e: RuntimeException) {
            null
        } ?: return UriRead(ArchivalRead.NOT_A_URI)
        if (uri.scheme != ContentResolver.SCHEME_CONTENT || !ArchivalLog.readable(uri.authority)) return UriRead(ArchivalRead.NOT_MESSAGES)
        return try {
            app.contentResolver.query(uri, null, null, null, null)?.use { cursor -> ArchivalLog.read(cursor.columnNames?.toList(), cursor.count) }
                ?: UriRead(ArchivalRead.NO_CURSOR)
        } catch (e: RuntimeException) {
            ArchivalLog.failed(e.javaClass.simpleName)
        }
    }

    /** What the Pixel test needs to know besides the counts, for the adb switch's answer. Never a value from a message. */
    private fun facts(app: Context): String {
        val dpm = app.getSystemService(DevicePolicyManager::class.java)
        val pkg = app.packageName
        val messages = googleMessages(app)
        val parts = mutableListOf<String>()
        parts += if (messages == null) {
            "Google Messages isn't installed"
        } else {
            "Google Messages ${ArchivalLog.clean(messages.versionName ?: "?", 40)} (${messages.longVersionCode})${schema(app)}"
        }
        parts += "default SMS app: ${Telephony.Sms.getDefaultSmsPackage(app) ?: "none"}"
        parts += if (dpm.isDeviceOwnerApp(pkg)) {
            val value = dpm.getApplicationRestrictions(DeviceOwnerSetup.admin(app), ArchivalLog.GOOGLE_MESSAGES).getString(ArchivalLog.KEY)
            "messages_archival: " + when (value) {
                null -> "not set"
                pkg -> "Belay"
                else -> "another app"
            }
        } else {
            "Belay isn't the device owner"
        }
        parts += "READ_SMS: " + if (granted(app)) "granted" else "not granted"
        parts += "restricted messages: ${restrictedMessages(app)}"
        parts += "Belay is the phone app: " + if (Dialer.isDialer(app)) "yes" else "no"
        val enabled = components(app).all { app.packageManager.getComponentEnabledSetting(it) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED }
        parts += "archival service: " + if (enabled) "on" else "off"
        return parts.joinToString("; ")
    }

    /** Whether Google Messages' own configuration schema has `messages_archival` (never its titles, which its developer wrote). */
    private fun schema(app: Context): String = try {
        val entries = app.getSystemService(RestrictionsManager::class.java).getManifestRestrictions(ArchivalLog.GOOGLE_MESSAGES)
        when {
            entries == null -> ", no configuration schema"
            entries.any { it.key == ArchivalLog.KEY } -> ", its schema has ${ArchivalLog.KEY}"
            else -> ", its schema doesn't have ${ArchivalLog.KEY}"
        }
    } catch (e: RuntimeException) {
        ", its schema couldn't be read (${e.javaClass.simpleName})"
    }

    /** Belay's own restricted-messages app-op (Android grants it to the archival app, and to the dialer role). */
    private fun restrictedMessages(app: Context): String = try {
        when (val mode = app.getSystemService(AppOpsManager::class.java).unsafeCheckOpNoThrow(OP_READ_RESTRICTED, Process.myUid(), app.packageName)) {
            AppOpsManager.MODE_ALLOWED -> "allowed"
            AppOpsManager.MODE_IGNORED -> "not allowed"
            AppOpsManager.MODE_ERRORED -> "not allowed (errored)"
            AppOpsManager.MODE_DEFAULT -> "default"
            AppOpsManager.MODE_FOREGROUND -> "in the foreground only"
            else -> "mode $mode"
        }
    } catch (e: RuntimeException) {
        "unknown (${e.javaClass.simpleName})"
    }

    private fun googleMessages(app: Context): PackageInfo? = try {
        app.packageManager.getPackageInfo(ArchivalLog.GOOGLE_MESSAGES, 0)
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }

    private fun granted(app: Context): Boolean = app.checkSelfPermission(READ_SMS) == PackageManager.PERMISSION_GRANTED

    /** Nothing may escape the test's thread: an uncaught exception would crash Belay. */
    private inline fun safely(what: String, block: () -> Unit) {
        try {
            block()
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "archival test: $what failed", e)
        }
    }

    /** The kid's two places: "What your parent can see" (MainScreen) and the managed notice. */
    private fun views(app: Context, state: ArchivalTestState) {
        publish(app, state)
        ManagedNotice.refresh(app)
    }

    private fun publish(app: Context, state: ArchivalTestState) {
        val now = System.currentTimeMillis()
        val until = state.until?.takeIf { ArchivalLog.isOn(state, now) }
        seen.value = if (until == null) {
            emptyList()
        } else {
            val details = listOf(R.string.archival_can_see_counts, R.string.archival_can_see_never, R.string.archival_can_see_stays, R.string.archival_can_see_google)
            listOf(DataCategory(CATEGORY_ID, app.getString(R.string.archival_can_see_title, KidWords(app) { it }.until(until, now)), details.map(app::getString)))
        }
    }

    private fun load(app: Context): ArchivalTestState {
        val file = AtomicFile(File(app.noBackupFilesDir, FILE))
        return try {
            ArchivalLog.JSON.decodeFromString(ArchivalTestState.serializer(), file.readFully().decodeToString())
        } catch (e: FileNotFoundException) {
            ArchivalTestState()
        } catch (e: IOException) {
            Log.w(Agent.TAG, "archival test: its file couldn't be read", e)
            ArchivalTestState()
        } catch (e: IllegalArgumentException) {
            // A damaged file (kotlinx's SerializationException is one): the test is off.
            Log.w(Agent.TAG, "archival test: its file couldn't be read", e)
            ArchivalTestState()
        }
    }

    /** In memory at once (the agent's permission plan reads it), then in the file. */
    private fun save(app: Context, state: ArchivalTestState) {
        synchronized(lock) { cached = state }
        val file = AtomicFile(File(app.noBackupFilesDir, FILE))
        val out = try {
            file.startWrite()
        } catch (e: IOException) {
            Log.w(Agent.TAG, "archival test: its file wasn't written", e)
            return
        }
        try {
            out.write(ArchivalLog.JSON.encodeToString(ArchivalTestState.serializer(), state).encodeToByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            Log.w(Agent.TAG, "archival test: its file wasn't written", e)
        }
    }
}

/**
 * The archival test's time box: one alarm at its end, like LocationTimer's (exact while Belay is on
 * the battery allowlist or holds USE_EXACT_ALARM, docs/platform-notes.md S6). A restart loses it: the
 * next step sets it again, or ends a test whose time is up (ArchivalTest.afterStep).
 */
object ArchivalTimer {
    @Volatile
    private var scheduledAt: Long? = null

    @SuppressLint("MissingPermission")
    fun schedule(context: Context, at: Long?) {
        if (at == scheduledAt) return
        val app = context.applicationContext
        val am = app.getSystemService(AlarmManager::class.java) ?: return
        val intent = PendingIntent.getBroadcast(
            app,
            0,
            Intent(app, ArchivalTimerReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        try {
            when {
                at == null -> am.cancel(intent)
                am.canScheduleExactAlarms() -> am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
                else -> am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            }
            scheduledAt = at
        } catch (e: SecurityException) {
            Log.w(Agent.TAG, "archival test: its alarm wasn't set", e)
        }
    }

    fun fired() {
        scheduledAt = null
    }
}

/** Not exported: only Belay's own alarm reaches it. */
class ArchivalTimerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ArchivalTimer.fired()
        val pending = goAsync()
        ArchivalTest.expire(context) { pending.finish() }
    }
}
