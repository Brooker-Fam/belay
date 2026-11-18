package family.brooker.belay

import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.core.mobiledata.DataUseUploads
import family.brooker.belay.core.mobiledata.MobileDataState
import family.brooker.belay.core.mobiledata.WifiOnly
import family.brooker.belay.core.mobiledata.WireMobileData
import family.brooker.belay.core.mobiledata.WireMobileDataApp
import family.brooker.belay.core.mobiledata.WireMobileDataDay
import family.brooker.belay.core.mobiledata.WireMobileDataStatus
import family.brooker.belay.store.AgentStore
import family.brooker.belay.store.BelayDatabase
import family.brooker.belay.store.OutboxRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Room's database across a new version, as a phone that updates Belay has it: a version 7
 * database (Phase 3's network logging), made from Room's exported schema (app/schemas, which the
 * test APK carries as assets) with rows in it, opens with Room at version 8 (Phase 13, mobile
 * data). Room migrates it by itself (AutoMigration: a new table only) and checks every table
 * against version 8's; the rows are still there, and the new table works. Made-up apps only.
 */
@RunWith(AndroidJUnit4::class)
class MigrationInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val name = "migration-test-${System.nanoTime()}.db"
    private lateinit var dir: File

    @Before
    fun clean() {
        context.deleteDatabase(name)
        dir = File(context.cacheDir, "migration-test-${System.nanoTime()}").apply { mkdirs() }
    }

    @After
    fun remove() {
        context.deleteDatabase(name)
        dir.deleteRecursively()
    }

    /** Room's exported schema for [version], from the test APK's assets. */
    private fun schema(version: Int): JsonObject {
        val text = instrumentation.context.assets.open("${BelayDatabase::class.java.name}/$version.json").bufferedReader().use { it.readText() }
        return Json.parseToJsonElement(text).jsonObject.getValue("database").jsonObject
    }

    /** A database as Room made it at [version], from its exported schema: the tables, their indices, and Room's own record. */
    private fun create(version: Int, rows: (SQLiteDatabase) -> Unit) {
        val schema = schema(version)
        assertEquals(version, schema.getValue("version").jsonPrimitive.int)
        val file = context.getDatabasePath(name).apply { parentFile?.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            for (entity in schema.getValue("entities").jsonArray.map { it.jsonObject }) {
                val table = entity.getValue("tableName").jsonPrimitive.content
                db.execSQL(entity.getValue("createSql").jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                entity["indices"]?.jsonArray?.forEach { index ->
                    db.execSQL(index.jsonObject.getValue("createSql").jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                }
            }
            schema.getValue("setupQueries").jsonArray.forEach { db.execSQL(it.jsonPrimitive.content) }
            rows(db)
            db.version = version
        }
    }

    @Test
    fun aVersion7DatabaseOpensAtVersion8WithItsRowsAndTheMobileDataTable() {
        val policy = WirePolicy(version = 7)
        create(7) { db ->
            db.execSQL(
                "INSERT INTO policy (id, version, policy, received_at) VALUES (0, ?, ?, ?)",
                arrayOf<Any>(policy.version, Wire.json.encodeToString(WirePolicy.serializer(), policy), T0),
            )
            db.execSQL(
                "INSERT INTO outbox (type, item_id, package_name, payload, created_at, attempts, next_attempt_at, last_error, state, finished_at) " +
                    "VALUES ('network', 'network:2026-11-16:1', NULL, '{\"day\":\"2026-11-16\"}', ?, 0, 0, NULL, 'pending', NULL)",
                arrayOf<Any>(T0),
            )
        }

        val room = Room.databaseBuilder(context, BelayDatabase::class.java, name).build()
        try {
            val store = AgentStore(room, dir)
            // Version 7's rows: the policy reads as it was, with Phase 13's defaults, and the queued day still waits.
            assertEquals(policy.version, store.policy()?.version)
            assertEquals(WireMobileData(), store.policy()?.mobileData)
            assertEquals(1, store.pendingNetworkCount())
            assertEquals(listOf(OutboxRow.TYPE_NETWORK), store.queue().map { it.type })
            assertNull(store.mobileDataState())
            assertEquals(0, store.pendingMobileDataCount())

            // Version 8's table: mobile data's row and its days in the outbox.
            val state = MobileDataState(
                wifiOnly = WifiOnly.Applied(asked = listOf("com.example.video"), uids = mapOf("com.example.video" to 10123)),
                report = WireMobileDataStatus(listOf("com.example.video")),
                uploads = DataUseUploads.State(since = T0, lastAt = T0 + HOUR),
            )
            val day = WireMobileDataDay(
                day = "2026-11-16", zone = "America/New_York", from = T0, asOf = T0 + HOUR, complete = false,
                mobileBytes = 1_000, wifiBytes = 5_000, apps = listOf(WireMobileDataApp("com.example.video", 900)), androidBytes = 100,
            )
            store.commitEnforcement(null, emptyList(), T0 + HOUR, mobileData = AgentStore.MobileDataWrite(state, listOf(day)))
            assertEquals(state, store.mobileDataState())
            assertEquals(1, store.pendingMobileDataCount())
            val queued = store.queue().last { it.type == OutboxRow.TYPE_MOBILE_DATA }
            assertEquals(day, Wire.json.decodeFromString(WireMobileDataDay.serializer(), store.mobileDataPayloads(listOf(queued.id)).single()))
            // The same day again replaces the unsent one; measuring off drops it; no state, no row.
            store.commitEnforcement(null, emptyList(), T0 + 2 * HOUR, mobileData = AgentStore.MobileDataWrite(state, listOf(day.copy(asOf = T0 + 2 * HOUR))))
            assertEquals(1, store.pendingMobileDataCount())
            store.commitEnforcement(null, emptyList(), T0 + 3 * HOUR, mobileData = AgentStore.MobileDataWrite(null, dropUnsent = true))
            assertNull(store.mobileDataState())
            assertEquals(0, store.pendingMobileDataCount())
            assertEquals("version 7's network day is untouched", 1, store.pendingNetworkCount())
        } finally {
            room.close()
        }
    }

    private companion object {
        const val T0 = 1_794_808_800_000L
        const val HOUR = 3_600_000L
    }
}
