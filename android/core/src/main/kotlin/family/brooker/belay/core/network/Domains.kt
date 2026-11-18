package family.brooker.belay.core.network

import java.net.IDN
import java.util.Locale

/**
 * What a DNS lookup's hostname becomes in network logging (Phase 3): the registrable part of it,
 * lowercase, in Punycode ("Chat-7.CDN.Example.com." → "example.com"), or null for a name Belay
 * never keeps: an IP address, a reverse lookup (Android logs one with the name it found, or
 * "null"), a name that never leaves the phone or the home network, or anything that isn't a
 * hostname. Lookups of 988's websites, and of the family's private websites, are never kept
 * either ([neverKept]).
 *
 * Decision (the design's open question): no Public Suffix List. Belay keeps a name's last two
 * labels, or three when the last is a country code and the one before is a second level many
 * countries register under ("bbc.co.uk", "abc.net.au", "google.com.br"). A name under a shared
 * suffix keeps less than the list would ("someone.github.io" is noted as "github.io"), which only
 * says less about the kid.
 */
object Domains {
    /** One label of a hostname, as the server checks it too (RFC 1123: letters, digits and hyphens). */
    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

    /**
     * Special-use top levels: reverse lookups and other infrastructure (`arpa`), the home
     * network's own names (`local`, mDNS; `internal`), and names that never resolve (RFC 6761).
     */
    private val LOCAL_TLDS: Set<String> = setOf("arpa", "local", "localhost", "invalid", "internal")

    /** Second levels under country codes: co.uk, org.uk, com.au, ne.jp, go.kr, gob.mx, gv.at… */
    private val SECOND_LEVEL: Set<String> = setOf(
        "ac", "co", "com", "edu", "go", "gob", "gov", "govt", "gv", "id", "ltd",
        "me", "mil", "ne", "net", "nhs", "or", "org", "plc", "sch",
    )

    /**
     * 988's websites, never kept, like a call to 988 (checked 2026-11-17): the 988 Suicide and
     * Crisis Lifeline (988lifeline.org, its chat included), its Spanish site and its earlier site,
     * which both lead there now; Canada's 9-8-8 Suicide Crisis Helpline; and the Veterans Crisis
     * Line, reached by dialing 988 then 1. The server keeps the same list
     * (server/src/family/network/store.ts).
     */
    val CRISIS_988: Set<String> = setOf(
        "988lifeline.org",
        "988lineadevida.org",
        "suicidepreventionlifeline.org",
        "988.ca",
        "veteranscrisisline.net",
    )

    /** The hostname, lowercase and in Punycode, without a trailing dot; null when it isn't one Belay keeps. */
    fun hostname(raw: String?): String? {
        var name = raw?.trim() ?: return null
        if (name.endsWith('.')) name = name.dropLast(1)
        if (name.isEmpty() || name.length > MAX_RAW) return null
        // An IPv6 address ("::1", "[fe80::1]", "fe80::1%wlan0") is an address, not a name.
        if (name.any { it == ':' || it == '%' || it == '[' || it == ']' }) return null
        val ascii = if (name.all { it.code < 0x80 }) {
            name
        } else {
            try {
                IDN.toASCII(name)
            } catch (e: IllegalArgumentException) {
                return null
            }
        }
        val host = ascii.lowercase(Locale.ROOT)
        if (host.length > NetworkWireLimits.MAX_DOMAIN) return null
        val labels = host.split('.')
        if (labels.size < 2 || !labels.all { LABEL.matches(it) }) return null
        // An IPv4 address, or anything else whose last label has no letter, isn't a name.
        if (labels.last().none { it in 'a'..'z' }) return null
        if (labels.last() in LOCAL_TLDS) return null
        return host
    }

    /** The registrable part of a [hostname]: its last two labels, or three under a country's second level. */
    fun registrable(host: String): String {
        val labels = host.split('.')
        val keep = if (labels.size >= 3 && labels.last().length == 2 && labels[labels.size - 2] in SECOND_LEVEL) 3 else 2
        return labels.takeLast(keep).joinToString(".")
    }

    /** What network logging keeps for a lookup of [raw]: its registrable domain, or null. */
    fun of(raw: String?): String? = hostname(raw)?.let(::registrable)

    /** One of 988's websites, or a name under one. */
    fun crisis(domain: String): Boolean = under(domain, CRISIS_988)

    /**
     * The family's private websites as the phone checks them: the policy's
     * `network_log.private_domains` (the server sends registrable domains, like a helpline's), each
     * as a [hostname], anything that isn't one left out, at most
     * [NetworkWireLimits.MAX_PRIVATE_DOMAINS]. Never logged, never in the debug state.
     */
    fun privateSet(domains: List<String>): Set<String> =
        domains.asSequence().take(NetworkWireLimits.MAX_PRIVATE_DOMAINS).mapNotNull(::hostname).toSet()

    /**
     * A name Belay never keeps a lookup of, whatever the policy says about logging, like a call to
     * 988 or to a private number: one of 988's websites or of the family's [private] ones (from
     * [privateSet]), or a name under one. [name] is a [hostname], as the app looked it up, or its
     * [registrable] part. The registrable part ends the hostname, so a hostname matches whenever its
     * registrable part does, and also when the family listed a name under it ("help.example.org").
     */
    fun neverKept(name: String, private: Set<String>): Boolean = crisis(name) || under(name, private)

    /** [name] is one of [list], or a name under one ("chat.example.org" is under "example.org"). */
    private fun under(name: String, list: Collection<String>): Boolean = list.any { name == it || name.endsWith(".$it") }

    /** Longer than any hostname, in any form IDN could shorten. */
    private const val MAX_RAW = 1024
}
