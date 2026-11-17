package family.brooker.belay.core

/**
 * Phone settings that can get around Belay's rules but that Belay doesn't lock, because locking
 * them would take too much from the kid (all of Wi-Fi's settings, or Developer options before a
 * parent chooses the debugging lock). Belay reports them instead, in its own words, like any
 * problem ("silence is a signal"). The server shows a report naming a proxy or wireless debugging
 * as someone maybe getting around Belay (server/src/family/devices.ts), so the words stay so.
 */
object Workarounds {
    /**
     * A proxy on the phone's network (platform notes H2): a manual proxy or a proxy script on a
     * Wi-Fi network, a proxy on the mobile network's access point (APN), or a global one set over
     * adb. A proxy looks names up itself, so what goes through it skips Private DNS. Chrome
     * doesn't use one while Belay sets Chrome's settings (ChromeConfig.PROXY_DIRECT).
     */
    const val PROXY =
        "This phone's network uses a proxy, set in its Wi-Fi or mobile network settings. " +
            "Apps that use the proxy can get around the web filter."

    /**
     * Wireless debugging on (platform notes H6): adb over Wi-Fi, which another phone, or an app on
     * this one, can pair with without a computer. The debugging lock turns it off and keeps it off.
     */
    const val WIRELESS_DEBUGGING =
        "Wireless debugging is on in Developer options: another phone, or an app on this one, can " +
            "use it to change settings around Belay. Locking Developer options (hardening) turns it off."

    /**
     * What to report about [proxy] and [wirelessDebugging], as the phone has them now, under
     * [plan]: a proxy only while the policy has a web filter (without one, it gets around
     * nothing Belay does), and wireless debugging unless the policy lifted debugging on purpose
     * (maintenance, or the recovery key's repair access).
     */
    fun problems(plan: EnforcementPlan, proxy: Boolean, wirelessDebugging: Boolean): List<String> = listOfNotNull(
        PROXY.takeIf { proxy && plan.privateDns != null },
        WIRELESS_DEBUGGING.takeIf { wirelessDebugging && plan.maintenanceUntil == null && plan.recoveryUntil == null },
    )
}
