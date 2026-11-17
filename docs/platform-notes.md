# Platform notes

Every Android behavior Belay relies on, checked against current documentation and
the Android 17 source code, with the Android version it applies to. When Belay starts
relying on something new, it goes here first, with a source.

- **Checked:** 2026-11-16, unless noted. Doc dates in [brackets] are the page's
  "Last updated".
- **AOSP:** tag `android-17.0.0_r1` (API 37.0) on android.googlesource.com. Paths are in
  `platform/frameworks/base` unless another project is named.
- **Verified on:**
  - *Docs/AOSP*: read in documentation or source code, not yet seen on a device.
  - *Emulator*: checked by CI on the API 37.0 emulator (`android/scripts/ci-emulator-test.sh`).
  - *Pixel 8*: checked on the real phone with the Phase 0 checklist. All Pixel 8 results
    are still **pending**; see [Phase 0 results](#phase-0-results).

## Summary

| # | What Belay relies on | Verdict | Verified on |
|---|---|---|---|
| P1 | Google blocks QR provisioning of unapproved device-owner apps | Confirmed | Docs; Pixel 8 pending (step 4) |
| P2 | `adb shell dpm set-device-owner` still works for an unapproved app | Not stated by Google; works in practice | Emulator; Pixel 8 pending (step 1) |
| P3 | `dpm set-device-owner` needs no accounts, no other users or profiles | Confirmed, plus a new Android 17 condition | AOSP (the refusals); Emulator (the clean case) |
| P4 | `dpm remove-active-admin` only for test-only admins; otherwise factory reset | Confirmed, with nuance | AOSP; Emulator (debug) |
| P5 | What `dpm set-device-owner` broadcasts, and what starts Belay | Confirmed; the broadcasts miss a never-run app | AOSP; Emulator |
| A1 | A Family Link child account can't sit next to a device owner | Very likely; unconfirmed by Google | Sources only |
| A2 | A parent-owned regular Google account works with Play on a fully managed phone | Third-party sources only | Pixel 8 pending (step 3) |
| A3 | The Android Management API isn't open to parental control | Confirmed | Docs |
| K1 | Manifest receivers only get `PACKAGE_FULLY_REMOVED` and `PACKAGE_DATA_CLEARED` | Confirmed | Docs; AOSP; Emulator |
| K2 | `getChangedPackages` resets every boot; key it to `BOOT_COUNT` | Confirmed | Docs; AOSP |
| K3 | Seeing every package needs `QUERY_ALL_PACKAGES`, no device-owner exemption | Confirmed | Docs; AOSP; Emulator |
| K4 | Install source: what each field says for Play, adb, sideloads, preinstalled | Mostly confirmed; Play's values to measure | AOSP; Pixel 8 pending |
| B1 | Device owners may start a foreground service from the background, type `systemExempted` | Confirmed; the docs get two details wrong | Docs; AOSP; Emulator |
| B2 | The managed notice can't be dismissed (Android 14+) | Confirmed, needs `setOngoing(true)` | Docs; AOSP; Emulator |
| B3 | The notice can't be turned off once `POST_NOTIFICATIONS` is granted by policy | Partly: the channel only locks after the next boot | AOSP |
| B4 | Active device admins are in the exempt standby bucket | Confirmed | AOSP; Emulator |
| B5 | Settings can't force-stop or clear the storage of a device owner | Confirmed, enforced below Settings too | AOSP |
| B6 | Doze still applies; `dumpsys deviceidle whitelist +pkg` exempts it | Confirmed | AOSP; Emulator |
| B7 | Android keeps a device owner's `DeviceAdminService` bound | Confirmed | Docs; Emulator |
| R1 | Usage access can't be self-granted, can be revoked; grant it over adb | Confirmed | Docs; AOSP; Emulator |
| R2 | A device owner can pre-grant its runtime permissions, unrevocably | Confirmed | Docs; AOSP; Emulator |
| R3 | targetSdk 37: a home-network server needs `ACCESS_LOCAL_NETWORK` | Confirmed | Docs |
| R4 | targetSdk 37: Certificate Transparency on by default | Confirmed, with an exception | Docs |
| D1 | Developer verification: dates, ADB exemption, limited-distribution account | Partly; important details below | Docs |
| M1 | Declaring a monitoring tool: `android:isMonitoringTool="parental_control"` | **Contradicted**: it's a meta-data entry | SDK; Play docs |
| M2 | 37.2 adds `…_INCLUDING_REGISTERED_APP_STORES` | Confirmed; exact name differs from the brief | SDK |
| K5 | Which apps have special access, read without special permissions | Confirmed | AOSP |
| R5 | CAMERA only while the enrollment screen is open: the grant states, and revoking kills the app | Confirmed | AOSP |
| N1 | HTTPS only, the system's CAs; plain http only in debug builds, to the emulator's host | Confirmed; CT through OkHttp unproven | Docs; Emulator (cleartext path) |
| N2 | Compose's EmojiCompat would ask Play services for a font; Belay turns it off | Confirmed | androidx source |
| E1 | Enrolling over adb: a receiver only the shell can reach, and its answer | Confirmed | AOSP; Emulator (Phase 1 CI) |
| C1 | Suspending apps: who can't be suspended, and what suspension does | Confirmed | AOSP; Emulator pending (Phase 2 CI) |
| C2 | What a suspended app shows the kid | Confirmed; check the title on the Pixel | AOSP |
| C3 | Hiding apps: killed, "removed" broadcast, invisible to plain queries | Confirmed | AOSP; Emulator pending (Phase 2 CI) |
| C4 | User restrictions: API levels, unknown keys, what debugging and SIM locks really do | Confirmed; corrects M2 | AOSP; SDK |
| C5 | The unknown-sources restrictions don't block `adb install` | Confirmed for 37.0; 37.2's new key unverified | AOSP |
| C6 | Private DNS: device owner only, check in Belay's process, offline and other-user traps | Confirmed | AOSP |
| C7 | Chrome's managed configuration: names and types | Confirmed | Chromium source |
| C8 | Factory reset protection: who's notified, and when it can't apply | Confirmed | AOSP |
| C9 | Network in Doze for a foreground-service process; exact alarms | Confirmed | AOSP |
| C10 | Reading the phone, SMS, emergency, browser and keyboard apps without permissions | Confirmed | AOSP |
| C11 | Android's own Parental Controls profile: detectable, not identifiable | Confirmed | AOSP |
| U1 | Foreground time comes from `queryEvents`, fresh, kept about 10 days | Confirmed | AOSP; Docs |
| U2 | Android's daily buckets aren't local days | Contradicted | AOSP |
| U3 | The usage-limit observers aren't open to Belay | Contradicted | AOSP |
| U4 | The kid can turn usage access off, and back on | Confirmed | AOSP |
| U5 | How usage events behave at boots, clock changes and query edges | Confirmed in source | AOSP |
| U6 | Screen on, off and unlocked reach registered receivers only; clock and zone changes reach manifest ones | Confirmed | AOSP; Docs; Emulator pending (Phase 3 CI) |
| U7 | Watching Belay's own usage access with `startWatchingMode` | Confirmed | AOSP; Emulator pending (Phase 3 CI) |
| U8 | `queryEvents(UsageEventsQuery)`: its period check, and where keyguard events come from | Confirmed | AOSP; SDK |
| U9 | Settings opens Belay's own usage access switch for a `package:` address | Confirmed in AOSP Settings; not documented | AOSP |
| S5 | `lockNow` needs `<force-lock/>` on Android 17's first release; an update gets it at the next boot | Confirmed | AOSP; Emulator pending (Phase 3 CI) |
| S6 | Exact alarms: the Doze allowlist exempts Belay; `USE_EXACT_ALARM` as the backup | Confirmed | AOSP |
| S7 | Telling from a shell whether the screen is off or locked | Confirmed | AOSP |
| I2 | A device owner's PackageInstaller session installs with nobody confirming; no downgrades | Confirmed | AOSP; Docs; Emulator pending (Phase 6 CI) |
| I3 | Developer verification has no device-owner bypass | Confirmed in AOSP; Google's wording doesn't settle Belay's case | AOSP; Docs (drafts) |
| I5 | Only the shell can install a test-only APK | Confirmed: `INSTALL_FAILED_TEST_ONLY` for every app | AOSP |
| I6 | An APK's package, version code and signing certificates, read before installing | Confirmed | AOSP |
| I7 | Updating itself kills Belay; `MY_PACKAGE_REPLACED` starts the new one | Confirmed | AOSP; Emulator pending (Phase 6 CI) |
| V1 | Android's own Parental Controls profile shows as `type=profile.SUPERVISING` | Confirmed (the shell's format) | AOSP |
| V2 | A device owner can list and remove other users and profiles | Confirmed, with one exception | AOSP; Docs; Emulator pending (Phase 10 CI) |
| V4 | Telling the restrictions Belay set from everyone else's | Confirmed | AOSP; Docs |
| E2 | `pm create-user` on the CI emulators | Confirmed: up to 4 users on both images | AOSP (goldfish) |
| X1 | Tango (ya-webadb) runs adb over WebUSB in Chromium, from `localhost`; one program at a time holds the ADB interface | Confirmed; Windows' driver unverified | Docs; package source; the kit's tests; Pixel 8 pending |
| X2 | `adb install` is a streamed `package install`, and Tango's is the same | Confirmed | AOSP; package source |
| X3 | An APK's signing certificate, read without apksigner, as apksigner prints it | Confirmed | apksigner 37.0.0; the kit's tests |
| X4 | The SDK packages AGP 9.5.1 builds Belay with | Confirmed | AGP 9.5.1; Google's SDK repository |
| L1 | An adb-provisioned device owner grants itself location, background included; Android tells the kid | Confirmed | AOSP; Emulator pending (Phase 4 CI) |
| L2 | `setLocationEnabled` and `DISALLOW_CONFIG_LOCATION` for a device owner | Confirmed; Android posts its own notice when location goes on | AOSP; Docs; Emulator pending (Phase 4 CI) |
| L3 | "gps", "network" and "fused" with the platform API only | Partly: on a Pixel, "network" and "fused" are (expected to be) Play services | AOSP |
| L4 | Platform geofencing | Partly: it uses the fused provider; Belay computes places itself | AOSP |
| L5 | No `location` foreground service needed | Confirmed | AOSP; Docs |
| L6 | The kid sees when location is used | Confirmed for GPS-level requests (the status bar icon) | AOSP |
| L7 | Losing a granted permission stops and restarts the app | Confirmed: every runtime permission but notifications | AOSP; Emulator pending (Phase 4 CI) |
| L8 | `getCurrentLocation` with a 60-second timeout | **Contradicted**: Android caps one call at 30 s; Belay makes two | AOSP |
| L9 | A test can set a known GPS point on the emulator | Only with a mock provider; CI sets it with `adb emu geo fix` | AOSP (goldfish) |
| L10 | `setDeviceOwnerLockScreenInfo` for lost mode | Confirmed | AOSP; Docs |
| G1 | Calling and texting 911, 988 and a parent while every other app is suspended | Confirmed: ACTION_DIAL and ACTION_SENDTO to the default apps, which Belay never suspends | AOSP; Docs; Emulator pending (Phase 7 CI) |
| G2 | Android's own emergency information has an intent on Android 17 | Confirmed: `android.telephony.action.EMERGENCY_ASSISTANCE`, the emergency role's activity | AOSP |
| T1 | Belay as the default dialer (`setDefaultDialerApplication`) | Confirmed: requirements listed; does nothing without telephony | AOSP; Docs; Emulator pending (Phase 5 CI) |
| T2 | 911 works when Belay is the dialer | Confirmed: the preloaded dialer takes every emergency call | AOSP; Docs |
| T3 | Android treats 988 like 911 | **Contradicted**: 988 is an ordinary number to Android | AOSP |
| T4 | Call screening sees every incoming call | **Contradicted**: not withheld callers, and a screening app the kid picks replaces the dialer's | AOSP; Docs; Emulator pending (Phase 5 CI) |
| T5 | The dialer decides whether a call rings | Confirmed with `IN_CALL_SERVICE_RINGING`; Do Not Disturb's verdict needs `READ_CONTACTS` | AOSP; Docs; Emulator pending (Phase 5 CI) |
| T6 | Blocked numbers, and blocking after an emergency call | Confirmed: the default dialer may write the list; blocking pauses 2 h | AOSP; Docs; Emulator pending (Phase 5 CI) |
| T10 | Giving the dialer role back, without being killed | Confirmed: a dialer that stops qualifying is dropped; policy-fixed grants stay | AOSP; Emulator pending (Phase 5 CI) |
| T11 | Seeing a 911 or 988 call Belay's dialer didn't place | Partly: `NEW_OUTGOING_CALL` always; the call log for 988, for 911 only if the carrier allows | AOSP; Docs |
| T12 | Missed-call notifications for the calls Belay lets ring | Confirmed: Android posts them; a refused call isn't "missed" | AOSP |
| T13 | `isEmergencyNumber` without permissions | Confirmed; it throws while the phone process is down | AOSP |
| T14 | Denying `CALL_PHONE` to other apps leaves emergency calls working | Confirmed | AOSP; Emulator pending (Phase 5 CI) |
| T15 | CI: no preloaded dialer on ATD; the emulator console simulates incoming calls | Confirmed | AOSP; Docs; Emulator pending (Phase 5 CI) |
| T16 | Call audio routes and the SIM choice for an in-call app | Confirmed: the endpoint API from API 34 | AOSP; Pixel pending |

"Emulator" entries were seen in CI: `ci-emulator-test.sh` passed end to end on the API 37.0
Automated Test Device image (`aosp_atd`, required) from run 8, and on the API 37.0 Google
APIs image (`google_apis`, informational for now) in run 11 (2026-11-16). The job logs are
the record. The Google APIs image differed in three small ways: an account for a few
seconds after boot (P3), which detection layer reported an install first (K2), and
`BOOT_COMPLETED` arriving later, after the `DeviceAdminService` had already started Belay (P5).

From Phase 1 the same job runs end to end against a real Belay server on the runner
(docs/emulator.md). Run 14 (2026-11-17) on the Google APIs image: `provision.sh --server
--code` enrolled the phone, the server had its app list with the phone as OK, the 14
instrumented tests passed, and the server received the fixture app's install, update and
removal, each "noticed right away". The ATD image's enrollment failed on timing (E1);
with the retry, run 15 passed the same end-to-end path on the ATD image (required).

---

## Provisioning

### P1. Google blocks QR provisioning of unapproved device-owner apps

**Confirmed** for the Android Enterprise enrollment methods.

- support.google.com/work/android/answer/16694822 [no date]: "Only DPCs verified and
  approved by Android Enterprise are permitted to install apps during enterprise device
  enrollment provisioning." It excludes "Solutions developed exclusively for the purpose
  of device monitoring or eavesdropping independent of enterprise device management".
