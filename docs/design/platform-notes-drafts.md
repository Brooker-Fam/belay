# Platform notes: drafts for Phase 2 and later

Entries ready to paste into [docs/platform-notes.md](../platform-notes.md), in its format. They
back the designs in this folder, and re-check some Phase 2 facts.

- **Checked:** 2026-11-17. Doc dates in [brackets] are the page's "Last updated".
- **AOSP:** tag `android-17.0.0_r1` (API 37.0). Paths are in `platform/frameworks/base` unless
  another project is named.
- **Verified on:** nothing here ran on a device. Every entry says *AOSP*, *Docs* or both, and
  what to check on the emulator or the Pixel before Belay relies on it.
- Entries marked **(Phase 2)** matter to the work being built now.

## Summary

| # | What Belay relies on | Verdict | Verified on |
|---|---|---|---|
| U1 | `queryEvents` sees app events at once and keeps several days | Confirmed; use `queryEvents(UsageEventsQuery)` | AOSP; Docs |
| U2 | Daily usage buckets are local days | **Contradicted**: they roll over every 24 h from an arbitrary start | AOSP |
| U3 | A device owner can register usage observers or limit observers | **Contradicted** for Belay: `@SystemApi`, or a system-only role | AOSP |
| U4 | What happens when the kid turns usage access off | Confirmed: Settings allows it; queries go empty, no error | AOSP |
| S1 | What the kid sees for a device-owner suspension; what can't be suspended **(Phase 2)** | Confirmed: one generic screen, "Can't open this app" | AOSP; Docs |
| S2 | Suspending an app stops it **(Phase 2)** | Partly: its tasks close and it loses audio focus; its process keeps running | AOSP; Docs |
| S3 | Belay's inventory still sees apps it hides **(Phase 2)** | **Contradicted**: a hidden app looks uninstalled | AOSP |
| S4 | Belay's suspensions coexist with other suspenders | Partly: Digital Wellbeing's are separate; Android's own parental controls share Belay's | AOSP |
| S5 | `lockNow` locks the phone | Moved to platform-notes.md (Phase 3) | |
| S6 | Exact alarms for schedule boundaries | Moved to platform-notes.md (Phase 3) | |
| W1 | Network logging for a device owner | Confirmed, with limits | AOSP; Docs |
| W2 | `setGlobalPrivateDnsModeSpecifiedHost`: errors and threading **(Phase 2)** | Confirmed, plus two surprises | AOSP; Docs |
| W3 | Chrome's policies through `setApplicationRestrictions` **(Phase 2)** | Confirmed from Chromium's source | Chromium source |
| W4 | In-app browsers (WebView) can be filtered | Confirmed from Chromium's source | Chromium source |
| W5 | A foreground service keeps network access in Doze (re-check of B6) **(Phase 2)** | Confirmed, for two separate reasons | AOSP |
| I1 | `DISALLOW_INSTALL_UNKNOWN_SOURCES(_GLOBALLY)` blocks `adb install` **(Phase 2)** | **Contradicted** | AOSP; Docs |
| I2 | A device owner installs and updates apps with no prompt | Confirmed; the kid sees "Updated by your admin" | AOSP (moved to platform-notes.md) |
| I3 | Developer verification of the device owner's own installs | No device-owner bypass in AOSP 17; Google's exemption wording doesn't settle Belay's case | AOSP; Docs (moved to platform-notes.md) |
| I4 | Hard-restricted permissions (`READ_SMS`) for an adb-installed app | Confirmed: adb allowlists them, and the allowlist only grows | AOSP |
| A4 | Play's `allowed_accounts` managed configuration **(Phase 2)** | Confirmed | Docs |
| F1 | Factory reset protection policy and its broadcasts **(Phase 2)** | Confirmed; send `FRP_CONFIG_CHANGED` as well | AOSP; Docs |
| H1 | `DISALLOW_SIM_GLOBALLY` stops SIM swaps **(Phase 2)** | **Contradicted**: it only blocks eSIM downloads | AOSP; Docs |
| H2 | `DISALLOW_CONFIG_DATE_TIME` covers the time zone | Confirmed | AOSP |
| V1 | `DISALLOW_ADD_USER` keeps Android's own Parental Controls off the phone **(Phase 2)** | **Contradicted**: Settings creates its profile "even when disallowed" | AOSP; Google blog (moved to platform-notes.md) |
| V2 | Other users or profiles on a device-owner phone **(Phase 2)** | They break Private DNS changes and network logs; Belay can list and remove them | AOSP; Docs (moved to platform-notes.md) |
| V3 | Belay could hold the supervision role | **Contradicted**: system-only | AOSP |
| L1 | Belay can grant itself location, background included | Moved to platform-notes.md (Phase 4) | |
| L2 | `setLocationEnabled` and `DISALLOW_CONFIG_LOCATION` | Moved to platform-notes.md (Phase 4) | |
| L3 | "network" and "fused" location without Play services | Moved to platform-notes.md (Phase 4) | |
| L4 | Platform geofencing without Play services | Moved to platform-notes.md (Phase 4) | |
| L5 | Belay needs a `location` foreground service | Moved to platform-notes.md (Phase 4) | |
| L6 | The kid sees when location is used | Moved to platform-notes.md (Phase 4) | |
| T1 | Belay as the default dialer (`setDefaultDialerApplication`) | Confirmed: requirements listed | AOSP; Docs |
| T2 | 911 works when Belay is the dialer | Confirmed: the preloaded dialer takes every emergency call | AOSP; Docs |
| T3 | Android treats 988 like 911 | **Contradicted**: 988 is an ordinary number to Android | AOSP |
| T4 | Call screening sees withheld numbers | **Contradicted** | AOSP; Docs |
| T5 | The dialer decides whether a call rings | Confirmed with `IN_CALL_SERVICE_RINGING` | AOSP; Docs |
| T6 | Blocked numbers, and blocking after an emergency call | Confirmed: the default dialer may write the list; blocking pauses 2 h | AOSP; Docs |
| T7 | Reading texts with `READ_SMS` on Android 17 | Partly: drafts, restricted (RCS) rows and one-time codes are hidden | AOSP; Docs |
| T8 | Google Messages RCS archival | Confirmed in the docs and the code; untested | Docs; AOSP |
| T9 | Belay as the default SMS app | Confirmed: requirements listed; SMS and MMS only | AOSP |
| X1 | adb over WebUSB (Tango) | Confirmed: MIT, Chromium only, USB access is exclusive | Docs; npm |

