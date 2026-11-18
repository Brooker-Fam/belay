package family.brooker.belay.sync

import family.brooker.belay.BuildConfig
import family.brooker.belay.DebugTools
import family.brooker.belay.core.CheckinRequest
import family.brooker.belay.core.CheckinResponse
import family.brooker.belay.core.EnrollRequest
import family.brooker.belay.core.EnrollResponse
import family.brooker.belay.core.EventsResponse
import family.brooker.belay.core.InventoryResponse
import family.brooker.belay.core.PolicyResponse
import family.brooker.belay.core.PolicyRules
import family.brooker.belay.core.PolicyTooLarge
import family.brooker.belay.core.RequestsResponse
import family.brooker.belay.core.Wire
import family.brooker.belay.core.WireError
import family.brooker.belay.core.calls.CallsResponse
import family.brooker.belay.core.location.LocationsResponse
import family.brooker.belay.core.mobiledata.MobileDataResponse
import family.brooker.belay.core.network.NetworkResponse
import family.brooker.belay.core.screentime.UsageResponse
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import okhttp3.Call
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import java.io.IOException
import java.net.Proxy
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
         * answered that isn't the device API (a captive portal, the wrong site). With
         * [tooLarge], the server did answer 2xx, so it handled the request, but the answer is
         * larger than Belay reads (a policy over 1 MiB: core's PolicyTooLarge).
         */
        data class Failed(val reason: String, val answered: Boolean = false, val tooLarge: TooLarge? = null) : Answer<Nothing>
    }

    /** [bytes]: the answer's Content-Length, when the server sent one. */
    data class TooLarge(val bytes: Long?)

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

    /** Phase 2. [requests] are WireRequests as queued, oldest first. */
    fun requests(token: String, requests: List<String>): Answer<RequestsResponse> =
        post("requests", token, requests.joinToString(",", prefix = "{\"requests\":[", postfix = "]}"), RequestsResponse.serializer())

    /** Phase 3. [days] are WireUsageDays as queued, oldest first. */
    fun usage(token: String, days: List<String>): Answer<UsageResponse> =
        post("usage", token, days.joinToString(",", prefix = "{\"days\":[", postfix = "]}"), UsageResponse.serializer())

    /** Phase 4. [fixes] are WireFixes and [placeEvents] WirePlaceEvents as queued, oldest first. */
    fun locations(token: String, fixes: List<String>, placeEvents: List<String>): Answer<LocationsResponse> =
        post(
            "locations",
            token,
            fixes.joinToString(",", prefix = "{\"fixes\":[", postfix = "],") + placeEvents.joinToString(",", prefix = "\"place_events\":[", postfix = "]}"),
            LocationsResponse.serializer(),
        )

    /** Phase 5. [calls] are WireCallRecords as queued, oldest first. */
    fun calls(token: String, calls: List<String>): Answer<CallsResponse> =
        post("calls", token, calls.joinToString(",", prefix = "{\"calls\":[", postfix = "]}"), CallsResponse.serializer())

    /** Phase 3, network logging. [days] are WireNetworkDays as queued, oldest first. */
    fun network(token: String, days: List<String>): Answer<NetworkResponse> =
        post("network", token, days.joinToString(",", prefix = "{\"days\":[", postfix = "]}"), NetworkResponse.serializer())

    /** Phase 13. [days] are WireMobileDataDays as queued, oldest first. */
    fun mobileData(token: String, days: List<String>): Answer<MobileDataResponse> =
        post("mobile-data", token, days.joinToString(",", prefix = "{\"days\":[", postfix = "]}"), MobileDataResponse.serializer())

    /**
     * Phase 2, the long-poll: `GET /api/v1/policy?have=&wait=`. The server answers at once
     * when its version differs from [have], or holds the request up to [waitSeconds] for a
     * change. Ok with a null body is its 204: no change. [started] gets the call, so the
     * service can cancel it when it stops.
     */
    fun policy(token: String, have: Int, waitSeconds: Int, started: (Call) -> Unit = {}): Answer<PolicyResponse?> {
        val url = "$origin/api/v1/policy".toHttpUrl().newBuilder()
            .addQueryParameter("have", have.toString())
            .addQueryParameter("wait", waitSeconds.toString())
            .build()
        val request = Request.Builder().url(url).get().header("Authorization", "Bearer $token").build()
        val call = Http.longPoll.newCall(request)
        call.timeout().timeout(waitSeconds + LONG_POLL_SLACK_S, TimeUnit.SECONDS)
        started(call)
        return execute(call, PolicyResponse.serializer(), noContent = true)
    }

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
        val call = client.newCall(request)
        call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
        // A check-in's answer carries the whole policy (Phase 2).
        val maxBytes = if (endpoint == "checkin") MAX_POLICY_BYTES else MAX_ANSWER_BYTES
        @Suppress("UNCHECKED_CAST")
        return execute(call, serializer, noContent = false, maxBytes = maxBytes) as Answer<T>
    }

    /** [noContent]: a 204 is an answer (Ok with a null body), not an unexpected one. */
    private fun <T> execute(call: Call, serializer: KSerializer<T>, noContent: Boolean, maxBytes: Long = MAX_POLICY_BYTES): Answer<T?> {
        val sentAt = System.currentTimeMillis()
        return try {
            call.execute().use { response ->
                val receivedAt = System.currentTimeMillis()
                if (noContent && response.code == 204) return Answer.Ok(null, sentAt, receivedAt)
                // Too large by its Content-Length: not even read, so trying again costs little.
                val declared = response.body.contentLength()
                fun tooLarge(bytes: Long?) = Answer.Failed(
                    "answer too large (HTTP ${response.code})",
                    answered = true,
                    tooLarge = TooLarge(bytes).takeIf { response.isSuccessful },
                )
                if (declared > maxBytes) return tooLarge(declared)
                val text = response.body.readCapped(maxBytes) ?: return tooLarge(null)
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

    /** The body as text, or null when it is larger than [maxBytes] (no answer of the API is). */
    private fun ResponseBody.readCapped(maxBytes: Long): String? {
        val source = source()
        if (source.request(maxBytes + 1)) return null
        return source.buffer.readUtf8()
    }

    private companion object {
        val JSON = "application/json".toMediaType()

        /** The API's answers are small. */
        const val MAX_ANSWER_BYTES = 64L * 1024

        /** A policy holds every decision and 30 days of answered requests with the parent's notes. */
        const val MAX_POLICY_BYTES = PolicyTooLarge.MAX_BYTES
        const val CALL_TIMEOUT_S = 120L

        /** Shorter: provision.sh's broadcast has to finish within Android's 60 s. */
        const val ENROLL_TIMEOUT_S = 40L

        /** The long-poll's whole call may take this much longer than the server's wait. */
        const val LONG_POLL_SLACK_S = 40L
    }
}

object Http {
    /**
     * For the long-poll: the same client (connections, pool and dispatcher shared) with a
     * read timeout longer than the server holds a request (PolicyRules.POLL_WAIT_S).
     */
    val longPoll: OkHttpClient by lazy {
        client.newBuilder().readTimeout(PolicyRules.POLL_WAIT_S + 25L, TimeUnit.SECONDS).build()
    }

    /**
     * One client for the whole process, so connections are reused. It connects directly, never
     * through a proxy set on the phone's network (platform notes H2): one the kid set could
     * otherwise hold back Belay's reports, the report of that proxy included. On a network that
     * only works through a proxy, Belay can't reach the server there, and the phone shows as silent.
     */
    val client: OkHttpClient by lazy {
        val specs = if (DebugTools.CLEARTEXT_HOSTS.isEmpty()) {
            listOf(ConnectionSpec.MODERN_TLS)
        } else {
            listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)
        }
        OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
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