- developers.google.com/android/play-protect/warning-dev-guidance [2026-08-18]: "You can
  only provision new devices with Android Enterprise methods using an approved Device
  Policy Controller (DPC)."
- Neither page names QR, NFC, zero-touch or `afw#`, and neither mentions adb.
- Every report found is of 6-tap QR provisioning. The earliest community threads are from
  7 Dec 2025. Google's own TestDPC 9.0.12 was blocked from 19 Sep 2026
  (github.com/googlesamples/android-testdpc issue #283).
- Headwind MDM's open-source page says the same of custom builds: "currently blocked by
  Play Protect" at enrollment (h-mdm.com/open-source/).
- Approval goes through the Play Protect appeal form, with no response promised. Google's
  stated criteria include "The application is being used strictly for enterprise
  purposes", so a parental-control app shouldn't expect approval.

Belay's consequence: provision with adb. The QR path is tried once in Phase 0 (step 4),
only to record what happens.

### P2. `dpm set-device-owner` over adb works for an unapproved app

**Not stated by Google either way; works in practice.**

- No Google page mentions adb provisioning in the context of the block.
- In AOSP, `DevicePolicyManagerService.setDeviceOwner` never consults Play Protect. This
  is an inference from the code, not a promise.
- kidctl reports a release build provisioned this way on a Pixel 8 with Android 17,
  in daily use since October 2026 (its README).
- A developer reports adb `dpm set-device-owner` working after QR was blocked
  (Android Enterprise Community thread 1569, March 2026).
- Play Protect may still scan an adb install ("Verify apps over USB" in Developer options).
  Phase 0 step 1 records any prompt word for word.

**If the Pixel blocks this too, the plan changes** (Phase 0 stop condition).

### P3. Preconditions for `dpm set-device-owner`

**Confirmed**, from the Android 17 code (`DevicePolicyManagerService.checkDeviceOwnerProvisioningPreConditionLocked`):

- No device owner yet, and no profile owner on the user.
- Over adb, once setup is complete: no users beyond the system user, except users marked
  for testing (`nonTestNonPrecreatedUsersExist`, error `STATUS_NONSYSTEM_USER_EXISTS`).
  A guest, a work profile and Private Space all count.
- No accounts that aren't explicitly compatible with a device owner, of any type, on any
  user (error `STATUS_ACCOUNTS_NOT_EMPTY`).
- **New in Android 17**, behind the flag `secureAdbRoleBypassing`: a non-test-only app
  can't become device owner while a non-default Device Policy Management Role Holder is
  installed (`STATUS_NON_DEFAULT_DEVICE_POLICY_MANAGEMENT_ROLE_HOLDER_EXISTS`). On a stock
  Pixel, the role holder is Google's default one, so this shouldn't fire. Worth knowing if
  `dpm` ever refuses a release build for no visible reason.
- source.android.com/docs/devices/admin/testing-setup [2026-09-22] only says "Ensure the
  device does not contain any user accounts".

`provision.sh` checks the accounts (`dumpsys account`) and users (`pm list users`)
before trying, and names the problem.

Seen on the API 37.0 Google APIs emulator (CI run 3): `dpm set-device-owner` refused with
"Not allowed to set the device owner because there are already some accounts on the
device" seconds after `provision.sh` had counted none. The image has an account for a short
while after boot; 45 seconds later there was none. If this happens on a phone,
`provision.sh` now prints the account types and says what to do.

### P4. Removing the device owner

**Confirmed, with nuance.**

- `dpm remove-active-admin` calls `forceRemoveActiveAdmin`, which throws
  "Attempt to remove non-test admin" unless the admin is test-only
  (`forceRemoveActiveAdminUnchecked`).
- `DevicePolicyManager.clearDeviceOwnerApp` is deprecated since API 26 and "expected to be
  used for testing purposes only" [2026-09-16], but it still works on API 37 for any device
  owner, test-only or not: `DevicePolicyManagerService.clearDeviceOwner` only checks that the
  caller is the device owner. Belay only includes it in debug builds (`src/debug`).
- Both paths run `clearDeviceOwnerLocked`, which ends with
  `mDevicePolicyEngine.removePoliciesForAdmin(...)`. That drops every policy the admin set,
  including Belay's uninstall block on itself. So debug builds can block their own
  uninstall and still be removed by `unprovision.sh`.
- So for a release build, the only way out is a factory reset. Phase 2 adds a
  parent-controlled path (lifting `DISALLOW_FACTORY_RESET`); see ROADMAP.md.

### P5. What `dpm set-device-owner` does, in order

**Confirmed** in `DevicePolicyManagerServiceShellCommand.runSetDeviceOwner`:

1. `setActiveAdmin`. This sends `DEVICE_ADMIN_ENABLED` to the admin receiver, which can
   arrive before step 2 finishes. So Belay's `onEnabled` never assumes device ownership.
2. `setDeviceOwner`. On success the service sends `DEVICE_OWNER_CHANGED` with
   `FLAG_RECEIVER_INCLUDE_BACKGROUND`, so it reaches manifest receivers. It is a protected
   broadcast (`core/res/AndroidManifest.xml`), so only the system can send it.
3. `setUserProvisioningState(STATE_USER_SETUP_FINALIZED)`.

What actually starts Belay: on the API 37.0 emulator, Belay's heartbeat log after
`provision.sh` showed `DEVICE_ADMIN_ENABLED` (sent to the admin component directly) but no
`DEVICE_OWNER_CHANGED`. The likely reason: an app fresh from `adb install` is in the
*stopped state*, and implicit broadcasts skip stopped apps unless the sender adds
`FLAG_INCLUDE_STOPPED_PACKAGES`, which DevicePolicyManagerService doesn't. Right after that
broadcast, `setDeviceOwner` calls
`DeviceAdminServiceController.startServiceForAdmin(…, "set-device-owner")`, which binds
Belay's `DeviceAdminService` (B7) and so starts Belay without anyone opening it. The system
binds it again at every boot and user unlock. `provision.sh` also opens Belay. The
broadcast receivers stay, for a Belay that is already running when ownership changes.

`dpm list-owners` changed in Android 17 (`DeviceAdmins.printAllOwners`): it prints
**nothing** when there are no owners (older versions printed "no owners"), and one line
per owner, like `User 0: admin=family.brooker.belay/.AdminReceiver,DeviceOwner`. The
scripts look for `admin=`. Seen on the API 37.0 emulator in CI.

### P6. The Android 12+ provisioning activities

From the `DevicePolicyManager` reference and TestDPC: managed provisioning (QR, NFC,
zero-touch) asks the DPC's `GET_PROVISIONING_MODE` activity which mode to use, then starts
its `ADMIN_POLICY_COMPLIANCE` activity. Both must be protected by `BIND_DEVICE_ADMIN`.
`dpm` doesn't use them. Belay's return fully managed, or cancel when only a work profile
is offered. They exist so the QR test in Phase 0 step 4 is a fair one.

---

## Google accounts

### A1. Family Link child account next to a device owner

**Very likely incompatible; not confirmed by Google; not tested.**

- Family Link supervision has made Google Play services the profile owner of the
  supervised user. Developers have seen `com.google.android.gms/.kids.account.receiver.ProfileOwnerReceiver`
  refuse a device owner (Dhizuku issue #34, 2023), and the Zygotroller README shows
  `com.google.android.gms.supervision/…ProfileOwnerReceiver` as profile owner.
- Android 17 refuses a profile owner on a user that has a device owner:
  "Trying to set the profile owner…, but the user already has a device owner"
  (`DevicePolicyManagerService`, the profile-owner preconditions).
- On an Intune fully managed phone, Family Link hung at "Allowing supervision"
  (Microsoft Q&A 1855379, August 2024).
- Nuance: Android 17's `SupervisionService` mentions a transition to a `SYSTEM_SUPERVISION`
  role. Family Link may stop needing a profile owner, so this could change.

Belay's plan: a separate, parent-owned regular Google account (A2), not a child account.

### A2. A parent-owned regular Google account with Play on a fully managed phone

**Third-party sources only** (bayton.org's Android Enterprise FAQ; Cortado's support
site): on a fully managed device that allows accounts, users can add a personal Google
account and use the Play Store. kidctl uses a Google Workspace account this way. Phase 0
step 3 tests it on the Pixel.

### A3. The Android Management API is not for parental control

**Confirmed.** developers.google.com/android/management/permissible-usage [2026-03-30]:
the API is "restricted solely to commercial Enterprise Mobility Management (EMM)
developers…". Not allowed: "Solutions developed exclusively for the purpose of device or
user monitoring… independent of enterprise management." A parental-control developer was
told "Google does not see parental controls as a valid business case for amapi"
(Android Enterprise Community thread 1434, May 2026). So no managed Google Play either.

---

## Packages

### K1. Package broadcasts

**Confirmed.**

- developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions [2026-02-26]:
  the only exempt package broadcasts are `ACTION_PACKAGE_DATA_CLEARED` and
  `ACTION_PACKAGE_FULLY_REMOVED`. "Other package-related broadcasts (such as
  ACTION_PACKAGE_REPLACED) are *not* exempted."
- No device-owner exemption: AOSP delivery code (`BroadcastSkipPolicy`) has no owner check.
- Runtime receivers only get added/replaced/removed for packages they can see (package
  visibility applies).
- `MY_PACKAGE_REPLACED` (sent only to the replaced app) and `BOOT_COMPLETED` still reach
  manifest receivers.

Belay: a runtime receiver registered once per process (`PackageWatcher`), plus
`PACKAGE_FULLY_REMOVED` in the manifest. What keeps the process alive: B1 and B7.

### K2. `getChangedPackages` and `BOOT_COUNT`

**Confirmed.**

- PackageManager reference [2026-08-28]: "If no packages have been changed, returns null.
  The sequence number starts at 0 and is reset every boot." It points to
  `Settings.Global.BOOT_COUNT`.
- `BOOT_COUNT` is `@Readable` in AOSP: any app targeting 37 can read it without permission.
- AOSP: results are filtered by package visibility; packages that are already gone are
  still listed; enabling or disabling an app or component also advances the sequence; the
  tracker lives only in memory.

Belay stores the cursor as (`BOOT_COUNT`, sequence). A changed boot count means a full
scan (`Reconcile.plan` in `:core`, with tests). Removed packages and enable/disable
changes simply produce no diff when nothing changed.

Seen on the API 37.0 emulators: on the ATD image, installs, updates and removals were each
logged "by BROADCAST" within a second. On the slower Google APIs image, an install that
landed while Belay was still busy with its post-boot full scan (264 packages, 5.6 s) was
logged "by CHANGED_PACKAGES": the next queued step's `getChangedPackages` saw it before the
broadcast's step ran, which then found nothing new. The layers overlap as designed: no
miss, no duplicate.

### K3. `QUERY_ALL_PACKAGES`

**Confirmed: no device-owner exemption.**

- developer.android.com/training/package-visibility [2026-11-16]: "you can use the
  QUERY_ALL_PACKAGES permission. If you publish your app on Google Play, your app's use of
  this permission is subject to approval." The automatic-visibility page has no
  device-owner or admin category.
- AOSP's package filter (`AppsFilterBase`, `AppsFilterImpl`, `AppsFilterUtils`) has no
  device-owner or DPC code. The permission is a "normal" one.
- Play's policy (support.google.com/googleplay/android-developer/answer/10158779)
  only applies to apps on Play.

### K4. Install source

**Fields confirmed; per-case values from AOSP; Play's to measure on the Pixel.**

`getInstallSourceInfo` (API 30), `getPackageSource()` (API 33), `getUpdateOwnerPackageName()` (API 34).

| Case | initiating | installing | package source |
|---|---|---|---|
| `adb install` | `com.android.shell` ("adb installs can override the installingPackageName, but not the initiatingPackageName") | null, unless `-i` | OTHER ("Set package source to other by default") |
| Preinstalled, never updated | null | null | UNSPECIFIED |
| An APK opened from Files or a browser | the system package installer | same | DOWNLOADED_FILE with a referrer, else LOCAL_FILE |
| Play Store | `com.android.vending` (widely seen; undocumented) | same | to measure on the Pixel |

- The originating package needs `INSTALL_PACKAGES`, so Belay always sees null.
- The update owner is hidden on organization-managed devices, which includes ours.
- The mapping is `InstallSources.classify` in `:core`, with tests. Belay's screen shows
  the raw fields for itself, and the result for each change, so step 3 can check them.

---

## Staying alive

### B1. Foreground service started from the background, type `systemExempted`

**Confirmed. The docs get two details wrong.**

- …/fgs/restrictions-bg-start [2026-11-16]: exempt are "Apps with certain system roles or
  permission, such as device owners and profile owners". In AOSP
  `services/core/java/com/android/server/am/ActiveServices.java`, the while-in-use check
  returns `REASON_DEVICE_DPC` for the device owner, and the background-start check starts
  from that result.
- …/fgs/service-types [2026-11-16] lists a device owner among the apps that may use
  `systemExempted`. What the code checks (`core/java/android/app/ForegroundServiceTypePolicy.java`,
  `FGS_TYPE_POLICY_SYSTEM_EXEMPTED`, and `SystemExemptedFgsTypePermission` in
  `ActiveServices`): `FOREGROUND_SERVICE_SYSTEM_EXEMPTED`, plus an exact-alarm permission,
  the VPN app-op, or a reason such as device owner, profile owner or active device admin.
- Wrong in the docs: the failure is a `SecurityException` from `startForeground()`, not a
  `ForegroundServiceTypeNotAllowedException`. And if `startForeground()` never succeeds
  after `startForegroundService()`, the app crashes after about 30 s. So Belay only
  starts the service once it is device owner, and passes the type explicitly.
- Android lint only knows the exact-alarm route, so the manifest suppresses
  `ForegroundServicePermission` with a comment.
- No time limit: Android 15's limits only cover `dataSync` and `mediaProcessing`. The
  `BOOT_COMPLETED` restrictions on starting some types don't include `systemExempted`.
- `specialUse` would work too (kidctl uses it); once device owner, AOSP gives
  `systemExempted` no runtime advantage. `systemExempted` was the brief's choice.

### B2. The managed notice can't be dismissed

**Confirmed.**

- Android 14 behavior changes [2026-10-28]: the dismissible-ongoing change "doesn't apply
  to notifications in the following use cases: CallStyle notifications; Device policy
  controller (DPC) and supporting packages for enterprise; Media notifications…"
- AOSP `NotificationManagerService`: `FLAG_NO_DISMISS` is added when the notification has
  `FLAG_ONGOING_EVENT` and the app is the active device or profile owner.
- So the notice must be built with `setOngoing(true)` (it is). A plain device admin isn't
  exempt.
- Seen on the API 37.0 emulator: the posted notice has
  `flags=ONGOING_EVENT|NO_CLEAR|FOREGROUND_SERVICE|NO_DISMISS`. CI checks it on every run.

### B3. The notice can't be switched off

**Partly true: it locks only after the next boot.**

- `setPermissionGrantState(POST_NOTIFICATIONS, GRANTED)` marks the permission
  policy-fixed (packages/modules/Permission `PermissionControllerServiceImpl`).
- App-level switch: `PermissionHelper.setNotificationPermission` returns early for a
  fixed permission, so the kid can't actually turn notifications off. (Settings may briefly
  show the switch as off.)
