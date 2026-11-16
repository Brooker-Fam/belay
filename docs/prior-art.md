# Prior art

Three projects were read before writing Belay (2026-11-16). None is forked and no code is
copied; NOTICE credits them. If code is ever adapted, its notice goes with it (TestDPC and
Headwind are Apache-2.0, kidctl is MIT; never GPL or AGPL code such as TimeLimit,
OwnDroid or Aurora Store).

## kidctl (MIT) — github.com/kidctl/kidctl

Nearly the same idea, further along: used daily on a Pixel 8 with Android 17 since
October 2026.

**What it already solved:**
- A Rust server (one binary, SQLite) serving compiled rules to each phone, with a
  per-device bearer token, agent self-updates, and MCP behind OAuth 2.1.
- Rules are YAML in a git repository. Claude's write tools edit the YAML (keeping its
  comments), validate it, and commit with a `Requested-By:` trailer, so every change is
  reviewable and revertible in git.
- A dependency-free Kotlin device-owner agent, provisioned with adb (`scripts/provision.sh`).
  A `specialUse` foreground service evaluates the rules every ~30 s, offline too, and
  suspends apps.
- Provisioning config over adb through a receiver protected by `WRITE_SECURE_SETTINGS`,
  which the shell holds and ordinary apps can't get.
- Over-the-air agent updates, checked by SHA-256 and installed with PackageInstaller.
- Tamper resistance, measured on the API 37 emulator and the Pixel: no factory reset,
  safe mode, new users or clock changes; `setUserControlDisabledPackages` because
  `DISALLOW_APPS_CONTROL` alone left a Stop button in Quick Settings for other apps.
- Play Protect measured: with the package and key registered for developer verification,
  updates installed on the Pixel 8 with no dialog.
- The same evaluation rules in Rust and Kotlin, both run against shared test vectors.
- An end-to-end emulator test that refuses to run on a real phone.

**Where Belay differs:**
- **Loosening needs a person.** kidctl's MCP can change any rule, loosening included.
  Belay's AI clients may only tighten; approving an app or lifting a limit is a proposal
  until a parent taps Approve on the parent page (Phase 2).
- **Monitoring and conversation first.** Phase 1 is an inventory with install sources,
  sensitive permissions and per-app review history, for AI reviews and talking with the
  kid. kidctl reports launchable apps and usage, and centers on screen-time rules.
- **Untrusted text.** Belay's MCP results put app labels, store text and anything typed
  on the kid's phone in labeled data fields, never as instructions.
- **Transparent to the kid.** Belay's own screen lists what the parent can see, built from
  the collectors; kidctl relies on Android's own managed notices plus its notifications.
- **For parents who aren't developers.** Policy and history live in the server's database,
  with a web parent page and an activity log, instead of YAML in git. (kidctl's git
  history is a very good audit trail; Belay's activity log has to be as clear.)
- **Stack:** Node and TypeScript on the server; Compose UI, WorkManager and
  kotlinx.serialization in the agent.
- **Staying alive:** a `systemExempted` service plus the `DeviceAdminService` Android keeps
  bound for a device owner (both work for a device owner; see platform-notes.md B1, B7).

**Worth borrowing (with credit):** the `WRITE_SECURE_SETTINGS` receiver for
`provision.sh --server --code` (Phase 1); reading back every applied setting and
reporting failures; shared test vectors if logic ever lives on both server and phone.

## TestDPC (Apache-2.0) — github.com/googlesamples/android-testdpc

Google's sample device policy controller, the reference for the device-owner APIs.

- Provisioning activities: `GET_PROVISIONING_MODE` (`provision/GetProvisioningModeActivity.java`),
  `ADMIN_POLICY_COMPLIANCE` (`FinalizeActivity.java`) and `PROVISIONING_SUCCESSFUL`,
  all exported and protected by `BIND_DEVICE_ADMIN`.
- Post-provisioning runs once behind a flag (`PostProvisioningTask.java`) and grants the
  DPC its own runtime permissions with `setPermissionGrantState`.
- Its `DeviceAdminService` registers a package-change receiver: the pattern Belay uses.
- Its own build 9.0.12 was blocked from QR provisioning by Play Protect in September 2026
  (issue #283).
- No NOTICE file; each source file carries the Apache-2.0 header.

Belay's provisioning activities were written from the `DevicePolicyManager`
documentation, not copied.

## Headwind MDM (Apache-2.0 agent) — github.com/h-mdm/hmdm-android

An open-core MDM. **The claim holds:** the free Community edition leaves out "Blocking
unwanted applications and settings", "Kiosk mode" and "Tracking the device locations",
plus remote lock and wipe (h-mdm.com/headwind-mdm-version-comparison/). In the agent,
`pro/ProUtils.java` and the foreground-app check services are stubs.

Technically useful:
- As device owner it becomes the persistent home app, and uses `systemExempted` when it's
  device owner, `specialUse` otherwise.
- It supports adb provisioning (`dpm set-device-owner com.hmdm.launcher/.AdminReceiver`),
  reading its settings from a file because adb passes no provisioning extras.
- Its install-complete broadcast uses a mutable implicit `PendingIntent` that another app
  could fake. Don't copy that.
- Its open-source page says custom builds are "currently blocked by Play Protect" at
  QR enrollment since 2026, matching platform-notes.md P1.
