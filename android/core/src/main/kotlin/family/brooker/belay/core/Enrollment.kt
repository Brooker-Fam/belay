package family.brooker.belay.core

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** The two things a phone needs to enroll: the server and a one-time code. */
data class EnrollTarget(val server: String, val code: String)

/**
 * Why an enrollment didn't work, so the screen can say it plainly and provision.sh can
 * print it. [code] is what `provision.sh` shows.
 */
enum class EnrollProblem(val code: String) {
    /** Not an https address (or, in debug builds, the emulator's host over http). */
    BAD_SERVER("bad_server"),

    /** Not 8 characters of Crockford base32. */
    BAD_CODE("bad_code"),

    /** The server's `invalid_code`: mistyped, already used, or expired. */
    CODE_REFUSED("invalid_code"),
    RATE_LIMITED("rate_limited"),

    /** No connection: the address is wrong, the server is down, or the phone is offline. */
    UNREACHABLE("unreachable"),

    /** Something answered, but not like a Belay server. */
    NOT_BELAY("not_belay"),

    /** A Belay server refused the request itself (a bug on one side). */
    REFUSED("refused"),
    SERVER_ERROR("server_error"),

    /** Connected to a server already: only the parent (adb) can move the phone. */
    ALREADY_CONNECTED("already_connected"),
}

object Enrollment {
    const val CODE_LENGTH = 8

    /** Crockford base32, without I, L, O and U. */
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /**
     * The code as typed ("7kq2-m9xa", "7KQ2 M9XA") in canonical form, or null when it
     * can't be one: wrong length, or a character outside Crockford base32. I and L read
     * as 1, O as 0, as Crockford says.
     */
    fun normalizeCode(typed: String): String? {
        val code = typed.uppercase()
            .filterNot { it == '-' || it.isWhitespace() }
            .map { c -> when (c) { 'I', 'L' -> '1'; 'O' -> '0'; else -> c } }
            .joinToString("")
        return code.takeIf { it.length == CODE_LENGTH && it.all { c -> c in ALPHABET } }
    }

    /**
     * The server's origin as typed, normalized ("Belay.Example.org/" → "https://belay.example.org"),
     * or null when it isn't a usable URL. Only https, except plain http for [cleartextHosts]
     * (debug builds use 10.0.2.2, the emulator's host).
     */
    fun normalizeServer(typed: String, cleartextHosts: Set<String> = emptySet()): String? {
        val trimmed = typed.trim().trimEnd('/')
        if (trimmed.isEmpty()) return null
        val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
        val uri = try {
            URI(withScheme)
        } catch (e: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        if ((uri.rawPath ?: "").isNotEmpty() && uri.rawPath != "/") return null
        when (scheme) {
            "https" -> {}
            "http" -> if (host !in cleartextHosts) return null
            else -> return null
        }
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    /** What an error answer from `POST /api/v1/enroll` means (docs/protocol.md, "Errors"). */
    fun problemFor(status: Int, error: String?): EnrollProblem = when {
        status == 400 && error == "invalid_code" -> EnrollProblem.CODE_REFUSED
        status == 429 -> EnrollProblem.RATE_LIMITED
        status >= 500 -> EnrollProblem.SERVER_ERROR
        // A wrong address answers with a page that isn't the device API.
        status == 404 || status == 405 || error == null -> EnrollProblem.NOT_BELAY
        else -> EnrollProblem.REFUSED
    }

    /** Parses `belay://enroll?server=…&code=…` (docs/protocol.md, "Enrollment link"). */
    fun parseLink(link: String, cleartextHosts: Set<String> = emptySet()): EnrollTarget? {
        val uri = try {
            URI(link.trim())
        } catch (e: Exception) {
            return null
        }
        if (uri.scheme?.lowercase() != "belay" || uri.host?.lowercase() != "enroll") return null
        val params = uri.rawQuery.orEmpty().split('&').mapNotNull { part ->
            val key = part.substringBefore('=', "")
            if (key.isEmpty()) return@mapNotNull null
            key to URLDecoder.decode(part.substringAfter('=', ""), StandardCharsets.UTF_8)
        }.toMap()
        val server = params["server"]?.let { normalizeServer(it, cleartextHosts) } ?: return null
        val code = params["code"]?.let { normalizeCode(it) } ?: return null
        return EnrollTarget(server, code)
    }
}
