package family.brooker.belay.update

import android.content.Context
import android.os.storage.StorageManager
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.DownloadFacts
import family.brooker.belay.core.DownloadRules
import family.brooker.belay.core.OutboxPolicy
import family.brooker.belay.core.Verdict
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireAgentUpdate
import family.brooker.belay.core.WireError
import family.brooker.belay.sync.Http
import kotlinx.serialization.SerializationException
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * `GET /api/v1/agent/<sha256>.apk` with the device token (docs/protocol.md), on the update
 * thread, into no-backup storage (excluded from backups and device transfers, like the
 * database). After a failure the next try asks for the rest with `Range: bytes=<have>-`, so a
 * download over cellular resumes. The file is hashed while it's written (the bytes already on
 * disk first), and never grows past the offered size, itself at most
 * WireLimits.MAX_AGENT_BYTES. No compression (`Accept-Encoding: identity`), so byte offsets
 * are the file's. The same HTTPS client and rules as every other call (sync/DeviceApi.kt).
 */
class UpdateDownload(private val app: Context, private val client: OkHttpClient = Http.client) {
    sealed interface Result {
        /** [file] holds exactly the bytes [facts] describes; core's AgentUpdates.check decides the rest. */
        data class Done(val file: File, val facts: DownloadFacts) : Result

        /** [retryAfterMs]: the server's Retry-After; [disconnect]: the server refused the device token. */
        data class Failed(val problem: String, val retryAfterMs: Long? = null, val disconnect: Boolean = false) : Result
    }

    fun fetch(origin: String, token: String, offer: WireAgentUpdate): Result {
        val dir = dir(app)
        keepOnly(app, offer.sha256)
        val apk = File(dir, "${offer.sha256}.apk")
        if (apk.isFile) {
            // Downloaded and verified before (Android refused it, say): hashed again, it's cheap.
            val facts = DownloadFacts(sha256(apk), apk.length())
            if (facts.sha256 == offer.sha256 && facts.size == offer.size) return Result.Done(apk, facts)
            apk.delete()
        }
        val part = File(dir, "${offer.sha256}.part")
        var have = if (part.isFile) part.length() else 0L
        if (have > offer.size) {
            part.delete()
            have = 0
        }
        // The rest of the file, and the installer's own copy of all of it.
        if (allocatable(dir) < (offer.size - have) + offer.size + SPARE_BYTES) {
            return Result.Failed("There isn't enough free storage on this phone for the update (about ${(2 * offer.size + SPARE_BYTES) shr 20} MB).")
        }
        val request = Request.Builder()
            .url("$origin/api/v1/agent/${offer.sha256}.apk")
            .get()
            .header("Authorization", "Bearer $token")
            .header("Accept-Encoding", "identity")
            .apply { if (have > 0) header("Range", "bytes=$have-") }
            .build()
        val call = client.newCall(request)
        call.timeout().timeout(CALL_TIMEOUT_MIN, TimeUnit.MINUTES)
        return try {
            call.execute().use { response ->
                if (!response.isSuccessful && response.code != 416) {
                    val retryAfter = OutboxPolicy.retryAfterMs(response.header("Retry-After"), System.currentTimeMillis())
                    val error = if (response.code == 401) errorCode(response.peekBody(MAX_ERROR_BYTES).string()) else null
                    val verdict = OutboxPolicy.verdict(response.code, error, items = 1, retryAfterMs = retryAfter)
                    return Result.Failed("The server answered HTTP ${response.code} for the update.", retryAfter, disconnect = verdict is Verdict.Disconnect)
                }
                val plan = DownloadRules.plan(have, response.code, response.header("Content-Range"), offer.size)
                when (plan) {
                    DownloadRules.Plan.Append, DownloadRules.Plan.Complete -> {}
                    DownloadRules.Plan.FromStart -> {
                        part.delete()
                        have = 0
                    }
                    is DownloadRules.Plan.Discard -> {
                        part.delete()
                        return Result.Failed(plan.problem)
                    }
                    is DownloadRules.Plan.Fail -> return Result.Failed(plan.problem)
                }
                val digest = MessageDigest.getInstance("SHA-256")
                if (have > 0) hashInto(part, have, digest)
                if (plan != DownloadRules.Plan.Complete) {
                    FileOutputStream(part, have > 0).use { out ->
                        val source = response.body.byteStream()
                        val buffer = ByteArray(BUFFER)
                        while (true) {
                            val n = source.read(buffer)
                            if (n < 0) break
                            if (have + n > offer.size) {
                                out.close()
                                part.delete()
                                return Result.Failed("The server sent more than the ${offer.size} bytes it offered.")
                            }
                            out.write(buffer, 0, n)
                            digest.update(buffer, 0, n)
                            have += n
                        }
                        out.fd.sync()
                    }
                }
                if (have != offer.size) return Result.Failed("The download stopped after $have of ${offer.size} bytes. Belay goes on from there next time.")
                val facts = DownloadFacts(Apks.hex(digest.digest()), have)
                // Only a file with the offered hash takes the offered name.
                val file = if (facts.sha256 == offer.sha256 && part.renameTo(apk)) apk else part
                Log.i(Agent.TAG, "update: downloaded ${facts.size} bytes")
                Result.Done(file, facts)
            }
        } catch (e: IOException) {
            Result.Failed("The download stopped (${e.javaClass.simpleName}). Belay goes on from there next time.")
        }
    }

    /** The bytes Android could make free for [dir] (clearable caches count); if it can't say, no limit. */
    private fun allocatable(dir: File): Long = try {
        val storage = app.getSystemService(StorageManager::class.java)
        storage.getAllocatableBytes(storage.getUuidForPath(dir))
    } catch (e: IOException) {
        Long.MAX_VALUE
    } catch (e: RuntimeException) {
        Long.MAX_VALUE
    }

    private fun hashInto(file: File, length: Long, digest: MessageDigest) {
        file.inputStream().use { input ->
            val buffer = ByteArray(BUFFER)
            var left = length
            while (left > 0) {
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                if (n < 0) throw IOException("the file on disk is shorter than it was")
                digest.update(buffer, 0, n)
                left -= n
            }
        }
    }

    /** The device API's error code ({"error": "invalid_token", …}), or null. */
    private fun errorCode(body: String): String? = try {
        Wire.json.decodeFromString(WireError.serializer(), body).error
    } catch (e: SerializationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    companion object {
        /** A large APK over a slow network: the whole call may take this long. */
        private const val CALL_TIMEOUT_MIN = 30L
        private const val BUFFER = 64 * 1024
        private const val MAX_ERROR_BYTES = 4096L

        /** Room to spare beyond the file and the installer's copy of it. */
        private const val SPARE_BYTES = 50L shl 20

        fun dir(context: Context): File = File(context.noBackupFilesDir, DIR).apply { mkdirs() }

        /** Deletes every downloaded file but the ones for [sha256] (null: all of them). */
        fun keepOnly(context: Context, sha256: String?) {
            File(context.noBackupFilesDir, DIR).listFiles()?.forEach { file ->
                if (sha256 == null || !file.name.startsWith(sha256)) file.delete()
            }
        }

        private const val DIR = "update"

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(BUFFER)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    digest.update(buffer, 0, n)
                }
            }
            return Apks.hex(digest.digest())
        }
    }
}
