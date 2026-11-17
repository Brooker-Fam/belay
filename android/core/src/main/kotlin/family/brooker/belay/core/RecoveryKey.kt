package family.brooker.belay.core

import java.security.MessageDigest

/**
 * Phase 6: the recovery key (docs/protocol.md, "The recovery key"). The server makes 26 random
 * Crockford base32 characters (130 bits), shows them once, and sends only [WireRecovery]: a
 * salt and a hash. Typing it on the phone opens repair access for 24 hours with no server.
 *
 * Typing is forgiving: case, spaces and dashes don't matter, and O, I and L read as 0, 1 and
 * 1. The server's `recovery.ts` normalizes and hashes exactly the same way; the test vector
 * in RecoveryKeyTest is shared with the server's tests.
 */
object RecoveryKey {
    const val LENGTH = 26
    const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** The key as compared, or null when what was typed can't be a key. */
    fun normalize(typed: String): String? {
        val out = StringBuilder(LENGTH)
        for (c in typed) {
            if (c == '-' || c.isWhitespace()) continue
            val mapped = when (val u = c.uppercaseChar()) {
                'O' -> '0'
                'I', 'L' -> '1'
                else -> u
            }
            if (mapped !in ALPHABET) return null
            out.append(mapped)
        }
        return out.toString().takeIf { it.length == LENGTH }
    }

    /** SHA-256 of the salt's bytes followed by the normalized key's UTF-8, lowercase hex. */
    fun hash(saltHex: String, normalized: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(hexToBytes(saltHex))
        digest.update(normalized.encodeToByteArray())
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Whether [typed] is the key [check] was made from. Compares in constant time. */
    fun matches(check: WireRecovery, typed: String): Boolean {
        val normalized = normalize(typed) ?: return false
        val salt = check.salt.lowercase()
        if (salt.length != 32 || !salt.all { it in HEX }) return false
        return MessageDigest.isEqual(hash(salt, normalized).encodeToByteArray(), check.hash.lowercase().encodeToByteArray())
    }

    /** For showing a key: four groups of five and one of six, like the server prints it. */
    fun grouped(normalized: String): String = normalized.chunked(5).let { chunks ->
        if (chunks.size > 1 && chunks.last().length == 1) chunks.dropLast(2) + (chunks[chunks.size - 2] + chunks.last()) else chunks
    }.joinToString("-")

    private const val HEX = "0123456789abcdef"

    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0 && hex.all { it in HEX }) { "not lowercase hex" }
        return ByteArray(hex.length / 2) { i -> hex.substring(2 * i, 2 * i + 2).toInt(16).toByte() }
    }
}
