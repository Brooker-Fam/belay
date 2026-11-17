package family.brooker.belay.sync

import family.brooker.belay.BuildConfig
import family.brooker.belay.DebugTools
import family.brooker.belay.core.CheckinRequest
import family.brooker.belay.core.CheckinResponse
import family.brooker.belay.core.EnrollRequest
import family.brooker.belay.core.EnrollResponse
import family.brooker.belay.core.EventsResponse
import family.brooker.belay.core.InventoryResponse
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireError
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The device API (docs/protocol.md) over OkHttp. HTTPS with the system's CAs only: no
 * custom TrustManager, no pinning, and the network security config decides the rest
 * (res/xml/network_security_config.xml; debug builds also allow plain http to the
 * emulator's host). No cookies, no cache, no redirects. The token goes only in the
 * Authorization header and is never logged.
 */
class DeviceApi(private val origin: String, private val client: OkHttpClient = Http.client) {
    sealed interface Answer<out T> {
        /** [sentAt] and [receivedAt] bracket the request, for the clock skew. */
        data class Ok<T>(val body: T, val sentAt: Long, val receivedAt: Long) : Answer<T>

        /** An HTTP error. [retryAfter] is the raw header. */
        data class Refused(val status: Int, val error: WireError?, val retryAfter: String?) : Answer<Nothing>

        /**
         * No usable answer: no connection or a timeout, or, when [answered], something
         * answered that isn't the device API (a captive portal, the wrong site).
         */
        data class Failed(val reason: String, val answered: Boolean = false) : Answer<Nothing>
    }

    fun enroll(request: EnrollRequest): Answer<EnrollResponse> =
        post("enroll", null, Wire.json.encodeToString(EnrollRequest.serializer(), request), EnrollResponse.serializer(), ENROLL_TIMEOUT_S)

    fun checkin(token: String, request: CheckinRequest): Answer<CheckinResponse> =
        post("checkin", token, Wire.json.encodeToString(CheckinRequest.serializer(), request), CheckinResponse.serializer())

    /** [json] is an InventoryRequest, as queued. */
    fun inventory(token: String, json: String): Answer<InventoryResponse> =
        post("inventory", token, json, InventoryResponse.serializer())

    /** [events] are WireEvents as queued, oldest first. */
    fun events(token: String, events: List<String>): Answer<EventsResponse> =
        post("events", token, events.joinToString(",", prefix = "{\"events\":[", postfix = "]}"), EventsResponse.serializer())

    private fun <T> post(
        endpoint: String,
        token: String?,
        json: String,
        serializer: KSerializer<T>,
        timeoutSeconds: Long = CALL_TIMEOUT_S,
    ): Answer<T> {
        val request = Request.Builder()
            .url("$origin/api/v1/$endpoint")
            .post(json.toRequestBody(JSON))
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .build()
        val sentAt = System.currentTimeMillis()
        val call = client.newCall(request)
        call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
        return try {
            call.execute().use { response ->
                val receivedAt = System.currentTimeMillis()
                val text = response.body.readCapped()
                    ?: return Answer.Failed("answer too large (HTTP ${response.code})", answered = true)
                if (response.isSuccessful) {
                    try {
                        Answer.Ok(Wire.json.decodeFromString(serializer, text), sentAt, receivedAt)
                    } catch (e: SerializationException) {
                        // A captive portal or the wrong site can answer 200: that isn't "sent".
                        Answer.Failed("unexpected answer (HTTP ${response.code})", answered = true)
                    } catch (e: IllegalArgumentException) {
                        Answer.Failed("unexpected answer (HTTP ${response.code})", answered = true)
                    }
                } else {
                    val error = try {
                        Wire.json.decodeFromString(WireError.serializer(), text)
                    } catch (e: SerializationException) {
                        null
                    } catch (e: IllegalArgumentException) {
                        null
                    }
                    Answer.Refused(response.code, error, response.header("Retry-After"))
                }
            }
        } catch (e: IOException) {
            Answer.Failed("${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(200))
        }
    }

    /** The body as text, or null when it is larger than any answer of the API. */
    private fun ResponseBody.readCapped(): String? {
        val source = source()
        if (source.request(MAX_ANSWER_BYTES + 1)) return null
        return source.buffer.readUtf8()
    }

    private companion object {
        val JSON = "application/json".toMediaType()

        /** The API's answers are small. */
        const val MAX_ANSWER_BYTES = 64L * 1024
        const val CALL_TIMEOUT_S = 120L

        /** Shorter: provision.sh's broadcast has to finish within Android's 60 s. */
        const val ENROLL_TIMEOUT_S = 40L
    }
}

object Http {
    /** One client for the whole process, so connections are reused. */
    val client: OkHttpClient by lazy {
        val specs = if (DebugTools.CLEARTEXT_HOSTS.isEmpty()) {
            listOf(ConnectionSpec.MODERN_TLS)
        } else {
            listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)
        }
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .connectionSpecs(specs)
            .addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().header("User-Agent", "Belay/${BuildConfig.VERSION_NAME}").build())
            }
            .build()
    }
}
