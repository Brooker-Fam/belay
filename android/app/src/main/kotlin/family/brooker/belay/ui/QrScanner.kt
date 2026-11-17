package family.brooker.belay.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import family.brooker.belay.Agent
import java.util.concurrent.Executors

/**
 * The camera preview, and a QR reader on its frames. Frames are read in memory and
 * dropped: nothing from the camera is stored or sent. [onText] gets each QR code's text
 * (on the main thread, possibly many times); [onUnavailable] is called if there's no
 * camera to use. Leaving the composition unbinds the camera.
 */
@Composable
fun QrScanner(onText: (String) -> Unit, onUnavailable: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val preview = remember { PreviewView(context) }
    val latestOnText = rememberUpdatedState(onText)
    val latestOnUnavailable = rememberUpdatedState(onUnavailable)
    DisposableEffect(lifecycleOwner) {
        val analysisThread = Executors.newSingleThreadExecutor { r -> Thread(r, "belay-qr") }
        val main = ContextCompat.getMainExecutor(context)
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var disposed = false
        future.addListener({
            if (disposed) return@addListener
            try {
                val cameras = future.get()
                provider = cameras
                val selector = listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA)
                    .firstOrNull { hasCamera(cameras, it) }
                if (selector == null) {
                    latestOnUnavailable.value()
                    return@addListener
                }
                val previewCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analysisThread, QrAnalyzer { text -> main.execute { if (!disposed) latestOnText.value(text) } })
                cameras.unbindAll()
                cameras.bindToLifecycle(lifecycleOwner, selector, previewCase, analysis)
            } catch (e: Exception) {
                // No camera, or it's in use or disabled: typing the code still works.
                Log.w(Agent.TAG, "camera unavailable", e)
                latestOnUnavailable.value()
            }
        }, main)
        onDispose {
            disposed = true
            provider?.unbindAll()
            analysisThread.shutdown()
        }
    }
    AndroidView(factory = { preview }, modifier = modifier)
}

private fun hasCamera(cameras: ProcessCameraProvider, selector: CameraSelector): Boolean = try {
    cameras.hasCamera(selector)
} catch (e: Exception) {
    false
}

/** Reads QR codes from the luminance (Y) plane of each YUV_420_888 frame. */
private class QrAnalyzer(private val onText: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = QRCodeReader()
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true)
    private var bytes = ByteArray(0)

    override fun analyze(image: ImageProxy) {
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            buffer.rewind()
            val size = buffer.remaining()
            if (bytes.size < size) bytes = ByteArray(size)
            buffer.get(bytes, 0, size)
            // The Y plane's pixel stride is 1; rows can be padded to rowStride.
            val source = PlanarYUVLuminanceSource(
                bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false,
            )
            onText(reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text)
        } catch (e: ReaderException) {
            // No QR code in this frame.
        } catch (e: IllegalArgumentException) {
            // A frame of an unexpected shape; the next one may do.
        } finally {
            reader.reset()
            image.close()
        }
    }
}

/** The camera permission, for the enrollment screen. */
fun hasCameraPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
