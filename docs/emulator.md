# The emulator

Develop on the Android 17 emulator; prove things on the real Pixel 8, with its checklists in
the order of [pixel-day.md](pixel-day.md), from [phase0-checklist.md](phase0-checklist.md) on.

## The image

Use **`system-images;android-37.0;google_apis;x86_64`** (or `arm64-v8a` on an Apple
silicon Mac). It's the newest Android 17 image with 4 KB memory pages, like the Pixel 8:
37.1 and 37.2 only come as 16 KB-page images (`_ps16k`).

- *Google APIs* has no Play Store, so Play Protect never interrupts. CI uses it, and the
  Automated Test Device image (`aosp_atd`, no Google services), which must pass.
- *Google Play* (`google_apis_playstore`) is closer to the Pixel. Use it to see what Play
  Protect does, but don't sign in: device owner needs a phone with no accounts.

```bash
sdkmanager "platform-tools" "emulator" "platforms;android-37.0" "system-images;android-37.0;google_apis;x86_64"
avdmanager create avd -n belay37 -k "system-images;android-37.0;google_apis;x86_64" -d pixel_8
emulator -avd belay37
```

The emulator needs hardware acceleration (KVM on Linux). A new AVD has no accounts and
one user, so it's ready to provision. To start over: `emulator -avd belay37 -wipe-data`.

## Provision and unprovision

Use the debug build: it's test-only, so it can be released without wiping the emulator.

```bash
(cd android && ./gradlew :app:assembleDebug)
android/scripts/provision.sh --debug            # add --yes to skip the question
android/scripts/unprovision.sh                  # releases device owner and uninstalls
```

`provision.sh` restarts the emulator once at the end (`--no-reboot` skips that). A release
build works on the emulator too, but then only a wipe removes it.

To install a newer debug build over a provisioned one, run `provision.sh --debug` again:
it installs the update and grants again. `adb install -r -t` also works.

## Connect it to a server

Run a server on your computer ([server.md](server.md)) with the address the emulator
sees for your computer, `10.0.2.2`:

```bash
cd server
BELAY_PUBLIC_URL=http://10.0.2.2:8080 npm run dev     # prints the one-time setup link
BELAY_PUBLIC_URL=http://10.0.2.2:8080 npm run cli -- create-code "Test phone"
```

Open the setup link with `localhost` in place of `10.0.2.2` to make a parent account.
Then provision with the code (or make it on the Add a phone page):

```bash
android/scripts/provision.sh --debug --yes --server http://10.0.2.2:8080 --code 7KQ2M9XA
```