---

## Screen time

U1 to U4 moved to [docs/platform-notes.md](../platform-notes.md#screen-time-phase-3), with U5.

## Suspension and control

### S1. What the kid sees when Belay suspends an app; what can't be suspended (Phase 2)

**Confirmed.** Verified on: AOSP; Docs.

- `services/core/.../pm/PackageManagerService.setPackagesSuspendedByAdmin`: "Suspension by admin
  isn't attributed to admin package but to the platform", with no dialog info.
- `services/core/.../wm/ActivityStartInterceptor.interceptSuspendedPackageIfNeeded`: when the
  suspender is the platform, tapping the app opens Settings' admin-support screen (with the flag
  `policy_transparency_refactor_enabled`, `ACTION_SHOW_SUSPENDED_PACKAGE_ADMIN_SUPPORT_DETAILS`).
  Settings' strings: title "Can’t open this app", default text "For more info, contact your IT
  admin". With `setShortSupportMessage` the text is the admin's message: "If the message is longer
  than 200 characters it may be truncated" (DevicePolicyManager source and reference [2026-09-16]).
- So the system screen can't say anything per app, like "Waiting for your parent". It shows one
  message for every suspended app.
- Can't be suspended (`SuspendPackageHelper.canSuspendPackageForUser`; DPM reference): active
  device admins, the active launcher, the required installer, uninstaller and verifier, **the
  default dialer**, the permission controller, protected packages, the developer-verification
  service, and (flag `protect_system_required_packages`) required system packages.
  `setPackagesSuspended` returns the ones it couldn't suspend.

Belay's consequence (Phase 2): keep `support_message` generic ("Ask your parent in Belay"); say
*why* in Belay's own notification and screen; report the returned packages as problems.

### S2. Suspension closes the app, but its process keeps running (Phase 2)

**Partly.** Verified on: AOSP; Docs.

- On `ACTION_PACKAGES_SUSPENDED`, `services/core/.../am/BroadcastController` calls
  `onPackagesSuspendedChanged`, and `wm/RecentTasks.onPackagesSuspendedChanged` removes the app's
  tasks (`removeTask(task, false, REMOVE_FROM_RECENTS, "suspended-package")`): its screens close,
  but the process isn't killed. Only quarantined suspensions force-stop the app.
- `services/core/.../audio/AudioService` then calls `MediaFocusControl.noFocusForSuspendedApp`,
  which sends `AUDIOFOCUS_LOSS`. Well-behaved players stop; nothing forces them to.
- DPM reference [2026-09-16]: a suspended package "will not be able to start activities. Its
  notifications will be hidden, it will not show up in recents, will not be able to show toasts or
  dialogs or ring the device."
- Hiding is stronger: `PackageManagerService.setApplicationHiddenSettingAsUser` calls
  `killApplication(…, "hiding pkg")`.

Belay's consequence: suspension is enough for time limits and bedtime; a hard block hides too
(Phase 2). Whether a suspended app's background music or service keeps going on the Pixel is
untested.

### S3. A hidden app looks uninstalled to Belay's own inventory (Phase 2)

**Contradicted** for Belay's Phase 1 inventory. Verified on: AOSP.