- Channel-level: `PreferencesHelper.updateFixedImportance()` only runs during boot. Until
  the first boot after the grant, the channel can still be blocked in Settings; after it,
  Settings disables the app and channel switches, and the long-press "Turn off" is gone.
- Exceptions: a channel that is already blocked stays blocked; a channel marked
  `setBlockable(true)` stays blockable; before that boot, a channel group can be blocked.
  Belay's channel has no group and isn't blockable.
- A device owner permission policy other than `PROMPT` disables every app's notification
  switch (Settings `BlockPreferenceController`). Belay doesn't set one.

That's why `provision.sh` ends with a restart.

### B4. Standby bucket

**Confirmed.** AOSP
`apex/jobscheduler/service/java/com/android/server/usage/AppStandbyController.java`:
`if (isActiveDeviceAdmin(packageName, userId)) { return STANDBY_BUCKET_EXEMPTED; }`
(bucket 5). Packages in `setUserControlDisabledPackages` are exempted too. The appstandby
docs [2026-10-28] only say owners "are exempt from entering the restricted bucket". Check:
`adb shell am get-standby-bucket family.brooker.belay` prints 5. CI checks it.

### B5. Force stop and clear storage

**Confirmed, and enforced below the Settings UI.**

- Settings (`packages/apps/Settings`): `AppButtonsPreferenceController.updateForceStopButton`
  ("User can't force stop device admin"); `AppStorageSettings` disables Clear storage when
  the app has active admins, unless it declares `android:manageSpaceActivity` (Belay
  doesn't, and mustn't). Clear cache isn't blocked.
- ActivityManagerService ignores force-stop requests for protected packages; this also
  covers `cmd activity stop-app`. PackageManagerService refuses to clear their data.
  "Protected" includes the device owner.
- Quick Settings "Active apps" (SystemUI `FgsManagerController`) hides the Stop button for
  reasons including `DEVICE_DPC`. So Belay is listed there with no Stop button. kidctl
  measured a Stop button for *other* apps under `DISALLOW_APPS_CONTROL`, which AOSP doesn't
  predict; irrelevant to Belay itself, but worth re-measuring before Phase 2 relies on it.

### B6. Doze and the battery exemption

**Confirmed.**

- `DevicePolicyManager.java` source: "DPC apps themselves are not automatically exempted
  from Doze mode either." There is no device-owner API to add itself to the allowlist (the
  APIs need `DEVICE_POWER` or a role).
- `adb shell dumpsys deviceidle whitelist +<pkg>` writes `/data/system/deviceidle.xml`,
  read back at boot; the entry survives reboots and updates and is removed on uninstall.
  **But the file is written 5 seconds after the change** (`DeviceIdleController.writeConfigFileLocked`
  posts `MSG_WRITE_CONFIG` with a 5000 ms delay). Seen on the API 37.0 emulator:
  `provision.sh` restarted the phone about 2 seconds after the grant, and the exemption
  was gone after the boot. `provision.sh` now waits 8 seconds before its restart, checks
  again afterwards, and grants again if needed.