Debug builds allow plain http to `10.0.2.2` only; release builds need https
([platform-notes.md N1](platform-notes.md#n1-https-only-with-the-systems-cas)). The phone
also enrolls from its own screen, by scanning the QR code or typing the code, while it isn't
connected.

## Instrumented tests

Belay has to stay device owner while its tests run, so install the test APK and run it
with `am instrument`, not `connectedAndroidTest` (which tries to uninstall the app
afterwards, and a device owner can't be uninstalled):

```bash
(cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :fixture:assembleV1Debug :fixture:assembleV2Debug)
android/scripts/provision.sh --debug --yes
adb install -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb push android/fixture/build/outputs/apk/v1/debug/fixture-v1-debug.apk /data/local/tmp/belay-fixture-v1.apk
adb push android/fixture/build/outputs/apk/v2/debug/fixture-v2-debug.apk /data/local/tmp/belay-fixture-v2.apk
adb shell am instrument -w family.brooker.belay.test/androidx.test.runner.AndroidJUnitRunner
```

The device-owner tests are skipped when Belay isn't device owner. The fixture test
installs, updates and removes a tiny made-up app (`family.brooker.belay.fixture`) and
checks that Belay's outbox got the three changes; it's skipped without the two APKs.

## What CI runs

Three workflows. Each runs on every push and pull request that touches its part of the
repository, and by hand (`workflow_dispatch`).

**`.github/workflows/android.yml`** (pushes touching `android/` or `server/`):

- *Build, unit tests, lint:* `shellcheck` on `android/scripts/*.sh`; `:core:test`, the debug, test
  and release builds (the release build unsigned: the release key never leaves the family's
  computer), `:app:lintDebug` and `:app:lintRelease`, and the fixture app's two versions. Then a
  check that the release APK has no debug-only parts: no debug receiver, no part of the archival
  test (T8), no `READ_SMS` or `WRITE_SMS` and no `testOnly` in its manifest, and no debug-only
  class. Last, a second debug build of Belay, for the self-update test (below).
- *The emulator job,* on two images: `system-images;android-37.0;aosp_atd;x86_64`, the Automated
  Test Device image (no Google services), which must pass, and `google_apis`, closer to a phone,
  informational for now (see platform-notes.md). It starts a real Belay server on the runner,
  makes an enrollment code with its CLI, and runs `ci-emulator-test.sh`.

`android/scripts/ci-emulator-test.sh <debug APK> <androidTest APK> [<fixture v1> <fixture v2>]`
refuses to run on anything but an emulator. It waits 45 seconds after boot first: the Google APIs
image briefly has an account right after boot, which makes `dpm set-device-owner` refuse. On its
own, it checks:

- `provision.sh` with the debug build, its restart included;
- the checks from [platform-notes.md](platform-notes.md) that can be made from a shell: device
  owner, the bound `DeviceAdminService`, the foreground service, the managed notice (it can't be
  dismissed), the exempt standby bucket, the battery exemption, usage access, and that Belay can't
  be uninstalled;
- the archival test's switch (T8, a Pixel test): neither image has Google Messages, so the
  debug-only switch must say so and set nothing (no archival configuration, no `READ_SMS`);
- that installing, updating and removing an app are noticed;
- the instrumented tests (below), and that they leave no global proxy behind;
- a restart: Belay comes back by itself, and its log survives; then `unprovision.sh`.

In CI it runs end to end with the server: `BELAY_E2E_SERVER`, `BELAY_E2E_CODE` and
`BELAY_E2E_STATUS` connect the phone (`provision.sh --server --code`) and let the test read the
server's view, and `BELAY_E2E_CLI` (the server's CLI) sets the rules. Then, in this order:

- **Phase 1:** the server has the phone's app list, with Belay as device owner, and the fixture
  app's install, update and removal.
- **Phase 2:** with new apps on "ask", the fixture app is suspended on install and the server has
  its request; a parent's "allow" lets it run within seconds (the long-poll), and "block" hides it.
- **Phases 6 and 10** (with `BELAY_E2E_UPDATE_APK` and `BELAY_E2E_UPDATE_CODE`): the build job's
  second debug APK of Belay (the same debug key, the next version code, and not test-only:
  `-PbelayVersionCode=<n> -PbelayTestOnly=false`, since Android never lets an app install a
  test-only APK through a session, platform notes I5) is added with `agent-add` and offered with
  `agent-offer`, and the phone updates itself and reports its signing certificate as apksigner
  prints it. The server's recovery key, typed on the phone through a debug-only receiver, opens
  repair access, and `remove-other-users` is reported done. Then the test-only build goes back on
  (`adb install -d`, allowed for a debuggable app), Belay leaves the offered version alone, and
  `unprovision.sh` can still release it.
- **Phase 3:** Android lists `force-lock` among Belay's admin policies; a 0-minute limit on the
  fixture app suspends it and removing it lets it run; a schedule on now (from the emulator's own
  clock and zone) suspends it, but not Belay or the dialer; a minute in the fixture app with
  measuring on reaches the server's usage for today (a debug-only receiver has Belay send at once
  instead of within 15 minutes); and `lock-now` is reported done with the screen off or locked.
- **Phases 4 and 7:** location on demand with `keep_on` grants Belay location by policy and sets
  `no_config_location`; with `adb emu geo fix -122.08 37.42` (the emulator's GNSS takes its fixes
  from the console; from inside the phone only a mock provider could set one, platform notes L9),
  `locate-now` gets a fix on the server at that point, not a mock, and the command is done;
  `LocationInstrumentedTest` runs with that point; a help request from a debug-only receiver
  reaches the server, and `help-seen` comes back to the phone; location off takes the permission
  away (Android restarts Belay, which comes back, L7); and with location off a kid's shared fix
  still gets into a help request, once.
- **Phase 5's calls** (on an image with telephony): `calls --mode contacts --unknown reject --log
  on` makes Belay the default dialer, reported as such; `CallsInstrumentedTest` checks the role,
  the call permissions granted by policy and other apps' `CALL_PHONE` denied; `adb emu gsm call`
  from a contact's made-up number rings Belay's own screen, and a `lock-now` sent while it rings is
  done at once, its lock waiting for the call to end and 2 minutes more; a call from another
  number is rejected without ringing and reaches the server's call records with that number (the
  contact's record has only its id); `block-number` puts a number on Android's block list and
  `unblock-number` takes it off; and `calls --off` gives the dialer back (on the ATD image, which
  has no preloaded dialer, to nobody, platform notes T15), and Belay comes back after Android
  restarts it, holding no `CALL_PHONE`.
- **Phase 3's network logging:** `network --on` turns Android's network logging on (its admin dump
  says so), and the phone reports it; the fixture app looks up a made-up name under `example.com`,
  `dpm force-network-logs` hands Belay the batch at once, and the server's network activity lists
  the fixture app with `example.com`. With `example.org` a private website, its lookups never reach
  the server, and Belay's log counts the lookups it didn't keep without naming one. `network --off`
  turns Android's logging off again (`dpm force-network-logs` then refuses), and the phone keeps
  nothing.
- **Phase 13:** `wifi-only` puts the fixture app on Android's list for Belay
  (`getMeteredDataDisabledPackages`, and `meteredDisabledPackages=[…]` in Android's admin dump),
  and the phone reports it; `wifi-only --remove` empties all three. `mobile-data --measure on` gets
  a day of mobile data use to the server, and `--measure off` leaves nothing unsent.
- **Phase 5, a restart:** with calls on and a PIN set on the emulator (`locksettings`), the phone
  restarts, and a call from a number that isn't a contact comes before the first unlock, when
  Belay can't decide it (it rings in the phone's own app). After the unlock (`locksettings
  verify`), Belay reads Android's call log, and the server has one record of that call, with no
  reason. The PIN comes off again.
- **Phase 12:** `caregiver-add` gives a made-up caregiver status, pause and help until three days
  on, and the phone lists them with exactly that, by its own clock. Then the caregiver's browser,
  played by curl with a cookie jar: they join with the one-time link and pause the phone from their
  page, with the form's CSRF token and a browser's Origin (one from another site is refused). The
  phone has the pause as theirs and holds the fixture app for it; `caregiver-end` takes them off
  the phone's list and signs them out, and a parent's `resume` ends their pause.
- **Phase 11:** `handover` reaches the phone, and its debug state shows the hand-over carried out:
  none of its locks held, and reset protection left alone (a debug build never sets it, and says
  so).

Every phone number is a made-up 555-01xx one: nothing ever calls or simulates 911 or 988. A part
the server doesn't have yet (an older server's status) is skipped, and the log says so.

The instrumented tests (`android/app/src/androidTest`, run with `am instrument`): Belay's Room store
and its migration from version 7 (`AgentStoreInstrumentedTest`, `MigrationInstrumentedTest`), the
inventory and the fixture app's three changes (`InventoryInstrumentedTest`,
`FixtureEventsInstrumentedTest`), Phase 2's enforcement (`EnforcementInstrumentedTest`, which sets
a global proxy from the shell for a few seconds, platform notes H2), screen time
(`ScreenTimeInstrumentedTest`), the self-update's install session, on the fixture app
(`SelfUpdateInstrumentedTest`), another user made with `pm create-user` and removed
(`OtherUsersInstrumentedTest`, emulators only), the kid's side (`KidSideInstrumentedTest`),
location (`LocationInstrumentedTest`, in CI's Phase 4 part), calls (`CallFlowInstrumentedTest`,
`LockedCallsInstrumentedTest`, and `CallsInstrumentedTest` in CI's calls part), network logging
(`NetworkLogInstrumentedTest`), mobile data (`MobileDataInstrumentedTest`) and the hand-over
(`HandoverInstrumentedTest`). Most set a policy in place of the server's
(`DebugTools.policyOverride`, debug builds only) and put the phone back afterwards. None sets the
factory-reset or debugging locks, or reset protection: debug builds refuse them.

The fixture app has one blank launcher screen (`.FixtureActivity`) from Phase 3, so tests can open
it, count it and see a limit or a schedule pause it; opened with the extra `lookup`, it looks a
made-up name up, for network logging. Screen time only counts while the screen is on and unlocked:
the tests wake the emulator and dismiss its swipe lock screen (`input keyevent KEYCODE_WAKEUP`,
`wm dismiss-keyguard`).

**`.github/workflows/server.yml`** (pushes touching `server/`): typecheck, lint, the build and the
tests (with the built `dist/`, so a test can check it holds no demo code); the Docker image, built
and run on amd64 and arm64 (its native modules load, it doesn't run as root, and a made-up phone
enrolls, checks in and gets a rule change); and Docker Compose as [server.md](server.md) has a
family use it: their settings outside the repository's files, an encrypted backup copied off the
machine, the machine lost, and the backup restored on a new one, where the phone checks in again
without enrolling.

**`.github/workflows/setup-kit.yml`** (pushes touching `setup-kit/`, or the provisioning plan and
its interpreters): the kit's typecheck, lint, tests and page bundle; `shellcheck`, and lib.sh's
interpreter on the plan's fixtures; and, informational for now, the ATD emulator provisioned with
the kit's command-line runner against a real server (`ci-kit-emulator-test.sh`), which checks the
end state `provision.sh` leaves, then unprovisions
([setup-kit.md](setup-kit.md#what-ci-checks-and-what-it-doesnt)).

**`.github/workflows/docs.yml`** (pushes touching any Markdown file): every relative link and
`#anchor` in the repository's Markdown resolves (`server/test/docs-links.test.ts`, which the
server workflow runs too, but only when `server/` changes).