- Hiding sends the package-removed broadcasts for that user
  (`pm/BroadcastHelper.sendApplicationHiddenForUser` → `sendPackageRemovedBroadcasts`), and
  unhiding sends package-added (`sendPackageAddedForUser`).
- `pm/pkg/PackageUserStateUtils.isAvailable`: an installed but hidden package is only returned
  with `MATCH_UNINSTALLED_PACKAGES` (or `MATCH_ARCHIVED_PACKAGES`). `ApplicationInfo.FLAG_INSTALLED`
  still says installed (`pm/parsing/PackageInfoUtils`).
- Belay's `inventory/PackageReader.kt` calls `getInstalledPackages(GET_PERMISSIONS)` without it.

Belay's consequence (Phase 2): read with `MATCH_UNINSTALLED_PACKAGES`, keep packages with
`FLAG_INSTALLED`, take "hidden" from `isApplicationHidden`, and ignore the removed and added
broadcasts for packages Belay itself just hid or unhid. Otherwise blocking an app records
"Removed" and unblocking it records "Installed". CI can check it with the fixture app.

### S4. Other suspenders

**Partly.** Verified on: AOSP.

- Each suspender has its own entry (`SuspendPackageHelper`: `putSuspendParams(suspendingPackage,
  …)`); the app stays suspended while any entry remains. What the kid sees comes from the
  quarantine entry first, then the platform's (Belay's), then any other (`getSuspendingPackage`).
- Digital Wellbeing holds `SUSPEND_APPS` through `ROLE_SYSTEM_WELLBEING`
  (`packages/modules/Permission`, `PermissionController/res/xml/roles.xml`) and suspends as itself:
  a separate entry. The kid's own app timers add to Belay's, never undo them.