- `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (needs `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`)
  shows "Let app always run in background?"; Allow adds the same allowlist entry. It's the
  fallback: Belay's Setup checks show an Allow button if the exemption is missing.
- Settings' battery page shows a device owner as "Unrestricted" and greyed out even when it
  isn't allowlisted (SettingsLib `PowerAllowlistBackend.isDefaultActiveApp`). Check with
  `PowerManager.isIgnoringBatteryOptimizations()` (what Belay shows) or `dumpsys deviceidle`.
- A process with a running foreground service keeps network access during Doze
  (`NetworkPolicyManagerService`, `FOREGROUND_THRESHOLD_STATE`); alarms and jobs are still
  deferred. Phase 2's long-poll relies on this.

### B7. `DeviceAdminService`

**Confirmed.** DeviceAdminService reference [2026-09-16]: the system "tries to keep a bound
connection … so that the device/profile owner is always considered to be in the
foreground. This is useful to receive implicit broadcasts that can no longer be received
by manifest receivers." It is bound with `BIND_FOREGROUND_SERVICE` and re-bound if the
process dies. TestDPC registers its package receiver there. Belay has one
(`BelayAdminService`) in addition to the foreground service. CI checks it is bound.

- **A force stop that gets past B5 isn't undone for an hour.** `am instrument` force-stops
  its target when the tests start and again when they finish (AOSP 17
  `ActivityManagerService.startInstrumentation`, "start instr", and
  `finishInstrumentationLocked`, "finished inst"; `--no-restart` skips both). That call is
  internal, so the protected-package check in B5 doesn't apply. Belay's jobs and alarms go
  with it, and the dead DeviceAdminService binding is rebound only after a backoff
  (`DevicePolicyConstants`: 1 hour, doubling up to a day). Seen on the API 37.0 emulator:
  after the instrumented tests nothing ran Belay or its long-poll until it was opened, so
  `ci-emulator-test.sh` opens it. Only adb can do this on a real phone, which the
  debugging lock closes.

---

## Permissions and targetSdk 37

### R1. Usage access

**Confirmed.**

- `PACKAGE_USAGE_STATS` is "signature|privileged|development|appop|retailDemo";
  `setPermissionGrantState` only takes runtime ("dangerous") permissions, so a device owner
  can't grant it to itself. The UsageStatsManager reference [2026-08-28]: the user "still
  needs to grant permission through the Settings application."
- The user can revoke it in Settings > Special app access > Usage access. A device owner
  can't pin an app-op; the best is to notice (`AppOpsManager.startWatchingMode`) and tell
  the parent (Phase 3).
- `adb shell appops set <pkg> GET_USAGE_STATS allow` works; `provision.sh` does it and
  checks it.
- New in Android 17: "restricted settings" can grey out the Usage access switch for apps
  installed from a file. `appops set` bypasses that.

### R2. Pre-granting runtime permissions

**Confirmed.** DevicePolicyManager reference [2026-09-16]: a permission granted by policy
can't be managed by the user in the UI, and the lock covers "other permissions in the
affected group". Any runtime permission the app declares can be granted, sensor ones
included: AOSP sets `mAdminCanGrantSensorsPermissions = true` for a device owner set over
adb. Belay grants itself the runtime permissions it needs (`POST_NOTIFICATIONS` and
`ACCESS_LOCAL_NETWORK`); the whole Nearby devices group is then locked in Settings.
Device-owner apps are also never hibernated. CAMERA is the exception: Belay declares it
for the enrollment QR code but never grants it to itself (R5).

### R3. `ACCESS_LOCAL_NETWORK`

**Confirmed.** developer.android.com/privacy-and-security/local-network-permission [2026-11-03]:

- A runtime permission added in API 37, in the `NEARBY_DEVICES` group, enforced for apps
  targeting 37. It's "implemented deep in the networking stack", so it applies to OkHttp too.
  Blocked TCP times out; blocked UDP fails with EPERM; `.local` resolution is gated.
- Local means RFC 1918 ranges, 100.64/10, link-local, directly connected routes and
  multicast; it "excludes cellular (WWAN) or VPN connections"
  (…/local-network-definition [2026-03-06]). A public hostname that resolves to a home IP
  on Wi-Fi still counts as local.
- "IT administrators can pre-grant this permission using setPermissionGrantState()"
  (developer.android.com/work/versions/android-17 [2026-10-28]). Belay does.

### R4. Certificate Transparency

**Confirmed, with an exception.** Android 17 behavior changes [2026-11-11]: "If an app
targets Android 17 (API level 37) or higher, certificate transparency (CT) is enabled by
default." But "Certificate transparency verification isn't performed on connections that
use custom trust anchors" (…/security-config [2026-08-28]). Belay's plan stays a publicly
trusted certificate: claude.ai needs a public HTTPS URL for the server anyway, and it
keeps the agent's network config simple.

### R5. CAMERA, only for the enrollment QR code

**Confirmed** in AOSP 17 (not yet seen on a device). Belay uses the camera only to scan the
server's QR code, and only if the person scanning allows it; typing the code works without it.

- Grant states (`PermissionControllerServiceImpl`, packages/modules/Permission): DENIED
  sets the permission policy-fixed and revoked, without USER_FIXED, so going back to
  DEFAULT lets the system dialog appear again; DEFAULT only clears POLICY_FIXED.
- Revoking a granted runtime permission kills the app's uid (`PermissionService.kt`;
  notification permissions are the exception). So Belay can't deny the camera the moment
  enrollment succeeds without killing itself mid-flow.
- What Belay does (`enroll/CameraGate.kt`): DEFAULT just before scanning; DENIED again at
  the first agent step after the enrollment screen closes. If the camera had been allowed,
  Belay restarts once at that moment. CAMERA is left out of the self-grant (R2) and is
  listed in the health report.

### Other Android 17 changes that touch Belay

For apps targeting 37: Encrypted Client Hello; audio from the background needs a
foreground service with while-in-use capability; background activity starts through an
`IntentSender` are tightened (AOSP still exempts the device owner). For all apps on 17: a
memory limiter kills outlier processes. Nothing new for foreground services, package
broadcasts, package visibility or notifications.

---

## Developer verification

### D1. What applies, and when

**Partly as the brief says; some details matter.**

- Since 30 Sep 2026, enforced only for installs from seven participating app stores in
  Brazil, Indonesia, Singapore and Thailand. FAQ [2026-09-30]: "if users sideload your app
  directly, these new verification requirements won't apply to your app yet". In 2027 it
  widens to "all apps on certified Android devices" worldwide (guides [2026-08-18]).
- ADB is exempt: "you are free to install apps without verification with ADB". In AOSP 17
  that's a policy flag (`verification_service_adb`), not a platform guarantee.
- Registration: verify your identity, then register the package name and "the SHA-256
  certificate fingerprint" of the release key. A package that already has installs also
  needs a signed APK containing `assets/adi-registration.properties`.
- **Limited-distribution account** (support.google.com/android-developer-console/answer/17131204):
  free, no ID, but a Google account with 2-Step Verification, a payments profile and a
  contact email. Devices are registered one at a time (a code from the phone). "Any
  devices not authorized won't be able to install or receive updates". The device cap is
  20 or 50: Google's pages disagree.
- **"You can only register new package names that have never been seen before on
  Android."** Installing a release build on a Play-certified phone may let Google see the
  package (Play Protect scans installs). To keep the free path open, register
  `family.brooker.belay` before the release build goes on the Pixel. That's a decision for
  the parent; see docs/phase0-checklist.md, "Before you start".
- Updates a device owner installs itself (the later self-update) go through the verifier
  too: AOSP 17 has no device-owner bypass. Google says apps on fully managed devices are
  exempt; an Android Enterprise Community update says device-owner phones are exempt only
  "until September 2027". Whether an adb-provisioned, unapproved DPC counts isn't stated.
- kidctl measured: on a Pixel 8 with the package and key registered, its over-the-air
  updates installed with no Play Protect dialog.
- Other families can't share Belay's package name: each needs its own, with its own key
  (ROADMAP.md, "Later").

---

## Declarations

### M1. Declaring a monitoring tool

**Contradicted as written in the brief.** There is no `android:isMonitoringTool`
attribute: it's absent from the platform's `attrs_manifest.xml`, `public-final.xml` and
`android.R.attr` in both 37.0 and 37.2, so `aapt2` would reject it. Google Play's
declaration (support.google.com/googleplay/android-developer/answer/12955211) is a
meta-data entry:
`<meta-data android:name="isMonitoringTool" android:value="child_monitoring"/>`. The
allowed values are `child_monitoring`, `enterprise_management` and `other`
(`parental_control` isn't one). Play's example puts it under `<manifest>`, but Android only
reads `<meta-data>` inside `<application>` or a component, so Belay puts it in
`<application>`. Play's stalkerware policy also asks for "a persistent notification at all
times when the app is running" (answer/9888380). Belay has one.

### M2. The 37.2 unknown-sources restriction

**Confirmed; the name differs from the brief.** 37.2 adds
`UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_INCLUDING_REGISTERED_APP_STORES`
(`"no_install_unknown_sources_including_registered_app_stores"`). There is no
`…_GLOBALLY_INCLUDING_…`. From 37.2, `DISALLOW_INSTALL_UNKNOWN_SOURCES` and its
`_GLOBALLY` variant "do not apply to installations initiated or performed by registered app
stores" (apps holding `INSTALL_PACKAGES_AS_REGISTERED_APP_STORE`). The new key isn't in
37.0. Phase 2 gates it on `Build.VERSION.SDK_INT_FULL >= 3700002`. (Corrected in C4: for a
device owner, an unknown key is silently ignored; "Invalid restriction key" is only thrown to
permission-based callers.)

---

## Screen time (Phase 3)

### U1. Reading foreground time: `queryEvents`

**Confirmed.** Android 17 (API 37.0). Verified on: AOSP; Docs.

- UsageStatsManager reference [2026-08-28]: `queryEvents(long, long)` (API 21): "Events are only
  kept by the system for a few days"; `queryEvents(UsageEventsQuery)` (API 35) filters by event
  type and package. Both need usage access, and return nothing while the user is locked.
- In AOSP 17 the older `queryEvents(long, long)` is `@Deprecated` behind the flag
  `deprecate_old_query_events_api`: "Future Android versions may no longer support this API due to
  performance and memory concerns" (`core/java/android/app/usage/UsageStatsManager.java`). The
  reference page doesn't show the deprecation yet.
- Fresh: `services/usage/.../UserUsageStatsService.queryStats` reads older intervals from disk and
  appends the in-memory current interval, so an event is visible as soon as the system has
  recorded it. The 20-minute flush to disk (`UsageStatsService.FLUSH_INTERVAL`) doesn't delay it.
- Kept: `UsageStatsDatabase.prune` deletes daily files older than 10 days (weekly: 4 weeks,
  monthly: 6 months, yearly: 2 years).
- Without usage access, `UsageStatsService.hasQueryPermission` fails and the service returns
  null; the client turns that into an empty result. No exception (U4).

Belay's consequence: poll `queryEvents(UsageEventsQuery)` with a stored cursor, compute time in
`:core`, keep its own copy of recent intervals, and never read an empty result as "no use"
without checking usage access. To check on the emulator: a fixture app's `ACTIVITY_RESUMED`
appears within a second of `am start`.

### U2. Daily buckets aren't local days

**Contradicted.** Verified on: AOSP.

- `UserUsageStatsService.updateRolloverDeadline` schedules the next daily rollover 24 hours after
  the current daily bucket began (`UnixCalendar.addDays(1)`), not at local midnight.
- The reference [2026-08-28] warns that for `queryUsageStats` "the begin and end times of the time
  range may be expanded to the nearest whole interval period".

Belay's consequence: never use `INTERVAL_DAILY` buckets for "today". Compute days from events, in
the zone the policy names.

### U3. Usage observers aren't available to Belay

**Contradicted** for an app like Belay. Verified on: AOSP.

- `registerAppUsageObserver` and `registerUsageSessionObserver` are `@SystemApi` and `@hide`. The
  service would accept an active device owner (`UsageStatsService.hasObserverPermission`, with
  "TODO(b/169395065) Figure out if this flow makes sense in Device Owner mode"), but the client
  methods aren't in the SDK. Reaching them means reflection on non-SDK interfaces, which Belay
  doesn't do (developer.android.com/guide/app-compatibility/restrictions-non-sdk-interfaces
  [2026-10-28]).
- `registerAppUsageLimitObserver` needs `SUSPEND_APPS` (`signature|role|verifier`) and
  `OBSERVE_APP_USAGE` (`signature|privileged|role`), or the caller must be the active supervision
  app (`SupervisionManagerInternal.isActiveSupervisionApp`), a system-only role (V3).

Belay's consequence: Belay polls `queryEvents` and enforces its own limits.

### U4. The kid can turn usage access off, and back on

**Confirmed.** Verified on: AOSP.

- Settings (`packages/apps/Settings`, `applications/UsageAccessDetails.java`) enables the switch
  for any app that declares `PACKAGE_USAGE_STATS`. It only warns for a profile owner and has no
  device-owner check. The switch sets the app-op to IGNORED or ALLOWED, so the kid can also turn it
  back on there (Android 17's restricted-settings check can grey out turning it *on* for some
  installs: `checkEcmRestrictionAndSetDisabled`).
- R1 still holds: a device owner can't set the app-op itself; `appops set` over adb works.
- Queries then return nothing (U1).

Belay's consequence: watch it (`AppOpsManager.startWatchingMode`), report it, apply the family's
rule for "can't count", and show the kid how to turn it back on.

### U5. How usage events behave, for counting

**Confirmed in AOSP 17 source; not yet seen on a device.** Checked in `android-17.0.0_r1` while
writing `core/screentime` (UsageStatsService, UserUsageStatsService, UsageStatsDatabase):

- `queryEvents` returns events from `begin` (included) to `end` (not included).
- `UsageEvents.Event.getInstanceId()` is a system API, so an app can tell activities apart only by
  package and class name.
- A destroyed activity is recorded as stopped, and a pause that arrives after the stop still
  counts as the end of its use.
- Every boot records a shutdown event stamped with the last time the stats were saved (stale
  after a crash), then a startup event.
- Events queued while the phone is still locked after a boot are stamped at or after the startup.
- A change of the wall clock of more than 2 seconds shifts all of Android's stored usage history
  by the change (on by default), so Belay keeps its own ledger and re-sends recent days when it
  sees the clock move.

Belay's consequence: `core/screentime/ScreenTime.kt` counts from these rules, keyed by package and
class, keeps its own ledger instead of trusting the history, and treats a boot's shutdown time as
a guess. To check on the emulator: open and close a fixture activity, reboot, and change the clock
by an hour; the ledger's minutes match a stopwatch.

### On the phone (Phase 3's app wiring)

Read in AOSP `android-17.0.0_r1` (and the 37.0 `android.jar`) and on developer.android.com on
2026-11-17 while wiring `core/screentime` into the app. Paths are in `platform/frameworks/base`
unless another project is named. The emulator checks are in `ScreenTimeInstrumentedTest` and
`ci-emulator-test.sh`'s Phase 3 block; the Pixel's in [phase3-checklist.md](phase3-checklist.md).

### U6. What wakes screen time: screen on and off, unlocking, clock and zone changes

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 3 CI).

- `core/java/android/content/Intent.java`: `ACTION_SCREEN_ON` and `ACTION_SCREEN_OFF` "You cannot
  receive this through components declared in manifests, only by explicitly registering for it
  with Context.registerReceiver()". Both, and `ACTION_USER_PRESENT`, are protected broadcasts
  (`core/res/AndroidManifest.xml`).
- The implicit broadcast exceptions (developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions,
  no date shown) list `TIME_SET` and `ACTION_TIMEZONE_CHANGED` ("Clock apps might need to receive
  these broadcasts"); `USER_PRESENT` and the screen broadcasts aren't on it.

Belay's consequence: `screentime/ScreenWatcher.kt` registers for screen on, off and unlocked once
per process (BelayApp, like PackageWatcher; the DeviceAdminService binding keeps the process,
B7), and runs a step every 60 s while the screen is on and the policy has screen time. The clock
and zone changes go to a manifest receiver (`ClockChangedReceiver`).

### U7. Watching Belay's own usage access

**Confirmed.** Verified on: AOSP; Emulator pending (Phase 3 CI, `ScreenTimeInstrumentedTest`).

- `core/java/android/app/AppOpsManager.java` `startWatchingMode(String op, String packageName,
  OnOpChangedListener)`: "Monitor for changes to the operating mode for the given op in the given
  app package. You can watch op changes only for your UID." No permission is needed for one's own
  package.
- The listener is called from an `IAppOpsCallback.Stub`, so on a binder thread, not the main one.
- Settings' switch and `appops set` both set the package's mode (U4), which this reports.

Belay's consequence: the watcher runs a step at once (`USAGE_ACCESS_CHANGED`, which posts to the
agent thread), so "can't count" applies within a second, and the step reads usage access before
and after its query anyway.

### U8. `queryEvents(UsageEventsQuery)`, and where the keyguard events come from

**Confirmed.** Verified on: AOSP; SDK.

- `core/java/android/app/usage/UsageEventsQuery.java`: `Builder(beginTimeMillis, endTimeMillis)`
  throws `IllegalArgumentException("Invalid period")` when the end is before the begin;
  `setEventTypes` throws for a type outside `NONE..MAX_EVENT_TYPE`. Belay's reader skips an empty
  period and asks only for core's types.
- `UsageStatsManager.queryEvents(UsageEventsQuery)` is `@Nullable` and returns the empty result
  when the service gives none; the older `queryEvents(long, long)` is `@Deprecated` behind
  `FLAG_DEPRECATE_OLD_QUERY_EVENTS_API` (U1). Belay uses the new one from API 35 and the old one
  below it (its minSdk is 31).
- `KEYGUARD_SHOWN` and `KEYGUARD_HIDDEN` come from `ActivityManagerService.reportCurKeyguardUsageEvent`,
  which `ActivityTaskManagerService.setLockScreenShownLocked` posts whenever System UI reports the
  lock screen shown or gone. So dismissing a swipe lock screen (`wm dismiss-keyguard` in the
  tests) records `KEYGUARD_HIDDEN`, and the count starts.

### U9. Settings' usage access switch for Belay

**Confirmed in AOSP Settings; not documented.** Verified on: AOSP.

- `Settings.ACTION_USAGE_ACCESS_SETTINGS` documents "Input: Nothing" and "a matching Activity may
  not exist" (`core/java/android/provider/Settings.java`).
- `platform/packages/apps/Settings` `AndroidManifest.xml`: `Settings$AppUsageAccessSettingsActivity`
  takes the same action with `<data android:scheme="package"/>` and opens
  `applications.UsageAccessDetails`, the one app's switch.

Belay's consequence: "Turn usage access back on" asks for Belay's own page with its `package:`
address, and falls back to the list where nothing handles that (`screentime/UsageAccess.kt`).
Check the button on the Pixel.

### S5. `lockNow` and `<force-lock/>`, and what an update changes

**Confirmed; moved from the drafts with the flag's value and the update question.** Verified on:
AOSP; Emulator pending (Phase 3 CI).

- `services/devicepolicy/.../DevicePolicyManagerService.lockNow`: with the flag
  `lock_now_coexistence` the check is `mPermissions.enforce({MANAGE_DEVICE_POLICY_LOCK,
  LOCK_DEVICE}, USES_POLICY_FORCE_LOCK, …)`, and `PermissionChecker` gives a device owner
  `MANAGE_DEVICE_POLICY_LOCK` (`DEVICE_OWNER_PERMISSIONS`). Without the flag it's
  `DeviceAdmins.getActiveAdminOrCheckPermissionForCaller(caller, USES_POLICY_FORCE_LOCK, …,
  LOCK_DEVICE)`, which needs the admin's `usesPolicy(USES_POLICY_FORCE_LOCK)` and otherwise
  throws "Admin … did not specify uses-policy for: force-lock". Being device owner doesn't skip it
  (`isActiveAdminWithPolicyForUser`: `allowedToUsePolicy && admin.info.usesPolicy(reqPolicy)`).
- The flag (`core/java/android/app/admin/flags/flags.aconfig`) isn't set in `platform/build/release`'s
  `cp1a` (Android 17's first release, which inherits `bp4a` and earlier, none of which set it), so
  it's off unless switched on at run time (it isn't read-only there). `cp2a` sets it `ENABLED`,
  read-only; `trunk_staging` too. So the Pixel's Android 17 may need `<force-lock/>`, and the
  emulator's may.
- **An update doesn't refresh an admin's policies until the next boot.** On `PACKAGE_ADDED` with
  `EXTRA_REPLACING`, `handlePackagesChanged` only checks that the admin is still valid
  (`isActiveAdminPackageValid` parses a new `DeviceAdminInfo` and throws it away); the in-memory
  `ActiveAdmin.info` stays as it was. When the user's data is loaded again, at the next boot
  (`loadSettingsLocked` → `DevicePolicyData.load`), the info comes from the package's meta-data,
  and the stored `<policies>` overwrite it only for an admin that isn't the device or profile
  owner (`overwritePolicies = !dai.getComponent().equals(ownerComponent)`, b/123415062). So a
  provisioned Belay picks up `<force-lock/>` after its first restart with the new version: no
  re-provisioning. Until then (with the flag off) `lockNow` fails, and Belay reports it.
- `ActiveAdmin.dump` prints each admin's `policies:` (`force-lock` among them) in `adb shell
  dumpsys device_policy`; CI checks it.
- DPM reference [2026-09-16]: "If there's no lock type set, this method forces the device to go to
  sleep but doesn't lock the device." `lockNow` calls `goToSleep` and `IWindowManager.lockNow`.

Belay's consequence: `res/xml/device_admin.xml` declares `<force-lock/>`. A `lock_now` command or
a schedule with `lock` calls `lockNow` once (core's `Commands.plan`, `Upkeep.locks`); a refusal
is reported, for "force-lock" in plain words: "Android lets Belay lock the screen only after the
phone restarts once with this version of Belay." The family's Pixel, provisioned before Phase 3,
needs one restart after the update. The kid knows their own PIN, so it's a nudge.

### S6. Exact alarms for screen time's boundaries

**Confirmed; moved from the drafts.** Verified on: AOSP.

- `apex/jobscheduler/service/.../alarm/AlarmManagerService.isExemptFromExactAlarmPermissionNoLock`:
  System UI, core uids, no DeviceIdleController, or an app on the Doze allowlist
  (`isAppOnWhitelist`). There's no device-owner exemption. Without one of these, `USE_EXACT_ALARM`
  or `SCHEDULE_EXACT_ALARM`, `setExactAndAllowWhileIdle` throws `SecurityException` ("needs to hold
  SCHEDULE_EXACT_ALARM or USE_EXACT_ALARM to set exact alarms").
- An app on the user's power allowlist (`dumpsys deviceidle whitelist +`, B6) gets
  `FLAG_ALLOW_WHILE_IDLE_UNRESTRICTED`: no Doze limit on how often.
- `USE_EXACT_ALARM` is `normal` (`core/res/AndroidManifest.xml`, granted at install) and makes
  `canScheduleExactAlarms()` true by itself (`hasUseExactAlarmInternal`, for targetSdk 33 and up).
  Its holders "always stay in the WORKING_SET or lower standby bucket", but
  `AppStandbyController.getAppMinBucket` returns `STANDBY_BUCKET_EXEMPTED` for an active device
  admin before it looks at exact alarms, so Belay stays exempted (B4; CI checks bucket 5).

Belay's consequence: `PolicyTimer` sets one exact alarm, at the sooner of Phase 2's next change and
screen time's `Decision.nextAt` (a day starting, a schedule starting or ending, a limit running out
while its app is in front, a warning); Belay declares `USE_EXACT_ALARM` in case the allowlist
entry is ever lost. Play's limit on `USE_EXACT_ALARM` doesn't apply: Belay isn't on Play.

### S7. From a shell: is the screen off, or the lock screen up?

**Confirmed.** Verified on: AOSP. For `ci-emulator-test.sh`'s lock-now check.

- `services/core/.../power/PowerManagerService` dumps `  mWakefulness=` with
  `PowerManagerInternal.wakefulnessToString`: `Asleep`, `Awake`, `Dreaming` or `Dozing`.
- `services/core/.../wm/KeyguardController` dumps `  mKeyguardShowing=` (in `dumpsys window`).


---

## Emulator images

- Android 17 x86_64 images with 4 KB pages exist only for 37.0
  (`system-images;android-37.0;google_apis;x86_64` and `google_apis_playstore`); 37.1 and
  37.2 only come as `_ps16k` (16 KB pages). A Pixel 8 uses 4 KB pages, so CI uses 37.0.
- CI uses the Google APIs image (no Play Store, so no Play Protect prompts). The Play
  Store image is closer to the Pixel for Play Protect behavior.
- This sandbox has no `/dev/kvm`; the emulator runs only in CI (GitHub's Linux runners
  have KVM).

## Talking to the server (Phase 1)

### K5. Which apps have special access

**Confirmed** in AOSP 17 (`core/java/android/provider/Settings.java`,
`DevicePolicyManagerService`):

- `Settings.Secure.ENABLED_NOTIFICATION_LISTENERS` (`@hide`) and
  `ENABLED_ACCESSIBILITY_SERVICES` are marked `@Readable`: any app can read them, as
  colon-separated component names. Belay reads each once per scan to report
  "reads notifications" and "accessibility" per app.
- `DevicePolicyManager.getActiveAdmins()` needs no permission for the caller's own user:
  Belay reports "device admin" from it.

### N1. HTTPS only, with the system's CAs

**Confirmed** (developer.android.com/privacy-and-security/security-config [2026-08-28]; the
Android 17 behavior changes [2026-11-11]).

- The agent's network security config (`res/xml/network_security_config.xml`) allows no
  cleartext and trusts only the system's CAs: no user CAs, no pinning. OkHttp follows the
  config's cleartext rule on Android. Release builds also use OkHttp's `MODERN_TLS` only
  and follow no redirects.
- Debug builds replace the file (`src/debug/res/xml`) to allow plain http to `10.0.2.2`,
  the emulator's alias for the host computer's loopback, and `127.0.0.1`. CI's end-to-end
  test uses it to reach a server on the runner.
- Certificate Transparency: on by default for apps targeting 37 (R4). OkHttp uses the
  platform's TrustManager, so it should apply; **unproven** until a phone talks to a
  server with a non-CT certificate.

### N2. EmojiCompat and Google Play services

**Confirmed** in the androidx source (`emoji2/.../DefaultEmojiCompatConfig.java`,
androidx-main): "The default config will use downloadable fonts to fetch the emoji compat
font file", from a system `ContentProvider` with the `androidx.content.action.LOAD_EMOJI_FONT`
intent filter. On a Pixel that's Google Play services' font provider. Compose starts it
through `androidx.emoji2.text.EmojiCompatInitializer` (androidx.startup). Belay removes
that initializer in its manifest (`tools:node="remove"`), so it never asks Play services
for anything; the phone's own emoji font still renders.

### E1. Enrolling over adb

**Confirmed** in AOSP 17; seen in CI from Phase 1.

- `provision.sh --server --code` sends `am broadcast -a family.brooker.belay.ENROLL` to
  `EnrollReceiver`, which is exported but protected by `WRITE_SECURE_SETTINGS`
  (`signature|privileged|development|role|installer`). The shell package holds it;
  ordinary apps can't get it, except by `pm grant` over adb. So only someone with adb can
  enroll this way, and this path may replace an existing connection. (The idea is
  kidctl's; the code is Belay's.)
- `am broadcast` sends an ordered broadcast and waits, printing
  `Broadcast completed: result=…, data="…"` (`ActivityManagerShellCommand`). Belay answers
  `enrolled: "<name>" on <host>` or `failed: <problem>`, never the token.
- A background broadcast gets 60 s (`BROADCAST_BG_TIMEOUT`); enrolling allows itself 40.
- Right after a restart the phone may not be online for a few seconds. In CI run 14, the
  ATD image's enrollment 2 s after `provision.sh`'s restart failed with
  `ConnectException: Failed to connect to /10.0.2.2:8080`, while the Google APIs image's,
  2.5 s after boot, worked. `provision.sh` now tries again every 5 s for a minute while the
  server can't be reached; the code is only used once the server answers. In run 15 the
  ATD image needed one retry and enrolled about 6 s after boot.

## Enforcing (Phase 2)

All read in AOSP `android-17.0.0_r1` (and the 37.0 and 37.2 `android.jar`), the
DevicePolicyManager [2026-09-16], UserManager [2026-08-28] and Doze [2026-10-22] reference
pages, and Chromium's policy definitions, on 2026-11-17. Emulator checks run in Phase 2 CI;
the rest needs the Pixel ([phase2-checklist.md](phase2-checklist.md)).

### C1. Suspending apps

**Confirmed.** `setPackagesSuspended`: the policy engine keeps each admin's set, and
PackageManager attributes the suspension to "android". Android refuses to suspend device
admins, the active launcher, the required installer, uninstaller and verifier, the default
dialer, the permission controller, protected and required system packages, libraries, apps
with `OP_SYSTEM_EXEMPT_FROM_SUSPENSION`, and DevicePolicyManager's `policy_exempt_apps`. A
suspended app's activities stop and can't start, its notifications are hidden, and it can't
show toasts or dialogs or play audio, so a suspended clock can't ring: Belay leaves the clock
out of a pause. Its process keeps running. From a shell, the `User 0: … suspended=…` line of
`dumpsys package <pkg>`.

### C2. What a suspended app shows

**Confirmed in AOSP; check the title on the Pixel.** The launch is intercepted and Settings'
`ActionDisabledByAdminDialog` opens. On a fully managed phone its title is "Blocked by work
policy" and its text is the device owner's short support message (otherwise "For more info,
contact your IT admin"). Belay sets that message to "Your parent manages this phone with
Belay…", or the parent's own words. `getSuspendPackagesTitle` ("Can't open this app") exists,
but no AOSP 17 controller calls it. With Android's own supervision on, the dialog shows "Ask
for help" instead. Belay's own notification names the waiting app.

### C3. Hiding apps

**Confirmed.** `setApplicationHidden(true)` kills the app and sends `PACKAGE_REMOVED` (not
`FULLY_REMOVED`); showing it again sends `PACKAGE_ADDED`. A hidden app is invisible to
queries without `MATCH_UNINSTALLED_PACKAGES`, keeps `FLAG_INSTALLED`, and still matches intent
queries with that flag. Belay reads its inventory with that flag, so blocked apps stay
present (no "removed" or "installed" events). The policy engine only acts when its stored
value changes, so after a reinstall Belay sets "not hidden" and then "hidden" again.
`pm list packages <pkg>` leaves a hidden app out; `-u` lists it.

### C4. User restrictions

**Confirmed; corrects M2.**

- API levels: `DISALLOW_CONFIG_DEFAULT_APPS` 34, `DISALLOW_SIM_GLOBALLY` 35,
  `…_INCLUDING_REGISTERED_APP_STORES` 37.2; every other one Belay uses is at or below its
  minSdk 31. `setAutoTimePolicy` exists from 36.
- For a device owner, an unknown key is silently ignored.
- `DISALLOW_DEBUGGING_FEATURES` turns `ADB_ENABLED` and `ADB_WIFI_ENABLED` off.
- `DISALLOW_ADD_USER` is a base restriction only after full managed provisioning, not after
  `dpm set-device-owner`, so Belay sets it itself.
- **`DISALLOW_SIM_GLOBALLY` only blocks downloading eSIMs.** A physical SIM swap isn't
  blocked; Belay reports a changed SIM instead (opaque ids, never the number).
- `UserManager` declares 85 restriction keys (`DISALLOW_`, `ENSURE_` and `ALLOW_` constants,
  hidden ones included; 73 in the public API 37 stubs), in
  `core/java/android/os/UserManager.java`. The server knows them all
  (`server/src/family/android.ts`), so a key the phone reports in
  `health.foreign_restrictions` that isn't one of them reaches an AI only as untrusted text.

### C5. The unknown-sources restrictions and adb

**Confirmed for 37.0.** Creating an install session only checks `DISALLOW_INSTALL_APPS`, and
the shell holds `INSTALL_PACKAGES`, so the unknown-sources check is never reached: `adb install`
and `provision.sh` keep working. **37.2's `…_INCLUDING_REGISTERED_APP_STORES` is unverified:**
its documentation says only privileged installers "explicitly allowed as trusted sources" may
install, and 37.2's source isn't published. Test `provision.sh`'s update on the Pixel.

### C6. Private DNS

**Confirmed.** `setGlobalPrivateDnsModeSpecifiedHost` is device owner only. Android checks the
host over TLS (port 853) **inside the caller's process**, with no connect timeout, so Belay
calls it on its own thread with its own timeout. It answers "host not serving" whenever the
phone is offline (Belay tries again later and doesn't report it while offline), and throws
`SecurityException` while any other user or profile exists (C11). Afterwards the whole phone
looks names up at that host.

### C7. Chrome's managed configuration

**Names and types confirmed** (Chromium's policy definitions and `PolicyConverter.java`), all
supported on Android: `IncognitoModeAvailability` int, `ForceGoogleSafeSearch` bool,
`ForceYouTubeRestrict` int, `SafeSitesFilterBehavior` int (Chrome 116+), `DownloadRestrictions`
int (3 blocks all; Chrome 131+), `URLBlocklist` and `URLAllowlist` as `String[]`,
`DnsOverHttpsMode` string. An empty bundle clears Belay's settings. Whether Chrome applies them
without managed Google Play is checked on the Pixel.

### C8. Factory reset protection

**Confirmed in AOSP; release builds only.** `setFactoryResetProtectionPolicy` notifies the
reset-protection agent itself; without one (emulators) it throws
`UnsupportedOperationException`. Belay also sends `FRP_CONFIG_CHANGED` to Play services, as
Google's guide says. Reset protection doesn't apply while OEM unlocking is on, and Belay can't
read that state.

### C9. Network in Doze, and exact alarms

**Confirmed in AOSP.** A process at or above bound-foreground-service state keeps network
access in Doze, so Belay's long-poll works while the phone idles (the Doze page doesn't list
this exception). Apps on the battery allowlist may set exact alarms without
`SCHEDULE_EXACT_ALARM`, which Belay uses for when a pause or maintenance ends.

### C10. What Belay reads without permissions

**Confirmed.** The default and system dialer, the default SMS app, the browsers (by the browser
role's own test), the current keyboard (`DEFAULT_INPUT_METHOD` is `@Readable`), and the SIM's
state, carrier id and default subscription id. Reading the emergency role holder needs a
privileged permission, so Belay finds emergency apps by resolving `EMERGENCY_ASSISTANCE` among
system apps. These make up the never-blocked list, with the keyboard that came with the phone
(texting 988 needs one).

### C11. Android's own Parental Controls profile

**Detectable, not identifiable.** The supervising profile's type and `SupervisionManager` are
system APIs. `getSecondaryUsers` counts it with any other user, and `onUserAdded` /
`onUserRemoved` tell Belay when one appears. Belay reports "another user or profile" plainly,
re-applies its suspensions (which the profile's app rules can lift), and doesn't remove it:
public APIs can't tell it apart from another user ([design](design/phase10-android-parental-controls.md)).
From Phase 10 a parent can ask Belay to remove it (V2).

## Updating Belay, other users (Phases 6 and 10)

All read in AOSP `android-17.0.0_r1` on 2026-11-17 (`platform/frameworks/base` unless named;
`device/generic/goldfish` for the emulator). Moved here from
[the drafts](design/platform-notes-drafts.md) as they were checked again (I2, I3, V1, V2), with
new entries. The emulator checks run in CI (`SelfUpdateInstrumentedTest`,
`OtherUsersInstrumentedTest`, `ci-emulator-test.sh`); the Pixel's in
[phase6-checklist.md](phase6-checklist.md).

### I2. Silent installs by the device owner

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 6 CI).

- `services/core/.../pm/PackageInstallerSession.computeUserActionRequirement`: "Device owners and
  affiliated profile owners are allowed to silently install packages": when
  `isInstallerDeviceOwnerOrAffiliatedProfileOwner()` (DevicePolicyManagerInternal
  `canSilentlyInstallPackage`: the default device owner, on a user affiliated with the device;
  the system user always is, `DeviceAdmins.isUserAffiliatedWithDeviceLocked`), no user action is
  needed unless the session forces one. `REQUEST_INSTALL_PACKAGES` is read only for metrics, so
  Belay doesn't declare it.
- Downgrades: `PackageInstallerService.createSessionInternal` sets `INSTALL_ALLOW_DOWNGRADE` only
  for debuggable Android builds or system and root callers, and
  `PackageManagerServiceUtils.isDowngradePermitted` also needs `INSTALL_REQUEST_DOWNGRADE`, which
  an app's session can't ask for. A phone's user build refuses an older Belay. Belay's own check
  refuses anything not newer anyway (core's `AgentUpdates.check`).
- The answer: `sendOnPackageInstalled` fills `EXTRA_STATUS` and `EXTRA_STATUS_MESSAGE`
  (`PackageManager.installStatusToString`: "INSTALL_FAILED_…: <detail>") into the session's
  IntentSender, so its PendingIntent must be mutable (Belay's is explicit, to its own receiver).
  For a device owner's success it posts "Updated by your admin.\nGo to settings to view granted
  permissions" (`core/res` `package_updated_device_owner`).
- Belay's session: `MODE_FULL_INSTALL`, `setRequireUserAction(USER_ACTION_NOT_REQUIRED)`,
  `setInstallReason(INSTALL_REASON_POLICY)`, `setAppPackageName`, `setSize`, as the
  PackageInstaller.SessionParams reference [2026-08-03] describes them (the same words as the
  AOSP 17 javadoc). On a `STATUS_PENDING_USER_ACTION` (never for a device owner) Belay abandons
  the session rather than ask the kid.

### I3. Developer verification and the device owner's own installs

**No device-owner bypass in AOSP 17; Google's wording doesn't settle Belay's case.** Verified on:
AOSP (re-checked); Docs (as quoted in the drafts, 2026-11-17).

- `PackageInstallerSession.shouldUseVerificationService`: verification applies when the service
  is enabled and the system names a verifier package; the only exemption in the platform is adb
  installs while the flag `verification_service_adb` is off. Nothing for a device owner. The
  AOSP emulator images name no verifier, so CI can't see it.
- Google's FAQ, as the drafts quote it: "Apps distributed through your organization store, on
  managed devices, won't need to complete the verification requirements", and "Unregistered apps
  can only be installed or updated when the advanced flow is enabled or by using ADB." Whether an
  adb-provisioned Belay counts as "your organization store" isn't stated.

Belay's consequence: a refusal is reported word for word (I2's status message) and tried again
after a wait (a verifier's block isn't final); the way out is `provision.sh` over adb in
maintenance mode. Measure on the Pixel ([phase6-checklist.md](phase6-checklist.md) §2).

### I5. Only the shell can install a test-only APK

**Confirmed.** Verified on: AOSP.

- `PackageInstallerService.createSessionInternal`: for any caller but the shell and root,
  `INSTALL_ALLOW_TEST` is cleared unless the caller holds `INSTALL_TEST_ONLY_PACKAGE`, which is
  `signature` (`core/res/AndroidManifest.xml`: only the platform's own apps).
  `SessionParams.setInstallFlagAllowTest` is a hidden `@TestApi`.
- `InstallPackageHelper` then refuses a test-only package without that flag:
  `INSTALL_FAILED_TEST_ONLY`, "Failed to install test-only apk. Did you forget to add -t?",
  which `installStatusToPublicStatus` makes `STATUS_FAILURE_INVALID`.

Belay's consequence: debug builds are test-only (so `unprovision.sh` can release them), so a
debug Belay can't install another debug Belay; it reports Android's words and doesn't try that
file again. CI's update is a second debug build that isn't test-only (`-PbelayTestOnly=false`),
and afterwards CI puts the test-only build back with `adb install -t -d`:
`isDowngradePermitted` allows a requested downgrade over a debuggable app.

### I6. What Belay reads from an APK before installing it

**Confirmed.** Verified on: AOSP.

- `core/java/android/content/pm/PackageManager.getPackageArchiveInfo(path, PackageInfoFlags)`:
  with `GET_SIGNING_CERTIFICATES` (or `GET_SIGNATURES`) it parses with
  `PARSE_COLLECT_CERTIFICATES`, which collects and verifies the APK's signatures; on any parse
  failure it returns null.
- `SigningInfo` (`core/java/android/content/pm/SigningInfo.java`): `getApkContentsSigners` is the
  set that signs the APK now, without past certificates; `getSigningCertificateHistory` adds a
  rotated key's past certificates (current last), and is null with several signers.
- `Signature.toByteArray()` is the certificate's encoding; its SHA-256 is what `apksigner verify
  --print-certs` prints as "certificate SHA-256 digest" (CI compares them when it can).

Belay's consequence: Belay pins exactly the set from `getApkContentsSigners`, its own and the
APK's, and reports its own as `agent_signing_sha256`. A rotated key is refused; that update goes
over adb in maintenance mode.

### I7. An update kills Belay, and `MY_PACKAGE_REPLACED` starts the new one

**Confirmed.** Verified on: AOSP; Emulator pending (Phase 6 CI).

- `PackageInstaller.SessionParams.setDontKillApp` only applies to `MODE_INHERIT_EXISTING`
  sessions that add splits: "By default, all installs will result in the package's running
  processes being killed before the install completes."
- `services/core/.../pm/BroadcastHelper` sends `ACTION_MY_PACKAGE_REPLACED` to the updated
  package itself after every update, as it does after `adb install -r`.

Belay's consequence: Belay records "installing" before it commits, and the new Belay (started by
`MY_PACKAGE_REPLACED`, the agent's `AGENT_UPDATED` step) sees by its version code that it's
done. The session's answer may reach the new Belay, or nobody; ten minutes without one is a
failure, tried again later.

### V1. Android's Parental Controls on a Belay phone

**Confirmed for the shell's view; Settings' part from the drafts.** Verified on: AOSP.

- `services/core/.../pm/UserManagerServiceShellCommand.runList`: `cmd user list -v` prints one
  line per user, `<n>: id=<id>, name=<name>, type=<type>, flags=…`, where the type is the user
  type without its `android.os.usertype.` prefix. `UserManager.USER_TYPE_PROFILE_SUPERVISING` is
  `android.os.usertype.profile.SUPERVISING`, so the supervising profile shows as
  `type=profile.SUPERVISING`. `pm list users` is the same listing without `-v`, so the profile
  also counts there.
- From the drafts, not re-checked: Settings creates the profile with
  `createProfileForUserEvenWhenDisallowed`, so `DISALLOW_ADD_USER` doesn't stop it; with no
  supervision role holder, `SupervisionService` sets `DISALLOW_FACTORY_RESET` as its own system
  entity (which Belay reports as a foreign restriction, V4).

Belay's consequence: `provision.sh` stops with "Android's own Parental Controls are set up on
this phone. Turn them off in Settings > Parental controls, then run this again." The entry's
name on the Pixel is to check ([phase6-checklist.md](phase6-checklist.md) §5).

### V2. Other users or profiles on a device-owner phone

**Confirmed, with one exception.** Verified on: AOSP; Docs; Emulator pending (Phase 10 CI).

- DevicePolicyManager reference [2026-09-16]: `getSecondaryUsers` "Called by a device owner to
  list all secondary users on the device. Managed profiles are not considered as secondary
  users"; `removeUser` "Called by a device owner to remove a user/profile and all associated
  data", returning "true if the user was removed, false otherwise".
- `services/devicepolicy/.../DevicePolicyManagerService.getSecondaryUsers` (device owner only):
  every alive user but the system user and managed profiles, so a supervising profile, a guest,
  a clone or a private profile is listed.
- `removeUser` (device owner only; `checkCanExecuteOrThrowUnsafe`, which only matters where
  removing users can be unsafe, like cars): it returns false, without removing, when
  `DISALLOW_REMOVE_USER` (or `…_MANAGED_PROFILE`) was set by someone other than the device owner
  (`isAdminAffectedByRestriction`); otherwise `UserManagerService.removeUserEvenWhenDisallowed`.
  That marks the user partial and disabled at once and stops it, so the next
  `getSecondaryUsers` no longer lists it (`getAliveUsers`).
- `DeviceAdmins.areAllUsersAffiliatedWithDevice` still fails while one exists: Private DNS
  changes and network logs refuse (C6, W2 in the drafts).

Belay's consequence: `health.other_users` is that count, and `remove_other_users` removes each
and is done only when none is left; otherwise the parent sees why ("Something other than Belay
may stop users from being removed").

### V4. Telling the restrictions Belay set from everyone else's

**Confirmed.** Verified on: AOSP; Docs.

- DevicePolicyManager reference [2026-09-16], `getUserRestrictions(admin)`: "Called by an admin
  to get user restrictions set by themselves … The target user may have more restrictions set by
  the system or other admin. To get all the user restrictions currently set, use
  UserManager.getUserRestrictions()."
- `UserManager.getUserRestrictions()` (`UserManagerService.getEffectiveUserRestrictions`): the
  base restrictions merged with every admin's global and local ones, system entities such as
  Android's supervision included.
- `DevicePolicyManager.getUserRestrictions(admin)`, for a device owner: what that admin set,
  local and global, from the policy engine (`getUserRestrictionsFromPolicyEngine`).
- A device owner gets no default restrictions in AOSP 17: `maybeSetDefaultRestrictionsForAdminLocked`
  only runs for managed profiles (`DISALLOW_BLUETOOTH_SHARING`, `DISALLOW_DEBUGGING_FEATURES`).

Belay's consequence: `health.foreign_restrictions` is the first less the second, so a restriction
Belay itself set (via the engine) never shows as foreign; if Belay can't read its own, it reports
none.

### E2. `pm create-user` on the CI emulators

**Confirmed.** Verified on: AOSP (`device/generic/goldfish`).

- `phone/overlay/frameworks/base/core/res/res/values/config.xml` sets
  `config_multiuserMaximumUsers` to 4 (the framework's default is 1), and the ATD image's product
  (`sdk_slim_x86_64`, `product/slim_handheld.mk`) uses the same overlay.
- `pm create-user <name>` (`PackageManagerShellCommand.runCreateUser`) makes a full secondary user
  and prints "Success: created user id <id>"; `UserManagerService.createUserInternal` refuses it
  while `DISALLOW_ADD_USER` holds for the calling user.

Belay's consequence: `OtherUsersInstrumentedTest` (emulators only) turns Belay's add-user lock off
in its own test policy, makes a user, and has `remove_other_users` remove it.

## Setting up without the Android SDK (Phase 8)

Checked on 2026-11-17 for the setup kit ([setup-kit.md](setup-kit.md)). X1 was drafted in
[the drafts](design/platform-notes-drafts.md) and re-checked here. "The kit's tests" are
`setup-kit/test`: the plan's fixtures through Tango's adb-server client and a fake adb server,
and the APK reader against apksigner.

### X1. adb over WebUSB: Tango (ya-webadb)

**Confirmed; the Windows driver is unverified.** Verified on: Docs; package source; the kit's
tests (Tango's adb-server client); headless Chromium (the page loads, with `navigator.usb`);
Pixel 8 pending.

- npm registry: `@yume-chan/adb` 2.6.4, `@yume-chan/adb-daemon-webusb` 2.3.2,
  `@yume-chan/adb-credential-web` 2.1.0, `@yume-chan/adb-server-node-tcp` 2.5.2,
  `@yume-chan/android-bin` 2.1.0, `@yume-chan/stream-extra` 2.6.1 (with `struct` 2.3.2, `event`
  2.0.0, `no-data-view` 2.0.0 and `async` 4.2.2); MIT; github.com/yume-chan/ya-webadb, last
  published 2026-11-06. The kit pins these exactly.
- tangoadb.dev/tango/daemon/usb/ (version 2.6.2, last updated 29 Aug 2025): "Chromium-based
  browsers support WebUSB natively." "If Google ADB has already claimed the ADB interface, WebUSB
  API in Chrome or `usb` package can't claim it again." "Windows doesn't allow opening multiple
  handles to the same interface at all." The page doesn't mention WinUSB or Google's USB driver.
- tangoadb.dev/tango/server/ (2.6.2): in Node, Tango "connects to Google ADB Server using TCP
  sockets"; "Google ADB server must already be running".
- MDN, WebUSB API [12 Jul 2025]: "available only in secure contexts (HTTPS)". MDN, Secure
  contexts [14 Sep 2026]: `http://localhost` and hosts in 127.0.0.0/8 are potentially trustworthy,
  so `http://localhost:8090` is a secure context. Headless Chromium (Playwright's build 1243)
  reported `isSecureContext` and `navigator.usb` for the kit's page there.
- In `@yume-chan/adb` 2.6.4: a shell command is the service `shell,v2,raw:<words joined by
  spaces>` when the device has `shell_v2` (output, errors and exit status come back separately),
  else `exec:` (output only); `power.reboot()` is `reboot:`; the server client switches to a phone
  with `host:tport:serial:<serial>` and waits with `wait-for-any-device`. The words are joined by
  spaces, as adb's own client joins `adb shell`'s arguments, so quoting reaches the phone's shell
  the same way.
- developer.android.com/studio/run/win-usb (no date shown): "The Google USB Driver is required to
  perform adb debugging on Windows with Google devices." It doesn't say which Windows driver that
  binds the ADB interface to, or whether WebUSB (which needs WinUSB on Windows) can open a Pixel 8
  without it.

Belay's consequence: the kit's page runs in Chromium browsers only, from `localhost`, and tells
the parent to stop adb first. To check by hand: a factory-fresh Pixel 8 with Chrome on Linux (with
the udev rule), macOS and Windows (with and without Google's driver), including the restart.

### X2. `adb install` is a streamed `package install`

**Confirmed.** Verified on: AOSP; package source.

- `packages/modules/adb/client/adb_install.cpp` (`install_app_streamed`): adb prints "Performing
  Streamed Install", sends `package install <options> -S <size>` over `abb_exec` (or
  `exec:cmd package install …` without it), streams the APK, and reads one status line; anything
  but "Success" becomes "failed to install <file>: <status>", which adb prints after "adb: ".
- `@yume-chan/android-bin` 2.1.0 (`PackageManager.installStream`) sends
  `abb_exec:package install <options> -r -S <size>` (or `cmd package install …`), streams the APK,
  and throws the status line when it isn't "Success".

Belay's consequence: the kit installs through the same `package` shell command as `adb install`,
so restricted permissions are allowlisted the same way (I4). The runners print the same, but for
adb's two additions around the status line.

### X3. An APK's signing certificate, read without apksigner

**Confirmed.** Verified on: apksigner 37.0.0; the kit's tests.

- source.android.com/docs/security/features/apksigning/v2 and v3: the APK Signing Block sits right
  before the ZIP central directory; its v2 (`0x7109871a`), v3 (`0xf05368c0`) and v3.1
  (`0x1b93ad61`) blocks list signers, each with signed data whose second part is the
  certificates, X.509 DER.
- apksigner 37.0.0 `verify --print-certs` prints "V3.0 Signer: certificate DN: …" or "V2 Signer:
  …" (lib.sh reads both forms) and the certificate's SHA-256, lowercase hex. The DN lists the
  subject's parts in the reverse of their order in the certificate (Java's `X500Name`): Belay's
  debug build, signed with AGP's debug key, prints "C=US, O=Android, CN=Android Debug", and a key
  made with `keytool -dname "CN=Android Debug,O=Android,C=US"` prints "CN=Android Debug,
  O=Android, C=US". The kit's reader gave the same SHA-256 and DN for both, and for made-up v2
  and v3 APKs.
