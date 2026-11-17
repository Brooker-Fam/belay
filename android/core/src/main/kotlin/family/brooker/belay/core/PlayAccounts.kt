package family.brooker.belay.core

/**
 * Play's allowed accounts (the policy's `play_accounts`, docs/protocol.md; platform notes A4): the
 * parent-owned Google accounts Google Play may use. Belay sets them as Play's managed
 * configuration, the key [KEY] for the package [PLAY_STORE], whose value is one string of the
 * accounts' email addresses separated by commas. An empty string would keep every account out of
 * Play, so Belay never sets one: with no accounts in the policy it sets nothing, and takes back
 * what it set. Debug builds set them too: they can't lock anyone out of the phone.
 */
object PlayAccounts {
    /** Google Play's package. */
    const val PLAY_STORE = "com.android.vending"

    /** The managed configuration's key (Google's guide for device policy apps, platform notes A4). */
    const val KEY = "allowed_accounts"

    /** At most this many, as the server sends. */
    const val MAX = 5

    private const val MAX_LENGTH = 254

    /** As the server checks them (schemas.ts's googleAccount): lowercase, and never a comma or a space. */
    private val EMAIL = Regex("^[a-z0-9._%+'-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")

    fun valid(account: String): Boolean = account.length <= MAX_LENGTH && EMAIL.matches(account)

    /**
     * The accounts to set: trimmed, lowercase, each once, at most [MAX]; null when there are none
     * (Belay sets nothing). One that isn't an email address is left out, and the problem says so in
     * Belay's own words, without it.
     */
    fun plan(accounts: List<String>, problems: MutableList<String>): List<String>? {
        val cleaned = accounts.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
        val good = cleaned.filter(::valid)
        if (good.size < cleaned.size) problems += "Play's accounts: one isn't an email address, so Belay left it out."
        return good.take(MAX).takeIf { it.isNotEmpty() }
    }

    /** The configuration's value: the accounts, comma-separated, as Google's guide shows. */
    fun value(accounts: List<String>): String = accounts.joinToString(",")
}
