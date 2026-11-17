# Phase 6 and 10 checklist: updates, the recovery key, other users

CI proves the phone's side on the Android 17 emulator (a debug build updates itself, the
recovery key opens repair access, `remove-other-users` runs). This checklist is for the real
Pixel 8 with the **release** build: what only a real phone, the family's real signing key
and Google's services can show. Do [phase2-checklist.md](phase2-checklist.md) first.

Record what you see in the table at the end. Write Android's messages word for word. No
screenshots in the repository, and no account names, phone numbers or serial numbers.

## 1. The signing key the server pins

1. On the family's computer: `apksigner verify --print-certs` on the release APK the phone
   runs. Note the "certificate SHA-256 digest".
2. On the phone's page (or `node dist/cli.js status --json`): `agent_signing_sha256` is the
   same digest.

## 2. Belay updates itself

1. Raise `versionCode` in `android/app/build.gradle.kts`, then `scripts/build-release.sh`.
   Add it to the server with `agent-add` (the parent page doesn't upload APKs), then offer it
   to the phone on its page (Updating Belay) or with `agent-offer` ([server.md](server.md#updating-belay)).
2. Watch the phone's update state: downloading, checking, installing, then the phone checks
   in from the new version and the state is done. Note how long it took, on Wi-Fi.
3. On the phone: Android's own notice (AOSP says "Updated by your admin."), and Belay's
   "Belay was updated to version … by your parent." Write both down word for word. Nothing
   asks anyone to confirm.
4. **Developer verification:** if Android refuses the install, the phone reports Android's
   message word for word (platform notes I3). Write it down. The way out is
   `provision.sh` in maintenance mode, over adb.
5. Once on cellular, with Wi-Fi off: offer the next version, and turn mobile data off for
   a minute while it downloads. When data is back, the download goes on from where it
   stopped (Belay's log: "downloaded").
6. Belay's screen, About Belay: the version is the new one.

## 3. The recovery key

Hardening must be on (factory reset and USB debugging blocked, phase2-checklist.md §6), or
the key has nothing to open. **Don't factory reset the phone during this test.**

1. On the parent page, make a recovery key, and keep it as you would for real (printed, or
   in a password manager). The phone's rules are applied within a minute.
2. Turn the phone's Wi-Fi and data off: the key works without the server.
3. Belay > About Belay > Recovery. Type a wrong key three times: the first two say how
   many tries are left, the third says to wait a minute. The right key during the wait is
   refused too ("There were too many wrong tries…"), and a fourth wrong try after it makes
   the wait two minutes.
4. After the wait, type the right key: "That's the key. Repair access is open until …".
   "This phone's rules" say repair mode is on. Settings > System > Developer options lets
   USB debugging on, and `adb devices` sees the phone; Settings > System > Reset options is
   no longer greyed out. Don't use it.
5. Type the same key again: "This recovery key was already used on this phone."
6. Turn data back on: the phone's page shows the key used, until when, and asks for a new
   key.
7. The next day (after 24 hours): USB debugging and reset are locked again.

## 4. Android's own Parental Controls (Phase 10)

1. Settings: is there a "Parental controls" entry on this device-owner phone? Write down its
   exact name and where it is (provision.sh's message names "Settings > Parental controls").
2. If it's there, set it up with a PIN. Within a minute the phone's page shows another user
   or profile (`other_users` 1), and any restriction it set that Belay didn't
   (`foreign_restrictions`, like `no_factory_reset`). Write them down.
3. Block an app in Android's controls that Belay allows, and allow one Belay blocks: Belay
   puts its own back, and reports it.
4. On the parent page, remove the other users. On the phone: "Your parent is removing
   Android's own Parental Controls from this phone, because Belay does that job." The
   phone's page shows the command done and `other_users` 0. What does Settings' entry show
   afterwards?

## 5. provision.sh on a phone with Android's Parental Controls (optional)

Only on a phone you'll reset anyway: before provisioning, set up Android's Parental
Controls, then run `provision.sh --dry-run`. It stops with "Android's own Parental Controls
are set up on this phone. Turn them off in Settings > Parental controls, then run this
again." Check that the words match the real entry's name.

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 1 | `agent_signing_sha256` matches apksigner's digest of the release APK | pending | |
| 2 | Offered update installed with no prompt; time on Wi-Fi | pending | |
| 2 | Android's notice and Belay's, word for word | pending | |
| 2 | Developer verification: accepted, or Android's exact refusal | pending | |
| 2 | A download cut on cellular resumed | pending | |
| 3 | Three free wrong tries, then the wait; the right key refused during it | pending | |
| 3 | The key offline: repair mode shown; USB debugging and reset unlocked | pending | |
| 3 | The same key refused again; the use on the parent page | pending | |
| 3 | Locked again after 24 hours | pending | |
| 4 | Settings' entry for Parental controls on a device-owner phone: name and place | pending | |
| 4 | other_users and foreign_restrictions with it set up | pending | |
| 4 | Removed on a parent's request; the kid's notice; Settings afterwards | pending | |
| 5 | provision.sh's message, and whether it names the entry right | pending | |