- apksigner also verifies the signature; the kit's reader doesn't. Android verifies it when it
  installs.

Belay's consequence: the kit's page shows the certificate SHA-256 that `make-release-key.sh` and
`build-release.sh` print, and the plan's debug-key check ("CN=Android Debug") works with either
order.

### X4. The SDK packages AGP 9.5.1 builds Belay with

**Confirmed.** Verified on: AGP 9.5.1; Google's SDK repository (`repository2-3.xml`, read
2026-11-17).

- AGP 9.5.1's `com.android.builder.core.ToolsRevisionUtils`: `DEFAULT_BUILD_TOOLS_REVISION` is
  `MIN_BUILD_TOOLS_REV`, 36.0.0. `compileSdk = 37` needs `platforms;android-37.0`, now revision 2
  (`platform-37.0_r02.zip`).
- `cmdline-tools;22.0` is `commandlinetools-linux-15859902_latest.zip`, SHA-256
  `4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583` as
  developer.android.com/studio lists it; the download matched it and the repository's SHA-1.

Belay's consequence: the kit's image installs exactly `platforms;android-37.0` (revision 2) and
`build-tools;36.0.0`, and stops if Google ships another revision, until it's pinned again.

---

## Location and the kid's side (Phases 4 and 7)

All read in AOSP `android-17.0.0_r1` on 2026-11-17 (`platform/frameworks/base` unless named; the
PermissionController is `packages/modules/Permission`), and in the 37.0 `android.jar`. L1 to L6
moved here from [the drafts](design/platform-notes-drafts.md), checked again where Belay now
relies on them; the rest are new. The emulator checks run in CI (`LocationInstrumentedTest`,
`KidSideInstrumentedTest` and `ci-emulator-test.sh`'s Phase 4 and 7 block); the Pixel's in
[phase4-checklist.md](phase4-checklist.md) and [phase7-checklist.md](phase7-checklist.md).

### L1. Location, granted by policy

**Confirmed.** Verified on: AOSP; Emulator pending (Phase 4 CI).

- `services/devicepolicy/.../DevicePolicyManagerService.setDeviceOwner`: `if (isAdb(caller)) {
  activeAdmin.mAdminCanGrantSensorsPermissions = true; mPolicyCache.setAdminCanGrantSensorsPermissions(true); … }`.
  `setPermissionGrantState` refuses to grant a `SENSOR_PERMISSIONS` member without it (by default
  it answers as if it worked, `callback.sendResult(Bundle.EMPTY)`, unless the change
  `THROW_SECURITY_EXCEPTION_FOR_SENSOR_PERMISSIONS` is on for the caller).
- `PermissionController/.../utils/v31/AdminRestrictedPermissionsUtils`: `ACCESS_FINE_LOCATION`,
  `ACCESS_BACKGROUND_LOCATION` and `ACCESS_COARSE_LOCATION` are admin-restricted sensor
  permissions, which an admin may grant only with `canAdminGrantSensorsPermissions`.
- `PermissionControllerServiceImpl.onSetRuntimePermissionGrantStateByDeviceAdmin` expands split
  permissions, and per permission: GRANTED sets it policy-fixed and grants it (or, when the admin
  may not grant it, only clears policy-fixed); DENIED sets it policy-fixed and revokes it.
  `AutoGrantPermissionsNotifier` (only for the three location permissions) then posts, in the
  PermissionController's own words, "%1$s has location access" and "Your organization allows %1$s
  to access your location" (`res/values/strings.xml`, `auto_granted_location_permission_notification_title`
  and `auto_granted_permission_notification_body`). A device owner can't change "Your organization":
  that needs `UPDATE_DEVICE_MANAGEMENT_RESOURCES` (`signature|role`).

