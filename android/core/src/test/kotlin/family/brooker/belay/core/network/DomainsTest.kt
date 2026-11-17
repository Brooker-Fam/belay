package family.brooker.belay.core.network

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** What a looked-up name becomes: made-up names on example domains, and 988's real ones (never kept). */
class DomainsTest {
    @Test
    fun `a name is kept lowercase, in Punycode, without its trailing dot, as its registrable part`() {
        assertEquals("example.com", Domains.of("chat-7.cdn.example.com"))
        assertEquals("example.com", Domains.of("Chat-7.CDN.Example.COM."))
        assertEquals("example.com", Domains.of("  example.com  "))
        assertEquals("example.org", Domains.of("example.org"))
        assertEquals("xn--bcher-kva.example", Domains.of("Bücher.example"))
        assertEquals("xn--bcher-kva.example", Domains.of("www.xn--bcher-kva.example"))
        assertEquals("www.xn--bcher-kva.example", Domains.hostname("WWW.Bücher.example."))
    }

    @Test
    fun `under a country's second level, three labels are kept`() {
        assertEquals("example.co.uk", Domains.of("news.example.co.uk"))
        assertEquals("example.com.au", Domains.of("static.example.com.au"))
        assertEquals("example.ne.jp", Domains.of("a.b.example.ne.jp"))
        assertEquals("example.com.br", Domains.of("example.com.br"))
        // A country code alone, or with a name that isn't a second level, keeps two.
        assertEquals("example.co", Domains.of("www.example.co"))
        assertEquals("t.co", Domains.of("t.co"))
        assertEquals("example.io", Domains.of("someone.example.io"))
        assertEquals("co.uk", Domains.of("co.uk"))
        // Under a generic top level, two: a shared suffix says less about the kid, not more.
        assertEquals("example.com", Domains.of("co.example.com"))
    }

    @Test
    fun `addresses aren't names`() {
        for (address in listOf("192.0.2.10", "192.0.2.10.", "10.0.0.1", "::1", "2001:db8::1", "[2001:db8::1]", "fe80::1%wlan0", "1.2.3.4.5", "example.123")) {
            assertNull(Domains.of(address), address)
        }
    }

    @Test
    fun `reverse lookups and names that never leave the phone or the home network aren't kept`() {
        for (name in listOf(
            "10.2.0.192.in-addr.arpa", "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
            "_dns.resolver.arpa", "printer.local", "router.home.arpa", "localhost", "app.localhost", "nas.internal", "x.invalid",
            // Android logs a reverse lookup that found nothing as "null".
            "null",
        )) {
            assertNull(Domains.of(name), name)
        }
    }

    @Test
    fun `anything that isn't a hostname is left out`() {
        for (bad in listOf(
            null, "", " ", ".", "^", "example", "example..com", ".example.com", "-example.com", "example-.com", "exa mple.com",
            "under_score.example.com", "example.com/path", "user@example.com", "a".repeat(64) + ".example.com",
            (1..60).joinToString(".") { "label" } + ".example.com",
        )) {
            assertNull(Domains.of(bad), bad)
        }
        assertEquals("example.com", Domains.of("a".repeat(63) + ".example.com"))
    }

    @Test
    fun `988's websites are never kept, with any name under them`() {
        for (crisis in listOf("988lifeline.org", "chat.988lifeline.org", "988lineadevida.org", "suicidepreventionlifeline.org", "988.ca", "www.veteranscrisisline.net")) {
            val domain = Domains.of(crisis)
            assertTrue(domain != null && Domains.crisis(domain), crisis)
        }
        assertEquals(setOf("988lifeline.org", "988lineadevida.org", "suicidepreventionlifeline.org", "988.ca", "veteranscrisisline.net"), Domains.CRISIS_988)
        // Only those names: a name that merely contains one is another website.
        assertFalse(Domains.crisis("my988lifeline.org"))
        assertFalse(Domains.crisis(Domains.of("988lifeline.org.example.com") ?: ""))
        assertFalse(Domains.crisis("example.com"))
    }
}
