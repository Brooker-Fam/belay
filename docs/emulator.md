# The emulator

Develop on the Android 17 emulator; prove things on the real Pixel 8
([phase0-checklist.md](phase0-checklist.md)).

## The image

Use **`system-images;android-37.0;google_apis;x86_64`** (or `arm64-v8a` on an Apple
silicon Mac). It's the newest Android 17 image with 4 KB memory pages, like the Pixel 8:
37.1 and 37.2 only come as 16 KB-page images (`_ps16k`).

- *Google APIs* has no Play Store, so Play Protect never interrupts. CI uses it.
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

`android/scripts/ci-emulator-test.sh <debug APK> <androidTest APK> [<fixture v1> <fixture v2>]`
is the whole path: provisioning, the checks from [platform-notes.md](platform-notes.md)
that can be made from a shell (device owner, the notice's no-dismiss flag, the exempt
standby bucket, the bound `DeviceAdminService`, blocked uninstall), install/update/remove
detection, the instrumented tests, a restart, and unprovisioning.

In CI it also runs end to end with a real server: the job starts one on the runner,
makes an enrollment code with its CLI, and sets `BELAY_E2E_SERVER`, `BELAY_E2E_CODE` and
`BELAY_E2E_STATUS`. `provision.sh` then connects the phone, and the test checks that the
server got the phone's app list, with Belay as device owner, and the fixture app's
install, update and removal. With `BELAY_E2E_CLI` (the server's CLI) it checks Phase 2's
rules, and with `BELAY_E2E_UPDATE_APK` and `BELAY_E2E_UPDATE_CODE` Phases 6 and 10: the
build job makes a second debug APK of Belay on the same runner (the same debug key) with
the next version code and not test-only (`-PbelayVersionCode=<n> -PbelayTestOnly=false`:
Android never lets an app install a test-only APK through a session, platform notes I5),
the server offers it and the phone updates itself; the server's recovery key, typed on the
phone through a debug-only receiver, opens repair access; and `remove-other-users` is
reported done. Then the test-only build goes back on (`adb install -d`, allowed for a
debuggable app), so `unprovision.sh` can still release it. Last, Phase 3, when the
server's status has `screen_time`: a 0-minute limit on the fixture app suspends it and
removing it lets it run, a schedule on now (from the emulator's own clock and zone) suspends
it but not Belay or the dialer, a minute in the fixture app with measuring on reaches the
server's usage for today (a debug-only receiver has Belay send at once instead of within 15
minutes), and `lock-now` is reported done with the screen off or locked.

The fixture app has one blank launcher screen (`.FixtureActivity`) from Phase 3, so tests can
open it, count it and see a limit or a schedule pause it. Screen time only counts while the
screen is on and unlocked: the tests wake the emulator and dismiss its swipe lock screen
(`input keyevent KEYCODE_WAKEUP`, `wm dismiss-keyguard`).

It refuses to run on anything but an emulator. GitHub Actions runs it on every push that
touches `android/` or `server/` (`.github/workflows/android.yml`), on two images:

- `system-images;android-37.0;aosp_atd;x86_64`, the Automated Test Device image (no Google
  services). It must pass.
- `google_apis`, closer to a phone. Informational for now (see platform-notes.md).

The test waits 45 seconds after boot first: the Google APIs image briefly has an account
right after boot, which makes `dpm set-device-owner` refuse.