Belay's consequence: location is declared but granted by policy only while the policy has it on (a
mode, lost mode, or the one fix a kid shares with a help request), and denied by policy otherwise,
so Settings shows Belay without it and the kid can't grant it (core's `CategoryPermissions`,
`DeviceOwnerSetup`). A grant that silently didn't happen shows: Belay reads `checkSelfPermission`
before taking a fix, and reports "Android didn't let Belay use location." The kid's Location card
explains Android's "your organization" wording.

### L2. `setLocationEnabled` and `DISALLOW_CONFIG_LOCATION`

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 4 CI).

- `DevicePolicyManagerService.setLocationEnabled`: the default device owner only
  (`checkCallAuthorization(isDefaultDeviceOwner)`); it calls `LocationManager.setLocationEnabledForUser`,
  and when it turns location on (it was off) posts Android's own notice, "Apps can access your
  location" / "Contact your IT admin to learn more" (`core/res` `location_changed_notification_title`
  and `_text`). On automotive builds turning it off is ignored.
- `core/java/android/os/UserManager.java`, `DISALLOW_CONFIG_LOCATION` ("no_config_location"):
  "When it is set by a device owner … it disallows the primary user from turning location on or
  off", and "a device owner or a profile owner can still enable or disable location mode via
  DevicePolicyManager#setLocationEnabled when this restriction is on". It differs from
  `DISALLOW_SHARE_LOCATION`, which keeps apps from location. `dumpsys user` lists it under each
  user's "Effective restrictions:" (`UserRestrictionsUtils.dumpRestrictions`), which CI reads.

