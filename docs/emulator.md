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

## Instrumented tests

Belay has to stay device owner while its tests run, so install the test APK and run it
with `am instrument`, not `connectedAndroidTest` (which tries to uninstall the app
afterwards, and a device owner can't be uninstalled):

```bash
(cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest)
android/scripts/provision.sh --debug --yes
adb install -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w family.brooker.belay.test/androidx.test.runner.AndroidJUnitRunner
```

The device-owner tests are skipped when Belay isn't device owner.

## What CI runs

`android/scripts/ci-emulator-test.sh <debug APK> <androidTest APK>` is the whole Phase 0
path: provisioning, the checks from [platform-notes.md](platform-notes.md) that can be
made from a shell (device owner, the notice's no-dismiss flag, the exempt standby bucket,
the bound `DeviceAdminService`, blocked uninstall), install/update/remove detection, the
instrumented tests, a restart, and unprovisioning. It refuses to run on anything but an
emulator. GitHub Actions runs it on every push that touches `android/`
(`.github/workflows/android.yml`).
