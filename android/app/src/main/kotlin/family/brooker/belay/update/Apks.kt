package family.brooker.belay.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.SigningInfo
import android.os.Build
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.ApkFacts
import family.brooker.belay.inventory.packageInfoCompat
import java.io.File
import java.security.MessageDigest

/**
 * What PackageManager says about an APK, for core's AgentUpdates.check (AOSP 17,
 * docs/platform-notes.md I2):
 * - getPackageArchiveInfo with GET_SIGNING_CERTIFICATES parses the file and collects (and so
 *   verifies) its signatures; it returns null when the file can't be parsed.
 * - SigningInfo.getApkContentsSigners is the certificate set that signs the APK now, without
 *   the past certificates of a rotated key: Belay pins exactly that set. A rotated key is
 *   refused, and its update goes over adb in maintenance mode.
 */
object Apks {
    /** Belay itself, as installed: the version code this process runs and its signers. */
    fun self(context: Context): ApkFacts = installed(context, context.packageName)

    /** [packageName] as installed; throws NameNotFoundException if it isn't. */
    fun installed(context: Context, packageName: String): ApkFacts {
        val info = context.packageManager.packageInfoCompat(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        return ApkFacts(info.packageName, info.longVersionCode, signers(info.signingInfo))
    }

    /** What the APK at [file] says about itself; null when Android can't read it as an app. */
    fun archive(context: Context, file: File): ApkFacts? {
        val pm = context.packageManager
        val info: PackageInfo? = try {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "update: the APK couldn't be read", e)
            null
        }
        return info?.let { ApkFacts(it.packageName, it.longVersionCode, signers(it.signingInfo)) }
    }

    /**
     * SHA-256 of the certificate Belay is signed with, lowercase hex, for the device facts'
     * agent_signing_sha256 (the server pins the first it sees). The same digest apksigner
     * prints as "certificate SHA-256 digest". Null if Belay had more than one signer.
     */
    fun signingSha256(context: Context): String? = signing ?: try {
        self(context).signers.singleOrNull().also { signing = it }
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "couldn't read Belay's signing certificate", e)
        null
    }

    @Volatile
    private var signing: String? = null

    private fun signers(info: SigningInfo?): Set<String> =
        info?.apkContentsSigners.orEmpty().mapTo(HashSet()) { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