Belay's consequence: `keep_on` (with a mode on) and lost mode are Phase 2's lock `CONFIG_LOCATION`
plus `setLocationEnabled(true)`. Belay turns location back off only when it turned it on itself
for lost mode or a help fix; when `keep_on` ends, the kid decides.

### L3. "network" and "fused" without Play services code

**Partly.** Verified on: AOSP (from the drafts, not re-checked).
`location/LocationManagerService.onSystemThirdPartyAppsCanStart` binds "network" and "fused" to
the system package that serves `ACTION_NETWORK_PROVIDER` or `ACTION_FUSED_PROVIDER` (AOSP's own
`com.android.location.fused` is the fallback); "gps" is the GNSS hardware. On a Pixel those are
expected to be Google Play services, under Google's own location settings (`dumpsys location` names
them: the Pixel checklist records it).

Belay's consequence: `provider: "gps"` by default; "fused" only when the family chose it or as
`fallback_fused`. No Play services code in Belay either way.

### L4. Platform geofencing

**Partly.** Verified on: AOSP (from the drafts). `location/geofence/GeofenceManager`, behind
`addProximityAlert`, asks the fused provider. Belay computes places itself from its own fixes, in
`:core` (`Places.evaluate`, with two-fix hysteresis).

### L5. No `location` foreground service needed

**Confirmed.** Verified on: AOSP; Docs (from the drafts). A device owner may start a foreground
service from the background, and with `ACCESS_BACKGROUND_LOCATION` granted by policy Belay may
read location at any time; Belay's `systemExempted` service keeps it out of the background
throttle (`location/injector/SystemAppForegroundHelper`).

### L6. What the kid sees while location is used

**Confirmed for GPS-level requests.** Verified on: AOSP (from the drafts). System UI shows the
status bar's location icon while an app holds `OP_MONITOR_HIGH_POWER_LOCATION`; a low-power
request may show nothing.

Belay's consequence: its own notice for every check a parent asked for ("Your parent checked where
this phone is (8:15 PM)", "…, using Claude"), an ongoing one in lost mode, and periodic mode in the
managed notice ("Shares where this phone is every 30 minutes, 7:00 AM to 9:00 PM").

### L7. Losing a granted permission stops and restarts the app

**Confirmed.** Verified on: AOSP; Emulator pending (Phase 4 CI).

- `services/permission/.../permission/PermissionService.kt`, `onPermissionFlagsChanged`: a runtime
  permission going from granted to not granted adds the uid to `runtimePermissionRevokedUids`;
  `onStateMutated` then posts `killUid(uid, KILL_APP_REASON_PERMISSIONS_REVOKED)`
  (`ActivityManager.killUidForPermissionChange`), unless only `POST_NOTIFICATIONS` was revoked and a
  backup is running, or the caller asked to skip it (an internal path only). R5 relies on the same.
- `PermissionControllerServiceImpl.onSetRuntimePermissionGrantStateByDeviceAdmin` persists a
  DENIED change with `mayKillBecauseOfAppOpsChange` true.
- Expected, not re-read here: the killed process's services come back by themselves (Belay's
  foreground service is sticky, and the system keeps its `DeviceAdminService` bound, B7), as R5's
  camera gate already relies on; a visible activity without saved state goes. CI checks it.

Belay's consequence: turning location off (or lost mode, or a help fix, ending) restarts Belay once.
The agent step denies the permission last, after storing what it did; the sync after the restart
sends what waits. A help fix's grant waits until Belay's screens are closed, so the help screen
with "call 911" never vanishes under the kid; until then Belay holds location but takes no other
fix. CI turns location off and checks the permission goes and Belay comes back. An instrumented
test can't deny it: the instrumentation runs in Belay's process.

### L8. `getCurrentLocation` and its timeout

**Contradicted for a 60-second timeout.** Verified on: AOSP; SDK.

- `services/core/.../location/provider/LocationProviderManager.getCurrentLocation`: a request's
  duration over `MAX_GET_CURRENT_LOCATION_TIMEOUT_MS` (30 s) is cut to 30 s. A registration that
  never activates (the provider off, location off, no permission) delivers null at once; one that
  activates delivers a last location no older than `MAX_CURRENT_LOCATION_AGE_MS` (30 s) if there is
  one, else the next fix, else null at the end.
- `LocationManager.getCurrentLocation(String, LocationRequest, CancellationSignal, Executor,
  Consumer<Location>)` (API 31), `Location.isMock()` (API 31) and `LocationManager.FUSED_PROVIDER`
  (API 31) are public in the 37.0 SDK.

Belay's consequence: a fix is two calls of 30 s (GPS twice, or GPS then "fused" with
`fallback_fused`; "fused" twice if the family chose it), one at a time, under a 75-second partial
wake lock (`location/LocationCollector.kt`). A null that comes back within 5 seconds isn't waited
on again. The failures read "No GPS fix in 60 seconds." and so on, word for word on the parent page.

### L9. A known GPS point on the emulator

