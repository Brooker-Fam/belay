# Phase 0 checklist: the real-phone path on the Pixel 8

Phase 0 asks one question before anything else is built: does a Google-certified Pixel 8
on Android 17 accept Belay as device owner over adb, keep it there, and let a parent-owned
Google account use the Play Store next to it?

Record what you see in the table at the end of [platform-notes.md](platform-notes.md#phase-0-results),
or paste it to Claude. Write Android's messages word for word. No screenshots in the
repository, and no account names or serial numbers.

**Stop condition:** if the phone blocks the adb-provisioned device owner too (step 1 or
step 2), stop there. The plan changes.

## What you need

- The Pixel 8, with nothing on it you need: it gets factory reset twice.
- A computer with JDK 21, the Android SDK (platform 37.0, build-tools, platform-tools for
  `adb`) and this repository. `export ANDROID_HOME=...` if the SDK isn't in `~/Android/Sdk`.
- A USB-C data cable.
- About an hour in total, spread over two days.

## Before you start: two decisions

### 1. The release key (required)

The release build you install today is signed with the key that every later update must
use. Create it once:

```bash
android/scripts/make-release-key.sh      # writes ~/.config/belay/, outside the repository
```

Back it up before going further: the `.p12` file in two places that aren't this computer,
and its password in your password manager. [signing.md](signing.md) explains why.

### 2. Register the package name first (recommended; your call)

Developer verification (worldwide in 2027) will need `family.brooker.belay` and the key's
SHA-256 registered in the Android Developer Console. The free limited-distribution account
only registers package names "that have never been seen before on Android", and Play
Protect looks at every app installed on a Play-certified phone. To keep the free option,
register before step 1. You need a Google account with 2-Step Verification; it doesn't
have to be the phone's account.
[platform-notes.md D1](platform-notes.md#d1-what-applies-and-when) and
[signing.md](signing.md#developer-verification) have the details. If you skip this,
registration may later need the paid account ($25 and ID).

## Step 1: provision with adb, release build (about 20 minutes)

1. **Factory reset:** Settings > System > Reset options > Erase all data (factory reset).
   If the phone's line is an eSIM, keep it: don't tick the option to erase eSIMs.
2. **Setup wizard:** connect to Wi-Fi. **Skip the Google account** ("Skip", then "Skip"
   again if asked). A screen lock is fine; you'll unlock once after the restart in 5.
   Accept or decline the rest as you like.
3. **USB debugging:** Settings > About phone > tap Build number 7 times. Then
   Settings > System > Developer options > USB debugging on. Plug the phone in, unlock it,
   tap Allow on "Allow USB debugging?".
4. **Build and check:**
   ```bash
   android/scripts/build-release.sh          # asks for the key's password
   android/scripts/provision.sh --dry-run    # checks everything, changes nothing
   ```
   The dry run prints the phone's model and Android version, the APK's certificate
   SHA-256 (compare it with the one `make-release-key.sh` printed), and stops with a clear
   message if anything isn't ready (an account, a second user, an existing owner).
5. **Provision:**
   ```bash
   android/scripts/provision.sh
   ```
   It asks once before making Belay device owner: a release build can then only be removed
   by a factory reset. It installs, runs `dpm set-device-owner`, grants usage access and
   the battery exemption, opens Belay, then restarts the phone once. Unlock the phone after
   the restart.

**Record:**
- Any Play Protect prompt on the phone during the install, word for word, and what you
  tapped. (None is a result too.)
- The `dpm set-device-owner` line of the output (`Success: Device owner set to …`, or the error).
- The "Result" lines at the end.
- The Android build: Settings > About phone > Android version > Build number.

## Step 2: device owner and the managed notice; then leave it a day

Right after step 1:

1. **Open Belay.** Under *Setup checks*, every line should have a check mark:
   device owner, can't be uninstalled, the managed notice can show, both permissions
   "locked by policy", battery not restricted, usage access, background service running.
   *Standby bucket* should say "exempted". Note any ✗.
2. **The notice:** pull down the notification shade. "This phone is managed by your
   parent" should be there. Try to swipe it away (it should stay). Long-press it: there
   should be no way to turn it off. Settings > Notifications > App notifications > Belay:
   the switches should be greyed out (this needs the restart from step 1).
3. **Quick Settings > Active apps** (the button at the bottom of the expanded Quick
   Settings): Belay should be listed **without** a Stop button.
4. **Settings > Apps > Belay:** Force stop and Uninstall should be greyed out; Storage &
   cache > Clear storage greyed out.
5. **What Android says itself:** the Quick Settings footer, and Settings > Security &
   privacy (look for "managed" or "organization"). Write down the wording.
6. **Optional, from the computer:**
   ```bash
   adb shell dpm list-owners
   adb shell am get-standby-bucket family.brooker.belay      # 5 = exempted
   adb shell dumpsys deviceidle whitelist | grep belay
   adb logcat -d -s Belay
   ```

**Then leave the phone for about a day**, on Wi-Fi, used a little or not at all, overnight
included. After that:

7. **Play Protect:** Play Store > profile icon > Play Protect. Any warning about Belay?
   Any Play Protect notification since yesterday? Word for word.
8. **Belay:** still "set up on this phone"? Setup checks still all ✓? Under *Background
   checks*, note how often the hourly check really ran overnight (gaps of several hours
   mean Doze held it back; that's expected and useful to know).

## Step 3: the parent-owned Google account, Play, and a restart

1. **Create a Google account that you, the parent, own**, just for this phone. Not your
   main account (its mail and photos would be on the kid's phone), and not a child
   (Family Link) account, which very likely can't sit next to a device owner
   ([platform-notes.md A1](platform-notes.md#a1-family-link-child-account-next-to-a-device-owner)).
2. **Add it:** Settings > Passwords & accounts (the exact name varies) > Add account > Google.
   Note any message about the phone being managed.
3. **Install** one small free app from the Play Store.
   - Belay > *Recent app changes* should show "Installed · <the app>", "noticed right away",
     and "from Play Store".
   - Optional: `adb shell dumpsys package <its package name> | grep -iE "installer|packageSource"`.
     The Play Store's raw install-source values aren't documented; this records them.
4. **Uninstall it** (long-press the icon > Uninstall). Belay should show
   "Removed · <the app>", "noticed right away".
5. **Restart the phone** (hold power > Restart) and unlock it. Without opening Belay, the
   notice should come back by itself. Then open Belay: both changes still listed, and
   *Background checks* shows "phone started".

## Step 4: try QR provisioning once (about 20 minutes)

This records whether Google blocks it. Belay doesn't depend on it.

1. **Put the release APK somewhere the phone can download it over HTTPS.** For example,
   attach `android/app/build/outputs/apk/release/app-release.apk` to a GitHub release of
   this repository. The APK holds nothing secret: anyone can already build the same
   code, and only your key can sign it.
2. **Make the QR code:**
   ```bash
   android/scripts/qr-payload.sh android/app/build/outputs/apk/release/app-release.apk https://<the APK's URL>
   ```
   It checks that the URL serves the same file, then writes `belay-provisioning.json`
   (and a PNG if `qrencode` is installed).
3. **Factory reset from Settings, not from recovery mode:** Settings > System > Reset
   options > Erase all data. A reset from Settings doesn't trigger factory reset
   protection; one from recovery mode would ask for the Google account from step 3.
4. On the welcome screen, **tap the same spot 6 times**. A QR reader opens (it may ask for
   Wi-Fi first). Scan the code.
5. **Record exactly what happens.** Expected: "App blocked to protect your device", or
   similar. If it provisions instead, note every screen; that would be news.

## Afterwards

- To keep using the phone for development: factory reset from Settings and do step 1
  again (a debug build with `provision.sh --debug` is easier to undo:
  `unprovision.sh` releases it without a reset).
- To return it to normal: factory reset from Settings ([pixel.md](pixel.md#returning-the-phone-to-normal)).
- Send the results; Phase 1 starts from them.
