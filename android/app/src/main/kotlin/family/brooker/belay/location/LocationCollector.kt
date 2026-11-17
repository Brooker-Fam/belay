package family.brooker.belay.location

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.location.LocationRequest
import android.os.CancellationSignal
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger
import family.brooker.belay.core.DataCategories
import family.brooker.belay.core.location.FixReading
import family.brooker.belay.core.location.LocationRules
import family.brooker.belay.core.location.LocationWork
import family.brooker.belay.core.location.WireLocationProvider
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil

/**
 * The location collector (data category [DataCategories.location], Phase 4): single fixes, never
 * a stream, with the platform's LocationManager (no Play services code; platform notes L3). One
 * attempt at a time, on its own thread so the agent thread never waits for a fix:
 * `getCurrentLocation` with the policy's provider, for up to 60 seconds. Android 17 caps one
 * `getCurrentLocation` at 30 seconds (`LocationProviderManager.MAX_GET_CURRENT_LOCATION_TIMEOUT_MS`;
 * platform notes L8), so the 60 seconds are two calls: GPS twice, or GPS and then Android's
 * combined provider ("fused") when the family allowed that fallback; "fused" twice if the family
 * chose it. A fix answers every want it was taken for ([start]'s keys); its result goes back to
 * the agent thread with a step ([Trigger.LOCATION_FIX]), which records it. A partial wake lock
 * keeps the phone awake for the attempt (at most 75 seconds).
 */
object LocationCollector {
    /** One attempt's end: the wants it answers (FixWant.key), and what it read or why not. */
    data class Result(val keys: List<String>, val reading: FixReading?, val problem: String?)

    private const val CALL_MS = 30_000L
    private const val WAKE_MS = 75_000L

    /** A null answer sooner than this means the provider isn't there or is off: no point waiting again. */
    private const val FAST_NULL_MS = 5_000L

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-location") }
    private val running = AtomicBoolean(false)
    private val results = ConcurrentLinkedQueue<Result>()

    /** A direct executor for the platform's callback: the attempt's thread waits on a latch. */
    private val direct = Executor { it.run() }

    /** An attempt is running in this process. */
    val busy: Boolean get() = running.get()

    /**
     * Starts one attempt for [keys] with [providers], unless one is running (then the caller's
     * wants wait for the next step). True when it started.
     */
    fun start(context: Context, keys: List<String>, providers: LocationRules.Providers): Boolean {
        if (keys.isEmpty() || !running.compareAndSet(false, true)) return false
        val app = context.applicationContext
        executor.execute {
            val wake = app.getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "belay:location")
            try {
                wake?.acquire(WAKE_MS)
                val (reading, problem) = take(app, providers)
                Log.i(Agent.TAG, "location: ${if (reading != null) "fix from ${reading.provider.name.lowercase()}, ${reading.accuracyM} m" else "no fix: $problem"}")
                results += Result(keys, reading, problem)
            } catch (e: RuntimeException) {
                Log.e(Agent.TAG, "location: the attempt failed", e)
                results += Result(keys, null, "Belay couldn't ask Android for a fix: ${e.javaClass.simpleName}.")
            } finally {
                runCatching { if (wake?.isHeld == true) wake.release() }
                running.set(false)
            }
            Agent.handle(app, Trigger.LOCATION_FIX)
        }
        return true
    }

    /** The results that came in since the last call, oldest first. */
    fun takeResults(): List<Result> = generateSequence { results.poll() }.toList()

    /** One fix within 60 seconds, or null with Belay's words for why. */
    private fun take(context: Context, providers: LocationRules.Providers): Pair<FixReading?, String?> {
        val lm = context.getSystemService(LocationManager::class.java) ?: return null to "This phone has no location service."
        if (!DeviceOwnerSetup.hasLocation(context)) return null to LocationWork.PROBLEM_NO_PERMISSION
        if (!lm.isLocationEnabled) return null to LocationWork.PROBLEM_LOCATION_OFF
        val tries = listOf(providers.first, providers.fallback ?: providers.first)
        for (provider in tries) {
            val name = providerName(provider)
            if (!lm.hasProvider(name)) continue
            val started = SystemClock.elapsedRealtime()
            val location = current(lm, name)
            if (location != null) return reading(location, provider) to null
            // Fast: the provider is off or missing. Waiting again wouldn't help.
            if (SystemClock.elapsedRealtime() - started < FAST_NULL_MS && provider == tries.last()) break
        }
        if (!lm.isLocationEnabled) return null to LocationWork.PROBLEM_LOCATION_OFF
        return null to when {
            providers.first == WireLocationProvider.FUSED -> LocationWork.PROBLEM_NO_FUSED_FIX
            providers.fallback != null -> LocationWork.PROBLEM_NO_FIX
            else -> LocationWork.PROBLEM_NO_GPS_FIX
        }
    }

    // Belay holds location by policy whenever it gets here (DeviceOwnerSetup.hasLocation above).
    @SuppressLint("MissingPermission")
    private fun current(lm: LocationManager, provider: String): Location? {
        val latch = CountDownLatch(1)
        var got: Location? = null
        val cancel = CancellationSignal()
        val request = LocationRequest.Builder(0L)
            .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
            .setDurationMillis(CALL_MS)
            .build()
        lm.getCurrentLocation(provider, request, cancel, direct) { location ->
            got = location
            latch.countDown()
        }
        if (!latch.await(CALL_MS + 5_000, TimeUnit.MILLISECONDS)) cancel.cancel()
        return got
    }

    private fun providerName(provider: WireLocationProvider): String = when (provider) {
        WireLocationProvider.GPS -> LocationManager.GPS_PROVIDER
        WireLocationProvider.FUSED -> LocationManager.FUSED_PROVIDER
    }

    private fun reading(location: Location, provider: WireLocationProvider) = FixReading(
        at = location.time.takeIf { it > 0 } ?: System.currentTimeMillis(),
        lat = location.latitude,
        lng = location.longitude,
        accuracyM = if (location.hasAccuracy()) ceil(location.accuracy.toDouble()).toInt() else 0,
        provider = provider,
        mock = location.isMock,
    )
}