**Only with a mock provider.** Verified on: AOSP (`device/generic/goldfish`).
The emulator's GNSS HAL gets its fixes from the emulator console (`adb emu geo fix <longitude>
<latitude>`); from inside the phone only a test provider (`LocationManager.addTestProvider`, or the
shell's `cmd location providers set-test-provider-location`) can set a point, and its fixes are
mock fixes (`isMock()`), which Belay reports as such and never counts for places.

Belay's consequence: CI sets the point with `adb emu geo fix -122.08 37.42` and passes it to
`LocationInstrumentedTest` as instrumentation arguments; the server's fix for `locate-now` must
match it to about 4 decimals and not be a mock.

### L10. `setDeviceOwnerLockScreenInfo`

**Confirmed.** Verified on: AOSP; Docs. `DevicePolicyManagerService.setDeviceOwnerLockScreenInfo`:
the default device owner (or the profile owner of an organization-owned phone); without the flag
`lockscreen_info_coexistence` it calls `LockPatternUtils.setDeviceOwnerInfo`, with it the policy
engine's `LOCKSCREEN_MESSAGE` (permission `MANAGE_DEVICE_POLICY_LOCKSCREEN_MESSAGE`, which a device
owner holds). Null or empty takes it away.

Belay's consequence: lost mode shows the parent's message (at most 120 characters) on the lock
screen and takes it away when lost mode ends. The Pixel checklist records where it shows.

### G1. Calls and texts to 911, 988 and a parent while apps are suspended

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 7 CI, `KidSideInstrumentedTest`).

- `Intent.ACTION_DIAL` with a `tel:` number needs no permission and opens the dialer with the
  number filled in. T2: an emergency call always goes through the preloaded dialer, and
  an `ACTION_CALL` (which needs `CALL_PHONE`) to 911 from another app is raised to it as ACTION_DIAL.
- `Intent.ACTION_SENDTO` with `smsto:` opens the texting app (the SMS role holder takes it).
- `TelecomManager.getDefaultDialerPackage()` and `Telephony.Sms.getDefaultSmsPackage()` need no
  permission (C10). Belay never suspends the default and preloaded dialers, `com.android.phone`,
  the default SMS app or the emergency apps (core's `NeverBlocked`), so a pause, a schedule or a
  limit never closes them.

Belay's consequence: the emergency card's buttons start ACTION_DIAL and ACTION_SENDTO in those
packages by name (so no chooser, and no other app that may be paused, comes up), falling back to
Android's choice; the kid taps Call in the dialer. Text 911 says it only works in some places.

### G2. Android's own emergency information

**Confirmed on Android 17.** Verified on: AOSP.

- `telephony/java/android/telephony/TelephonyManager.ACTION_EMERGENCY_ASSISTANCE`,
  `"android.telephony.action.EMERGENCY_ASSISTANCE"`, is `@SystemApi` (not in the public SDK), but
  it's the one activity the emergency role requires (`PermissionController/res/xml/roles.xml`,
  `android.app.role.EMERGENCY`, `systemOnly="true"`).
- `packages/apps/EmergencyInfo` (`com.android.emergency`): `.view.ViewInfoActivity` takes it,
  exported, without a permission, `showWhenLocked`. `android.settings.EDIT_EMERGENCY_INFO`
  (its editor) isn't a public Settings constant.
- On a Pixel the role holder is expected to be the Personal Safety app (package unverified: the
  Phase 7 checklist records it).

Belay's consequence: "Medical information and emergency contacts" starts that action in the system
app that takes it (`ui/Emergency.kt`), and isn't shown when none does. Belay never copies medical
details. The emergency apps are never suspended.

## Calls (Phase 5)

All read in AOSP `android-17.0.0_r1` on 2026-11-17 (`platform/frameworks/base` unless named; Telecom
is `packages/services/Telecomm`, the role controller `packages/modules/Permission`), and in the
InCallService, CallScreeningService and BlockedNumberContract references. T1 to T6 moved here from
[the drafts](design/platform-notes-drafts.md) and were checked again where Belay now relies on them;
T10 to T16 are new (T7 to T9, about texts, stay in the drafts). The emulator checks run in CI
(`CallFlowInstrumentedTest`, `CallsInstrumentedTest` and `ci-emulator-test.sh`'s Phase 5 block); the
Pixel's are in [phase5-checklist.md](phase5-checklist.md). No test calls or texts 911 or 988, on the
emulator or anywhere else: those paths are JVM tests (`AlwaysAllowedTest`, `CallRulesTest`,
`CallRecordsTest`) and checks that don't dial.

### T1. Belay as the default dialer

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 5 CI).

- `services/devicepolicy/.../DevicePolicyManagerService.setDefaultDialerApplication` (API 34; the
  device owner, or the profile owner of an organization-owned phone): returns without doing anything
  when the phone lacks `FEATURE_TELEPHONY`; otherwise calls `RoleManager.addRoleHolderAsUser(ROLE_DIALER, …)`
  and waits up to 20 s, throwing `IllegalArgumentException` ("… cannot be set as the dialer", or
  "Timeout when setting the app as the dialer") when that fails.
- `PermissionController/res/xml/roles.xml`, `android.app.role.DIALER`: requires an activity for
  `ACTION_DIAL`, one for `ACTION_DIAL` with `tel:`, and (target 33 and up) an `InCallService`
  protected by `BIND_INCALL_SERVICE` with meta-data `android.telecom.IN_CALL_SERVICE_UI = true` and
  no car-mode UI. It grants its holder the phone, contacts, SMS, microphone, camera and notification
  permissions it requests, and `SYSTEM_ALERT_WINDOW`; it's exclusive, with
  `fallBackToDefaultHolder="true"` (T10).
- InCallService reference [2026-09-16]: the app must "fully implement the InCallService API and
  provide both an incoming call UI, as well as an ongoing call UI"; don't mark the service
  `exported="false"`. The default dialer can't be suspended (C1).

Belay's consequence: Belay's dialer (`BelayInCallService`, `BelayCallScreeningService`,
`DialerActivity`, its launcher alias and `OutgoingCallReceiver`) is disabled in the manifest and
enabled only while the policy has `calls`, so with calls off Belay isn't in Settings' list of phone
apps and Telecom never binds it. The agent step makes Belay the dialer on the agent thread (the call
blocks), checks `getDefaultDialerPackage()` afterwards, and after a refusal asks again only every 15
minutes or at a new policy. While it isn't the dialer, the report says "Calls are going through the
phone's own app" (`enforcement.calls.problem`).

### T2. 911 when Belay is the dialer

**Confirmed.** Verified on: AOSP; Docs. Never tried on a device: no test calls 911.

- InCallService reference [2026-09-16]: "The preloaded dialer will ALWAYS be used when the user
  places an emergency call, even if your app fills the ROLE_DIALER role"; place every call with
  `TelecomManager.placeCall`.
- Telecom `TelecomServiceImpl.placeCall`: "the default/system dialer is always allowed to attempt to
  place a call (regardless of permission state), in case it turns out to be an emergency call"; a
  call to another number without `CALL_PHONE` is refused later, by `UserCallIntentProcessor`.
- `NewOutgoingCallIntentBroadcaster`: an `ACTION_CALL` to an emergency number from an app that isn't
  the default or system dialer is cancelled and opened in the system dialer as `ACTION_DIAL`
  (`launchSystemDialer`); from the default dialer it's placed at once, with no redirection.
- `InCallController.EmergencyInCallServiceConnection` proxies to the default dialer until there's an
  emergency call (`setHasEmergency` → `takeControl`) or the dialer's connection fails or dies ("the
  sub-connection just died so we need to stop proxying and connect to the system in-call service
  instead"), then binds the system dialer. Telecom makes a new one each time it binds for calls.

Belay's consequence: Belay places 911, Android's emergency numbers and 988 with `placeCall` like any
other call. The preloaded dialer (on a Pixel, Google's Phone app; the checklist records the
package) takes the emergency calls, and is never hidden, suspended or disabled, and keeps
`CALL_PHONE` (T14). If Belay's in-call service crashes or won't bind, Telecom uses the preloaded
dialer, with no filtering: on purpose, since a phone that can't take calls is worse.

### T3. 988 is an ordinary number to Android

**Contradicted.** Verified on: AOSP.

- `packages/services/Telephony`, `ecc/input/eccdata.txt`: the US entry lists only 911 (police,
  ambulance, fire; fallback 911). Carriers and SIMs can add numbers. 988 goes through the default
  dialer like any other call.
- `core/res/res/xml/sms_short_codes.xml`: US short codes match `\d{5,6}`, so 988 isn't treated as a
  short code, and texting it shows no premium-SMS warning.

Belay's consequence: 988 is on Belay's always-allowed list in code (`:core` `AlwaysAllowed`), with
the Lifeline's older number, 1-800-273-8255, which still reaches it (the server treats it as 988
too), next to 911 and whatever Android reports as an emergency number (T13).

### T4. Call screening and withheld numbers

**Contradicted** (that screening sees every incoming call). Verified on: AOSP; Docs; Emulator
pending (Phase 5 CI).

- CallScreeningService reference [2026-09-16]: only `tel:` calls; "Calls with a …
  PRESENTATION_RESTRICTED, PRESENTATION_UNKNOWN, PRESENTATION_UNAVAILABLE or PRESENTATION_PAYPHONE
  presentation are not provided"; the service must answer within 5 seconds
  (`CallScreeningServiceFilter.CALL_SCREENING_FILTER_TIMEOUT = 5000`); it also sees outgoing calls,
  for caller id; blocked calls are logged as `BLOCKED_TYPE`.
- Only calls from numbers not in Android's contacts go to a screening app without `READ_CONTACTS`,
  but `CallScreeningServiceFilter.hasReadContactsPermission` is true for the default dialer: it's
  asked about every call with a number.
- `CallsManager.setUpCallFilterGraph`: a screening app the user chose (`ROLE_CALL_SCREENING`) that
  isn't the default dialer replaces the default dialer's screening; Telecom asks one or the other.

Belay's consequence: Belay decides every incoming call in its `InCallService.onCallAdded` (withheld
callers, and every call when another app holds the screening role), refusing it before anything
rings. Its screening service only decides sooner: it answers within 4 seconds, letting the call
through when it can't, and asks Android to post no notification for a call it refuses.

### T5. The dialer decides whether a call rings

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 5 CI).

- InCallService reference: with the meta-data `android.telecom.IN_CALL_SERVICE_RINGING`, the app "is
  responsible for playing the ringtone for incoming calls".
- Telecom `Ringer.startRinging`: while the bound dialer handles ringing
  (`doesConnectedDialerSupportRinging`), Telecom plays no ringtone and no vibration ("Dialer
  handles"), and only takes audio focus for it when the ringer would be audible.
- `Call.EXTRA_SILENT_RINGING_REQUESTED`: a screening app asked to silence the call, so a dialer
  that rings shouldn't. `Call.EXTRA_IS_SUPPRESSED_BY_DO_NOT_DISTURB` "will be removed from the Call
  object for InCallServices that do not hold the READ_CONTACTS permission".
- `InCallController` binds in-call services with `BIND_FOREGROUND_SERVICE |
  BIND_ALLOW_BACKGROUND_ACTIVITY_STARTS`, so the dialer can open its call screen from the background.
- `core/res/AndroidManifest.xml`: `USE_FULL_SCREEN_INTENT` is `normal|appop`: granted at install, but
  an app op, which can be switched off.

Belay's consequence: a call the rules refuse never rings. Belay rings only once it has decided, with
its own looping ringtone (`USAGE_NOTIFICATION_RINGTONE`) and vibration, following the ringer mode,
and only vibrates when another call is on or a screening app asked. The incoming call is a
`CallStyle` notification with a full-screen intent to Belay's call screen. Belay holds no
`READ_CONTACTS`, so it doesn't get Do Not Disturb's verdict: what Do Not Disturb does to Belay's
ringtone is on the Pixel checklist.

### T6. Blocked numbers

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 5 CI).

- BlockedNumberContract [2026-08-03]: "Only the system, the default SMS application, and the default
  phone app … and carrier apps can read, and write"; "The platform blocks calls, and messages from
  an address if it is present".
- `packages/providers/BlockedNumberProvider`, `checkForPrivilegedApplications`: root, the default
  and the system dialer, an app allowed the `WRITE_SMS` app op (the default SMS app), or one with
  carrier privileges; anyone else needs `READ_BLOCKED_NUMBERS` or `WRITE_BLOCKED_NUMBERS`
  (signature), which the shell holds (`packages/Shell/AndroidManifest.xml`). Blocking works for the
  phone's system user (and a main user or managed profile).
- `CarrierConfigManager.KEY_DURATION_BLOCKING_DISABLED_AFTER_EMERGENCY_INT`: "The duration in
  seconds that platform call and message blocking is disabled after the user contacts emergency
  services", default 7200.

Belay's consequence: while it's the dialer, Belay keeps Android's block list in step with the
policy's `blocked_numbers`, adding and removing only its own entries (it remembers which), never an
always-allowed number. It takes them off during its own 2-hour callback window and puts them back
after, and takes them all off before it gives the role back, since afterwards it can't. CI reads the
list as the shell, with `content query`.

### T10. Giving the dialer role back

**Confirmed.** Verified on: AOSP; Emulator pending (Phase 5 CI).

- `services/core/.../role/RoleServicePlatformHelperImpl.computePackageStateHash` covers every
  package's enabled and disabled components, and `RoleService` (`packages/modules/Permission`)
  re-checks the default roles on `PACKAGE_CHANGED` when that hash changes.
  `RoleControllerServiceImpl` then drops a "package that no longer qualifies for the role", and with
  `fallBackToDefaultHolder` gives the role to the default holder (`config_defaultDialer`) if that
  one qualifies.
- The role controller's `Permissions.revokeSingleAsUser` revokes only what the role granted, and
  stops at a permission "fixed to granted" (`FLAG_PERMISSION_POLICY_FIXED`): a device owner's grant
  outlives the role, and since nothing is revoked, the app isn't killed (L7).
- `TelecomServiceImpl`: `ACTION_DEFAULT_DIALER_CHANGED`, with the new package, goes out when the
  dialer changes, but not when there's none ("We are replacing the dialer, just wait for the
  upcoming callback").

Belay's consequence: when calls goes off, Belay gives the role back with
`setDefaultDialerApplication` to the dialer it recorded when it took over, then disables its dialer
without stopping itself (`DONT_KILL_APP`), which also drops it from the role where there was no
dialer to give back (the ATD image, T15). Its call permissions go last, denied by policy, which
restarts Belay once (L7). Belay listens for `ACTION_DEFAULT_DIALER_CHANGED`, and each agent step (at
least hourly) checks the dialer, for a change with no broadcast.

### T11. Seeing a call to 911 or 988 that Belay's dialer didn't place

**Partly.** Verified on: AOSP; Docs.

- `NewOutgoingCallIntentBroadcaster`: "Calls to emergency numbers are still broadcast for
  informative purposes. The call is placed prior to sending ACTION_NEW_OUTGOING_CALL and cannot be
  redirected nor prevented." Only voicemail and self-managed calls skip it. It goes to holders of
  `PROCESS_OUTGOING_CALLS` with `FLAG_RECEIVER_INCLUDE_BACKGROUND`, so a manifest receiver gets it.
- `CallLogManager.okayToLogCall`: an emergency call goes in Android's call log only when the
  carrier sets `KEY_ALLOW_EMERGENCY_NUMBERS_IN_CALL_LOG_BOOL` (`CarrierConfigManager`: `false` by
  default). 988 is an ordinary number to Android (T3), so its calls are logged.
- `READ_CALL_LOG` and `PROCESS_OUTGOING_CALLS` are hard-restricted (`core/res/AndroidManifest.xml`),
  which an adb install allowlists (the drafts' I4).
- Telecom adds `Call.EXTRA_LAST_EMERGENCY_CALLBACK_TIME_MILLIS` to an incoming call only when it
  connects the system dialer itself (`EmergencyInCallServiceConnection.connect`), not while it hands
  calls to the default dialer: Belay will rarely see it.

Belay's consequence: the 2-hour callback window opens on a call Belay places to an always-allowed
number, a tap on one of Belay's buttons to text 911 or 988, `NEW_OUTGOING_CALL` to one of those
numbers (from the preloaded dialer or the lock screen's emergency dialer), an outgoing one in
Android's call log, or Telecom's extra. Belay keeps the time only on the phone, and forgets it once
the window is over. A call that rings only because of the window is never sent (its record would
tell a parent).

### T12. Missed-call notifications

**Confirmed.** Verified on: AOSP.

- Telecom `ui/MissedCallNotifierImpl`: when the default dialer has a receiver for
  `ACTION_SHOW_MISSED_CALLS_NOTIFICATION`, Telecom sends it there (to holders of `READ_PHONE_STATE`
  only); otherwise Telecom posts its own missed-call notification.
- `CallLogManager`: an incoming call that ends as `MISSED` is logged `MISSED_TYPE` and notified; one
  the dialer rejected is `REJECTED_TYPE`, with no notification; one call screening blocked is
  `BLOCKED_TYPE`, notified only if the screening response asks.

Belay's consequence: Belay has no such receiver (it doesn't hold `READ_PHONE_STATE`), so Android
shows its own notification for a call that rang and was missed. A call the rules refuse is
rejected, never left to ring out, so Android doesn't call it missed; Belay's recent calls say why it
didn't ring.

### T13. `isEmergencyNumber`

**Confirmed.** Verified on: AOSP.

- `telephony/.../TelephonyManager.isEmergencyNumber(String)`: no permission (the phone process's
  `PhoneInterfaceManager` checks one only for the old "potential" match). It throws
  `IllegalStateException` when the phone process isn't there, and `UnsupportedOperationException`
  without `FEATURE_TELEPHONY_CALLING` or `FEATURE_TELEPHONY_MESSAGING`. It asks every phone's
  `EmergencyNumberTracker` (the SIM's, the network's, the modem's and Android's own numbers for the
  country).
- `frameworks/opt/telephony`, `EmergencyNumberTracker`: "According spec 3GPP TS22.101", 112 and 911,
  and with no SIM also 000, 08, 110, 118, 119 and 999.

Belay's consequence: `AlwaysAllowed` asks Android about every number that isn't 911 or 988; when
Android can't say (it throws, or the phone has no telephony), the no-SIM list counts, so a phone
process that's down never stops an emergency number working.

### T14. `CALL_PHONE` for other apps

**Confirmed.** Verified on: AOSP; Emulator pending (Phase 5 CI).

- `core/res/AndroidManifest.xml`: `CALL_PHONE` is a dangerous permission (`costsMoney`); a device
  owner can deny it to another app with `setPermissionGrantState` (R2).
- `TelecomServiceImpl.canCallPhone`: `placeCall` needs `CALL_PHONE` and its app op, except for the
  default and system dialers and holders of `CALL_PRIVILEGED` (the phone process's emergency dialer).
  `UserCallIntentProcessor` refuses a call without it only when the number isn't an emergency
  number, and T2's `ACTION_CALL` to an emergency number goes to the system dialer whatever the app
  holds.

Belay's consequence: while calls is on, Belay denies `CALL_PHONE` to every app that requests it,
except itself and the apps it never blocks (core's `NeverBlocked`: the dialers, the texting app,
Android's telephony and emergency apps…), and gives it back (to its default state) when calls goes
off. Emergency calls don't depend on it. A call another app starts anyway still reaches Belay's
`onCallAdded`, which ends it before it connects if the rules don't allow it.

### T15. The CI emulator: no preloaded dialer, and calls from the console

**Confirmed.** Verified on: AOSP; Docs; Emulator pending (Phase 5 CI).

- The ATD image's product (`device/generic/goldfish`, `product/slim_handheld.mk`) inherits
  `telephony_system_ext.mk` but not `telephony_product.mk` (`platform/build`, `target/product/`),
  the makefile that adds `Dialer`: there's no preloaded dialer, and there may be no default dialer
  before Belay. The Google APIs image is expected to have AOSP's Dialer (`com.android.dialer`; not
  checked).
- Emulator console reference [2026-11-13]: `gsm call <phonenumber>` "Simulates an inbound phone call
  from phonenumber", `gsm cancel <phonenumber>` ends it, and "The Android system handles simulated
  calls exactly as it would actual calls. The emulator doesn't support call audio."

Belay's consequence: CI's Phase 5 block calls the emulator from made-up 555-01xx numbers and checks
that a contact rings Belay's screen, a stranger is rejected without ringing and reported, a blocked
number reaches Android's block list, and calls off gives the dialer back (on ATD: to nobody). It
never calls or simulates 911 or 988, which only JVM tests cover.

### T16. Call audio and the SIM choice in an in-call app

**Confirmed.** Verified on: AOSP; Pixel pending (Phase 5 checklist).

- `telecomm/.../InCallService`: `onCallAudioStateChanged` is deprecated for `onCallEndpointChanged`,
  `onAvailableCallEndpointsChanged` and `requestCallEndpointChange` (API 34): earpiece, speaker,
  Bluetooth and wired headsets as endpoints.
- `Call.STATE_SELECT_PHONE_ACCOUNT`: an outgoing call waits for the dialer to pick a SIM
  (`phoneAccountSelected`) when the phone has two and no default, with
  `Call.EXTRA_SUGGESTED_PHONE_ACCOUNTS`.

Belay's consequence: Belay's call screen routes audio with the endpoint API from Android 14 (the
older `CallAudioState` before), and picks the first suggested SIM, only once the call is allowed.

---

## Phase 0 results

Fill this in from docs/phase0-checklist.md on the Pixel 8. Write what you saw, word for
word where Android shows a message. No screenshots, no account names, no serial numbers.

| Step | Check | Result | Android build (Settings > About phone) |
|---|---|---|---|
| 1 | Play Protect prompt during `provision.sh` (exact words, or none) | pending | |
| 1 | `dpm set-device-owner` with the release build: Success? | pending | |
| 2 | Setup checks all ✓; standby bucket "exempted" | pending | |
| 2 | Notice visible; can't swipe it away; can't turn it off after the restart | pending | |
| 2 | Quick Settings > Active apps: Belay without a Stop button | pending | |
| 2 | Settings > Apps > Belay: Force stop, Uninstall, Clear storage greyed out | pending | |
| 2 | What Android itself says about management (Quick Settings footer, Settings) | pending | |
| 2 | After a day: Play Protect warnings about Belay (exact words, or none) | pending | |
| 2 | After a day: still device owner; service running; Background checks pattern overnight | pending | |
| 3 | Adding the parent-owned Google account: any message | pending | |
| 3 | Play install seen: "Installed · <app>", "noticed right away", "from Play Store" | pending | |
| 3 | Raw install source of the Play app (`dumpsys package`) | pending | |
| 3 | Uninstall seen: "Removed · <app>", "noticed right away" | pending | |
| 3 | After restart: Belay back by itself; both changes still listed; "phone started" | pending | |
| 4 | QR provisioning with the same release APK: blocked? (exact words) | pending | |
