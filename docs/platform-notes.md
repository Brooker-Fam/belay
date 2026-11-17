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
