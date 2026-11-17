package family.brooker.belay.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import java.net.URI

/**
 * Which Belay server this phone reports to, and how syncing is going. Kept in DataStore
 * (files/datastore/, excluded from backups like everything else). The token itself is only
 * here encrypted ([TokenVault]).
 */
data class Connection(
    /** The server's origin, like https://belay.example.org. */
    val server: String? = null,
    val deviceId: String? = null,
    /** What the parent's server calls this phone. Set by the parent: shown, never trusted. */
    val deviceName: String? = null,
    val enrolledAt: Long? = null,
    /** The device token, as [TokenVault.encrypt] sealed it. */
    val sealedToken: String? = null,
    /** Set when the server stopped accepting the token: the parent removed this phone. */
    val disconnectedAt: Long? = null,
    val disconnectReason: String? = null,
    /** The last request the server accepted. */
    val lastSyncAt: Long? = null,
    val lastCheckinAt: Long? = null,
    /** The last attempt that failed, after [lastSyncAt]; cleared by the next success. */
    val lastFailureAt: Long? = null,
    val lastFailure: String? = null,
    /** The server's clock minus the phone's, from the last answer. */
    val clockSkewMs: Long? = null,
    /** Set by enrollment until the full inventory that follows it is queued. */
    val inventoryWanted: Boolean = false,
) {
    val enrolled: Boolean get() = server != null && deviceId != null
    val connected: Boolean get() = enrolled && sealedToken != null && disconnectedAt == null
    val host: String? get() = server?.let { runCatching { URI(it).host }.getOrNull() }
}

private val Context.settings: DataStore<Preferences> by preferencesDataStore(name = "belay")

/**
 * Reads and writes [Connection]. The blocking calls are for the agent and sync threads;
 * the screen collects [flow].
 */
object ConnectionStore {
    private val SERVER = stringPreferencesKey("server")
    private val DEVICE_ID = stringPreferencesKey("device_id")
    private val DEVICE_NAME = stringPreferencesKey("device_name")
    private val ENROLLED_AT = longPreferencesKey("enrolled_at")
    private val TOKEN = stringPreferencesKey("device_token_sealed")
    private val DISCONNECTED_AT = longPreferencesKey("disconnected_at")
    private val DISCONNECT_REASON = stringPreferencesKey("disconnect_reason")
    private val LAST_SYNC_AT = longPreferencesKey("last_sync_at")
    private val LAST_CHECKIN_AT = longPreferencesKey("last_checkin_at")
    private val LAST_FAILURE_AT = longPreferencesKey("last_failure_at")
    private val LAST_FAILURE = stringPreferencesKey("last_failure")
    private val CLOCK_SKEW = longPreferencesKey("clock_skew_ms")
    private val INVENTORY_WANTED = booleanPreferencesKey("inventory_wanted")
    private val ALL = listOf(
        SERVER, DEVICE_ID, DEVICE_NAME, ENROLLED_AT, TOKEN, DISCONNECTED_AT, DISCONNECT_REASON,
        LAST_SYNC_AT, LAST_CHECKIN_AT, LAST_FAILURE_AT, LAST_FAILURE, CLOCK_SKEW, INVENTORY_WANTED,
    )

    fun flow(context: Context): Flow<Connection> = context.applicationContext.settings.data.map { it.toConnection() }

    fun read(context: Context): Connection = runBlocking { flow(context).first() }

    /** A new enrollment replaces the old one, and wants a full inventory at once. */
    fun enrolled(
        context: Context,
        server: String,
        deviceId: String,
        deviceName: String,
        sealedToken: String,
        at: Long,
        clockSkewMs: Long,
    ) = edit(context) {
        ALL.forEach { key -> it -= key }
        it[SERVER] = server
        it[DEVICE_ID] = deviceId
        it[DEVICE_NAME] = deviceName
        it[ENROLLED_AT] = at
        it[TOKEN] = sealedToken
        it[LAST_SYNC_AT] = at
        it[CLOCK_SKEW] = clockSkewMs
        it[INVENTORY_WANTED] = true
    }

    fun inventoryQueued(context: Context) = edit(context) { it.remove(INVENTORY_WANTED) }

    /** The server answered [at]; [checkin] when the answer was to a check-in. */
    fun synced(context: Context, at: Long, clockSkewMs: Long?, checkin: Boolean) = edit(context) {
        it[LAST_SYNC_AT] = at
        if (checkin) it[LAST_CHECKIN_AT] = at
        if (clockSkewMs != null) it[CLOCK_SKEW] = clockSkewMs
        it.remove(LAST_FAILURE_AT)
        it.remove(LAST_FAILURE)
    }

    fun failed(context: Context, at: Long, reason: String) = edit(context) {
        it[LAST_FAILURE_AT] = at
        it[LAST_FAILURE] = reason.take(300)
    }

    /** The server no longer takes this phone's token. The token is useless now: forget it. */
    fun disconnected(context: Context, at: Long, reason: String) = edit(context) {
        it[DISCONNECTED_AT] = at
        it[DISCONNECT_REASON] = reason.take(300)
        it.remove(TOKEN)
    }

    private fun edit(context: Context, change: (MutablePreferences) -> Unit) {
        runBlocking { context.applicationContext.settings.edit { change(it) } }
    }

    private fun Preferences.toConnection() = Connection(
        server = this[SERVER],
        deviceId = this[DEVICE_ID],
        deviceName = this[DEVICE_NAME],
        enrolledAt = this[ENROLLED_AT],
        sealedToken = this[TOKEN],
        disconnectedAt = this[DISCONNECTED_AT],
        disconnectReason = this[DISCONNECT_REASON],
        lastSyncAt = this[LAST_SYNC_AT],
        lastCheckinAt = this[LAST_CHECKIN_AT],
        lastFailureAt = this[LAST_FAILURE_AT],
        lastFailure = this[LAST_FAILURE],
        clockSkewMs = this[CLOCK_SKEW],
        inventoryWanted = this[INVENTORY_WANTED] == true,
    )
}