- Android's own Parental Controls (`services/supervision/.../SupervisionService.applyPackageUsagePolicy`,
  behind the flag `enable_supervision_package_usage_apis`) call
  `PackageManagerInternal.setPackagesSuspendedByAdmin`: **the same platform entry as Belay's**. Its
  "allowed" and "blocked" policies pass `false`, which lifts a Belay suspension too. Its time-limit
  type suspends at once for now ("TODO(b/482425646): Only suspend the package when limit is
  reached").

Belay's consequence: re-read every suspension Belay holds (`isPackageSuspended`) at each
reconcile and on `ACTION_PACKAGES_UNSUSPENDED`, re-apply it, and report that something else lifted
it (V1, Phase 10).

### S5 and S6

Moved to [docs/platform-notes.md](../platform-notes.md#s5-locknow-and-force-lock-and-what-an-update-changes),
re-checked in AOSP 17 with the release flag's value and what an update changes (S5), and with
`USE_EXACT_ALARM`'s effect on the standby bucket (S6).

## Web and network

### W1. Network logging

**Confirmed, with limits.** Verified on: AOSP; Docs.

- developer.android.com/work/dpc/logging [2026-11-15]: for a device owner since Android 8, "TCP
  connections and DNS lookups from system networking calls". "UDP networking isn't logged." Not
  logged as DNS: talking to a DNS server directly, a Java DNS library, a fixed IP address.
- `devicepolicy/NetworkLogger`: a DNS event carries hostname, IP addresses, package and time; a
  connect event carries IP, port, package and time.
- `devicepolicy/NetworkLoggingHandler`: a batch closes at 1200 events or after 90 minutes (an
  alarm with a 30-minute window); at most 5 batches are kept; a retrieved batch is discarded 5
  minutes later. The admin gets `DeviceAdminReceiver.onNetworkLogsAvailable(…, batchToken,
  count)` [2026-08-14] and calls `retrieveNetworkLogs`.
- What the user sees: `DevicePolicyManagerService` posts "Device is managed" / "Your organization
  manages this device and may monitor network traffic. Tap for details." (`core/res` strings), at
  most twice (`ActiveAdmin.DEF_MAXIMUM_NETWORK_LOGGING_NOTIFICATIONS_SHOWN = 2`) and at most once a
  day. The guide adds a section in the Quick Settings device-management dialog. Turning logging off
  deletes unreported logs.
- While any unaffiliated secondary user or profile exists, logging pauses, the callback stops and
  `retrieveNetworkLogs` throws `SecurityException` (the guide; `maybePauseDeviceWideLoggingLocked`,
  `checkAllUsersAreAffiliatedWithDevice`). See V2.

### W2. Private DNS: `setGlobalPrivateDnsModeSpecifiedHost` (Phase 2)

**Confirmed, plus two surprises.** Verified on: AOSP; Docs.

- DPM reference [2026-09-16]: device owner only; "the method is blocking as it will perform a
  connectivity check to the resolver"; "may take several seconds to complete, so it should only be
  called from a worker thread". Returns `PRIVATE_DNS_SET_NO_ERROR`,
  `PRIVATE_DNS_SET_ERROR_HOST_NOT_SERVING` or `PRIVATE_DNS_SET_ERROR_FAILURE_SETTING`; throws
  `IllegalArgumentException` for an invalid hostname.
- Surprise 1: the check runs in Belay's own process (`DevicePolicyManager` →
  `core/java/android/net/PrivateDnsConnectivityChecker.canConnectToPrivateDnsServer`): a TLS
  handshake to port 853 with a 5-second read timeout and no explicit connect timeout. Any
  `IOException`, being offline included, returns `HOST_NOT_SERVING`.
- Surprise 2: `DevicePolicyManagerService.setGlobalPrivateDns` calls
  `checkAllUsersAreAffiliatedWithDevice()`, which throws `SecurityException` ("operation not
  allowed when device has unaffiliated users"). The reference says so too. The same check guards
  `setRecommendedGlobalProxy`, `requestBugreport` and `retrieveNetworkLogs`.

Belay's consequence (Phase 2): run it on a worker thread off the agent's queue; when offline,
treat `HOST_NOT_SERVING` as "try again later", not as a bad host; catch the `SecurityException`
and report it (V2).

### W3. Chrome's policies on Android (Phase 2)

**Confirmed from Chromium's source; untested on a phone.** Verified on: Chromium source
(`chromium/src`, branch main, `components/policy/resources/templates/policy_definitions/`).

Each policy's `supported_on` for Android (Chrome version):

| Policy | Android from | Values |
|---|---|---|
| `IncognitoModeAvailability` | 30 | 0 available, 1 disabled, 2 forced |
| `ForceGoogleSafeSearch` | 41 | bool |
| `ForceYouTubeRestrict` | 55 | 0 off, 1 moderate, 2 strict |
| `DnsOverHttpsMode` | 85 | `"off"`, `"automatic"`, `"secure"` |
| `BrowserSignin` | 70 | 0 disable, 1 enable; 2 (force) only from 153 |
| `SafeSitesFilterBehavior` | 116 | 0 off, 1 filter adult sites |
| `DownloadRestrictions` | 131 | 0 to 4; 3 blocks all downloads |
| `URLAllowlist`, `URLBlocklist` | 86 (and Android WebView 86) | list of URL patterns |
| `IncognitoModeUrlBlocklist` | 147 | list |

- Encoding (`components/policy/core/common/android/policy_converter.cc`): Bundle booleans, ints,
  strings and string arrays map directly. A string is also accepted for a boolean ("true",
  "false"), an integer, or a list (a JSON array, or comma-separated values).
- Chrome reads them with `UserManager.getApplicationRestrictions(packageName)`
  (`components/policy/android/java/src/org/chromium/components/policy/AppRestrictionsProvider.java`),
  which returns what a device owner set with `setApplicationRestrictions`, so no managed Google
  Play is needed (A3). Untested on the Pixel's Chrome version.

### W4. In-app browsers (WebView)

**Confirmed from Chromium's source; untested.** Verified on: Chromium source.
`android_webview/java/src/org/chromium/android_webview/policy/AwPolicyProvider.java` reads the
*host app's* restrictions, only keys that start with `com.android.browser:` (for example
`com.android.browser:URLBlocklist`). So a device owner can filter one app's in-app browser by
setting that app's restrictions. Custom Tabs run in Chrome, under Chrome's policies.

### W5. Network access in Doze, re-checked (Phase 2)

**Confirmed, for two separate reasons.** Verified on: AOSP.

- `core/java/android/net/NetworkPolicyManager.isProcStateAllowedWhileIdleOrPowerSaveMode`: a
  process state up to `PROCESS_STATE_BOUND_FOREGROUND_SERVICE` keeps network access in Doze. A
  process with a running foreground service qualifies.
- Separately, an app on the Doze allowlist is allowed (`NetworkPolicyManagerService.updateRulesForAllowlistedPowerSaveUL`); Belay is on it (B6).
- AOSP 17 also turns on a background firewall chain at boot (`enableFirewallChainUL(FIREWALL_CHAIN_BACKGROUND, true)`),
  which allows process states below `TOP_SLEEPING` and power-allowlisted apps. Belay passes it
  both ways.

## Installs and accounts

### I1. `adb install` and the unknown-sources restrictions (Phase 2)

**Contradicted.** Verified on: AOSP; Docs.

- UserManager reference [2026-08-28], `DISALLOW_INSTALL_UNKNOWN_SOURCES`: "Unknown sources exclude
  adb and special apps such as trusted app stores." `DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY` is
  "a device-wide version" of it.
- `pm/PackageInstallerService.createSessionInternal` refuses every install under
  `DISALLOW_INSTALL_APPS` and marks shell and root installs `INSTALL_FROM_ADB`; there is no
  unknown-sources check on that path.
- `DISALLOW_DEBUGGING_FEATURES` turns adb off, which is what stops `adb install`.

Belay's consequence (Phase 2): the threat model's "sideload an APK" row is closed by the
unknown-sources restriction; `adb install` only by `debugging`, which maintenance mode lifts.

### I2. Silent installs by the device owner

**Moved** to [platform-notes.md](../platform-notes.md#i2-silent-installs-by-the-device-owner) and checked again for Phases 6 and 10 (2026-11-17); this draft stays as it was written.

**Confirmed.** Verified on: AOSP.

- `pm/PackageInstallerSession.computeUserActionRequirement`: "Device owners and affiliated profile
  owners are allowed to silently install packages" (`canSilentlyInstallPackage`), unless the
  session itself asks for user action.
- Downgrades need `INSTALL_ALLOW_DOWNGRADE`, which `createSessionInternal` sets only on
  debuggable Android builds (`Build.IS_DEBUGGABLE`: not a Pixel's user build) or for system and
  root callers, and clears otherwise.
- After a device-owner install the system posts "Installed by your admin." or "Updated by your
  admin." with "Go to settings to view granted permissions" (`core/res` strings
  `package_installed_device_owner`, `package_updated_device_owner`;
  `PackageInstallerSession.sendOnPackageInstalled`).
- The session code reads `REQUEST_INSTALL_PACKAGES` only for metrics; no check for a device owner
  was found. Test before deciding whether Belay declares it.

### I3. Developer verification and the device owner's own installs

**Moved** to [platform-notes.md](../platform-notes.md#i3-developer-verification-and-the-device-owners-own-installs) and checked again for Phases 6 and 10 (2026-11-17); this draft stays as it was written.

**No device-owner bypass in AOSP 17; Google's wording doesn't settle Belay's case.** Verified on:
AOSP; Docs.

- `PackageInstallerSession.shouldUseVerificationService`: the platform's only bypasses are adb
  installs (while the flag `verification_service_adb` is off), test installs and the emergency
  installer. D1 already noted this.
- Developer verification FAQ [page 2026-11-17]: adb installs need no verification. "Apps
  distributed through your organization store, on managed devices, won't need to complete the
  verification requirements since your IT admin has vetted them. However, we recommend to still
  register and claim these apps" (answer dated 2025-09-03). "Unregistered apps can only be
  installed or updated when the advanced flow is enabled or by using ADB" (2026-03-25). The
  advanced flow starts in developer options and has a 24-hour wait.
- A third party (bayton.org Android Enterprise FAQ, edited 2026-10-19) says "Apps installed via an
  EMM DPC are exempt indefinitely", and that the September 2027 extension is for public Play apps
  on managed devices. Not Google's words.
- Whether an adb-provisioned controller that Google never approved counts as "your organization
  store" isn't stated, and the answer comes from Google's verifier, not from AOSP code.

Belay's consequence: register the package (D1); a self-update must survive a refusal (report it,
fall back to adb in maintenance mode); measure on the Pixel when enforcement reaches the US.

### I4. Hard-restricted permissions for an adb-installed app

**Confirmed.** Verified on: AOSP.

- `READ_SMS`, `RECEIVE_SMS`, `SEND_SMS` and `READ_CALL_LOG` are `hardRestricted`
  (`core/res/AndroidManifest.xml`): one "cannot be held by an app until the installer on record
  allowlists the permission".
- A shell install allowlists them all by default (`pm/PackageManagerShellCommand.makeInstallParams`:
  "Allowlist all permissions by default"; `--restrict-permissions` turns it off).
- `PackageInstaller.SessionParams` also defaults to `INSTALL_ALL_WHITELIST_RESTRICTED_PERMISSIONS`
  ("Initially, all restricted permissions are allowlisted"), and nothing found in
  `PackageInstallerService` or `PackageInstallerSession` strips it for an ordinary installer.
- Each install *adds* to the existing allowlist (`services/permission/.../PermissionService.onPackageInstalled`
  → `addAllowlistedRestrictedPermissionsUnchecked`), so an exemption survives later updates.
- "Allowlisting trumps policy": a policy grant of a hard-restricted permission that isn't
  allowlisted is dropped (`AppIdPermissionPolicy.updatePermissionExemptFlags`).

To check on the emulator: `dumpsys package <belay>` shows `RESTRICTION_INSTALLER_EXEMPT` for
`READ_SMS` after an adb install, and still after a self-update.

### A4. Play's `allowed_accounts` (Phase 2)

**Confirmed.** Verified on: Docs. developer.android.com/work/dpc/security [2026-11-15]: a managed
configuration for `com.android.vending` with the key `allowed_accounts`, the account emails as one
comma-separated string; "Supported in Google Play version 80970100 or higher"; "An empty string
prevents people using any account in Google Play." Untested.

### F1. Factory reset protection (Phase 2)

**Confirmed; send both broadcasts.** Verified on: AOSP; Docs.

- developer.android.com/work/dpc/security [2026-11-15]: get each account's id with the People API
  (`people.get` with `me`, `resourceName` "people/[userId]"); "Newly-created accounts might not be
  available for factory reset purposes for 72 hours"; set them with
  `setFactoryResetProtectionPolicy` (API 30), then send `com.google.android.gms.auth.FRP_CONFIG_CHANGED`
  as an explicit broadcast to `com.google.android.gms`. "Factory reset protection is disabled if
  OEM unlocking is enabled in Developer Options."
- AOSP 17 `DevicePolicyManagerService.setFactoryResetProtectionPolicy` also broadcasts
  `ACTION_RESET_PROTECTION_POLICY_CHANGED` itself, to the FRP agent (the persistent data block's
  allowed uid), and throws `UnsupportedOperationException` when there's no persistent data block
  (`isFactoryResetProtectionPolicySupported`).

Belay's consequence (Phase 2): check support, set the policy, send `FRP_CONFIG_CHANGED`. The
recovery-mode reset test on the Pixel remains (ROADMAP).

### H1. SIM restrictions (Phase 2)

**Contradicted.** Verified on: AOSP; Docs.

- UserManager reference [2026-08-28]: `DISALLOW_SIM_GLOBALLY` "specifies if the user is able to
  add embedded SIMs to the device. This restriction blocks the download of embedded SIMs."
  (`frameworks/opt/telephony`, `euicc/EuiccController` checks it only when downloading.)
- Nothing stops a physical SIM swap (the Pixel 8 has a SIM tray) or switching between eSIMs that
  are already on the phone. `DISALLOW_CONFIG_MOBILE_NETWORKS` locks the mobile-network settings
  (untested).
- A device owner holding `READ_PHONE_STATE` passes the device-identifier check
  (`telephony/common/.../TelephonyPermissions` → `checkDeviceIdentifierAccess`), so Belay can notice
  a different SIM.

Belay's consequence (Phase 2): keep the restriction, consider `config_mobile_networks`, and report
"a different SIM is in the phone" (a salted hash on the phone, never the number) instead of
claiming SIM swaps are blocked.

### H2. The time zone is covered

**Confirmed.** Verified on: AOSP. `DISALLOW_CONFIG_DATE_TIME` "disables all configuring of date,
time and timezone in Settings" (UserManager source); DPM has `setAutoTimeZonePolicy` next to
`setAutoTimePolicy`.

## Android's own parental controls

### V1. Android's Parental Controls on a Belay phone (Phase 2)

**Moved** to [platform-notes.md](../platform-notes.md#v1-androids-parental-controls-on-a-belay-phone) and checked again for Phases 6 and 10 (2026-11-17); this draft stays as it was written.

**Contradicted: `DISALLOW_ADD_USER` doesn't keep them off.** Verified on: AOSP; Google's blog.

- Google (blog.google, "New expanded Android parental controls", 2026-06-16): Android Parental
  Controls are "located directly within Android Settings", "protected by an easy-to-set PIN", with
  a daily limit, downtime, app limits and blocking, and Play rating filters; "expanding Android
  Parental Controls to all Android devices that update to Android 17"; launched on Pixel in 2025.
- In AOSP 17 the PIN is the screen lock of a **supervising profile**, a hidden user
  (`UserManager.USER_TYPE_PROFILE_SUPERVISING`, at most one;
  `SupervisionService.hasSupervisionCredentials`). Settings (`supervision/SetupSupervisionActivity.kt`)
  creates it with `createProfileForUserEvenWhenDisallowed`, so `DISALLOW_ADD_USER` doesn't stop
  it.
- Settings shows the entry when the flag `enable_supervision_settings_screen` is on and the system
  supervision component is present (`TopLevelSupervisionPreferenceController`); there's no
  device-owner check.
- Before provisioning, an existing supervising profile counts as a user:
  `nonTestNonPrecreatedUsersExist` makes `dpm set-device-owner` refuse (P3). `adb shell cmd user
  list -v` shows it as `type=profile.SUPERVISING` (`pm/UserManagerServiceShellCommand`).
- With verified recovery info and no supervision role holder, `SupervisionService` sets
  `DISALLOW_FACTORY_RESET` as its own system entity.

On the Pixel, untested: whether Settings offers it on a device-owner phone, and which packages
hold the supervision roles (`dumpsys role`).

### V2. Other users or profiles on a device-owner phone (Phase 2)

**Moved** to [platform-notes.md](../platform-notes.md#v2-other-users-or-profiles-on-a-device-owner-phone) and checked again for Phases 6 and 10 (2026-11-17); this draft stays as it was written.

**Confirmed.** Verified on: AOSP; Docs.

- `devicepolicy/DeviceAdmins.areAllUsersAffiliatedWithDevice` checks every alive user; any user
  without an affiliated profile owner fails it: a supervising profile (V1), a guest, a clone or a
  private profile.
- Then `retrieveNetworkLogs`, `setGlobalPrivateDns`, `setRecommendedGlobalProxy` and
  `requestBugreport` throw `SecurityException`, and network and security logging pause (W1, W2).
  A Private DNS host already set stays set.
- `getSecondaryUsers(admin)` (device owner) lists every alive non-system user except managed
  profiles; `removeUser(admin, user)` removes one with `removeUserEvenWhenDisallowed`, unless
  someone other than the device owner set `DISALLOW_REMOVE_USER`.

Belay's consequence: report any other user or profile; remove one only when a parent approves
(Phase 10).

### V3. The supervision role

**Contradicted for Belay.** Verified on: AOSP. `roles.xml`: `SYSTEM_SUPERVISION` (`systemOnly`,
`static`, default holder `config_systemSupervision`) and `SUPERVISION` (`systemOnly`, needs a
`SUPERVISION_APP_SERVICE`). `config_allowedSupervisionRolePackages` can admit named packages with
a certificate digest, but the device maker sets it. Settings' `EnableSupervisionActivity` "is only
available to the system supervision role and allowlisted packages". `SupervisionManager` is
`@SystemApi`.

## Location

L1 to L6 moved to [docs/platform-notes.md](../platform-notes.md#location-and-the-kids-side-phases-4-and-7),
with L7 to L10 and G1 to G2.

## Calls and texts

### T1. Belay as the default dialer

**Confirmed.** Verified on: AOSP; Docs.

- `setDefaultDialerApplication(packageName)` (API 34, device owner): `DevicePolicyManagerService`
  calls `RoleManager.addRoleHolderAsUser(ROLE_DIALER, …)` and waits up to 20 s; it throws
  `IllegalArgumentException` if that fails or times out.
- `roles.xml`, `DIALER` requires an activity for `ACTION_DIAL`, one for `ACTION_DIAL` with `tel:`,
  and (target 33 and up) an `InCallService` protected by `BIND_INCALL_SERVICE` with meta-data
  `android.telecom.IN_CALL_SERVICE_UI = true` and no car-mode UI flag. The role grants its holder
  the phone, contacts, SMS, microphone, camera and notification permissions it declares.
- InCallService reference [2026-09-16]: the app must "fully implement the InCallService API and
  provide both an incoming call UI, as well as an ongoing call UI"; don't mark the service
  `exported="false"`; a holder that stops meeting the requirements is removed from the role.
- The default dialer can't be suspended (S1).

### T2. 911 with a third-party dialer

**Confirmed.** Verified on: AOSP; Docs.

- InCallService reference [2026-09-16]: "The preloaded dialer will ALWAYS be used when the user
  places an emergency call, even if your app fills the ROLE_DIALER role"; place every call with
  `TelecomManager.placeCall`; an emergency `ACTION_CALL` from another dialer is "raised to the
  preloaded dialer app using ACTION_DIAL for confirmation".
- `packages/services/Telecomm`, `InCallController.EmergencyInCallServiceConnection` proxies to the
  default dialer "until it finds an emergency call, or the other connection dies", then binds the
  system dialer. If the dialer returns a null binding, Telecom falls back to the preloaded dialer
  and tells the user.

Belay's consequence: the preloaded dialer (on a Pixel, Google's Phone app; check the package) is
never hidden, suspended or disabled.

### T3. 988 is an ordinary number to Android

**Contradicted.** Verified on: AOSP.

- `packages/services/Telephony`, `ecc/input/eccdata.txt`: the US entry lists only 911 (police,
  ambulance, fire; fallback 911). Carriers and SIMs can add numbers. 988 goes through the default
  dialer like any other call.
- `core/res/res/xml/sms_short_codes.xml`: US short codes match `\d{5,6}`, so 988 isn't treated as a
  short code, and texting it shows no premium-SMS warning.

Belay's consequence: 988 is on Belay's own always-allowed list, in code.

### T4. Call screening and withheld numbers

**Contradicted.** Verified on: AOSP; Docs. CallScreeningService reference [2026-09-16]: only `tel:`
calls; only calls from numbers not in contacts, unless the service holds `READ_CONTACTS`; "Calls
with a … PRESENTATION_RESTRICTED, PRESENTATION_UNKNOWN, PRESENTATION_UNAVAILABLE or
PRESENTATION_PAYPHONE presentation are not provided"; the service must answer within 5 seconds; it
also sees outgoing calls, for caller id; blocked calls are logged as `BLOCKED_TYPE`.

### T5. The dialer decides whether a call rings

**Confirmed in the docs; untested.** Verified on: AOSP; Docs. InCallService reference: with the
meta-data `android.telecom.IN_CALL_SERVICE_RINGING`, the app "is responsible for playing the
ringtone for incoming calls", through its own incoming-call notification channel.

### T6. Blocked numbers

**Confirmed.** Verified on: AOSP; Docs. BlockedNumberContract [2026-08-03]: "Only the system, the
default SMS application, and the default phone app … and carrier apps can read, and write";
"The platform blocks calls, and messages from an address if it is present". CarrierConfigManager
`KEY_DURATION_BLOCKING_DISABLED_AFTER_EMERGENCY_INT`: "The duration in seconds that platform call
and message blocking is disabled after the user contacts emergency services", default 7200.

### T7. Reading texts with `READ_SMS` on Android 17

**Partly.** Verified on: AOSP; Docs.

- `packages/providers/TelephonyProvider`, `SmsProvider` and `ProviderUtil`: callers other than
  the system, the phone process and the default SMS app get a restricted view: sent and received
  messages only, no drafts, no subqueries.
- Behind the flag `secure_access_to_restricted_rcs_messages`, rows marked restricted are only
  visible to callers with `OP_READ_RESTRICTED_MESSAGES` (`AppOpsManager`: "A restricted message can
  only be read by an app granted with this access… granted only to a limited set of roles"). The
  `DIALER` and `SMS` roles carry it.
- One-time codes: Android 17 behavior changes [2026-11-11]: for apps targeting 37, SMS messages
  with a one-time code are held for three hours, during which "the SMS_RECEIVED_ACTION broadcast is
  withheld and SMS provider database queries are filtered"; the default SMS app and some others
  are exempt.
- `READ_SMS` is hard-restricted (I4).

### T8. Google Messages RCS archival

**Confirmed in the docs and the code; untested.** Verified on: Docs; AOSP.

- developer.android.com/work/dpc/rcs-messages-archival [2026-10-23]: "available only on fully
  managed devices"; Google Messages must be the default messaging app; set Google Messages'
  managed configuration `messages_archival` to the archival app's package name. "Google Messages
  writes message data to Android on message events" (sent, received, edited, deleted) "for both RCS
  and SMS/MMS messages", and sends an explicit broadcast, action `GOOGLE_MESSAGES_ARCHIVAL_UPDATE`,
  sometimes with the extra `com.google.android.apps.messaging.EXTRA_ARCHIVAL_URI`, to a foreground
  service the archival app declares (exported, `foregroundServiceType="shortService"`, protected by
  `WRITE_SMS`). The archival app "needs READ_SMS permission". Recommended: "Disallow user control
  over Google Messages and archival app"; batch uploads with JobScheduler.
- Google's admin help (support.google.com/work/android/answer/13761869, no date): "Users are
  clearly informed when message archival is active on their device." Also a `disable_rcs`
  restriction.
- AOSP 17 `devicepolicy/RcsArchivalAppTracker` reads `messages_archival` from the application
  restrictions a device policy controller set on the default SMS app (preferring a DPC's), and
  grants that package `OP_READ_RESTRICTED_MESSAGES`; it re-checks when the SMS role or those
  restrictions change.

Untested: that it works with restrictions from an adb-provisioned controller and no managed Google
Play (the AOSP code reads exactly what `setApplicationRestrictions` stores); what the kid sees.

### T9. Belay as the default SMS app

**Confirmed: the requirements.** Verified on: AOSP. `setDefaultSmsApplication` (device owner).
`roles.xml`, `SMS` requires a receiver for `SMS_DELIVER` (protected by `BROADCAST_SMS`), one for
`WAP_PUSH_DELIVER` with MIME type `application/vnd.wap.mms-message` (`BROADCAST_WAP_PUSH`), a
`RESPOND_VIA_MESSAGE` service (`SEND_RESPOND_VIA_MESSAGE`, `smsto:`), and a `SENDTO` activity for
`smsto:`. It grants the phone, contacts, SMS, storage, microphone, camera and notification
permissions, and the `write_sms` app-op. No public API was found for a third-party app to send or
receive RCS chats, so an app replacing Google Messages handles SMS and MMS only (a negative claim:
not exhaustively checked).

## Setup tools

### X1. adb over WebUSB: Tango (ya-webadb)

**Confirmed.** Verified on: Docs; the npm registry. Moved to
[platform-notes.md](../platform-notes.md) (X1, with X2 to X4) and re-checked for Phase 8.

- npm registry (2026-11-17): `@yume-chan/adb` 2.6.4, `@yume-chan/adb-daemon-webusb` 2.3.2,
  `@yume-chan/android-bin` 2.1.0, `@yume-chan/adb-credential-web` 2.1.0; all MIT, repository
  github.com/yume-chan/ya-webadb, last published 2026-11-06.
- Tango docs (v2.6.2, docs.tangoapp.dev/tango/daemon/usb/, no date): WebUSB in Chromium-based
  browsers; one program at a time can claim the ADB interface: "If Google ADB has already claimed
  the ADB interface, WebUSB API in Chrome or usb package can't claim it again."
- `dpm set-device-owner` is a shell command, so any adb client that runs shell commands can run
  it. Untested with Tango. WebUSB only works in a secure context (https, or localhost).
