package family.brooker.belay.settings

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import family.brooker.belay.Agent
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The device token, encrypted with an AES-256-GCM key that lives in Android Keystore and
 * never leaves it. What is stored (in DataStore) is only the IV and the ciphertext. The key
 * needs no lock screen or user authentication: the agent syncs while the phone is locked.
 * Never log the token.
 */
object TokenVault {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "belay-device-token"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
    private const val VERSION = "v1"

    /** Ties a ciphertext to its use: it can't be passed off as anything else this key encrypts. */
    private val aad = "belay device token $VERSION".encodeToByteArray()

    /** "v1:<iv>:<ciphertext>", base64. */
    fun encrypt(token: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(aad)
        val sealed = cipher.doFinal(token.encodeToByteArray())
        return listOf(VERSION, b64(cipher.iv), b64(sealed)).joinToString(":")
    }

    /** Null when it can't be read: the key is gone (Keystore reset) or the data is damaged. */
    fun decrypt(stored: String): String? {
        val parts = stored.split(':')
        if (parts.size != 3 || parts[0] != VERSION) return null
        return try {
            val key = existingKey() ?: return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, unb64(parts[1])))
            cipher.updateAAD(aad)
            cipher.doFinal(unb64(parts[2])).decodeToString()
        } catch (e: GeneralSecurityException) {
            Log.e(Agent.TAG, "device token unreadable: ${e.javaClass.simpleName}")
            null
        } catch (e: IllegalArgumentException) {
            Log.e(Agent.TAG, "device token unreadable: bad encoding")
            null
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

    @Synchronized
    private fun key(): SecretKey = existingKey() ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
        init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        generateKey()
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun unb64(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)
}
