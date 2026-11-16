# The release key

Android only updates an app with an APK signed by the same key it was installed with,
and a device owner can't be uninstalled and reinstalled. So:

- **Lose the release key and every phone must be factory reset** to update Belay.
- **Change the application id** (`family.brooker.belay`) and Android sees a different
  app, which can't replace the device owner: factory reset again.

Both are permanent. Ask before changing either (CLAUDE.md).

Debug builds are signed with your computer's own debug key. That's fine: they're
test-only and `unprovision.sh` removes them. A release build is never signed with a debug
key: without the release key, Gradle produces an unsigned APK, and `provision.sh` refuses
release APKs signed with a debug key.

## Create it, once

```bash
android/scripts/make-release-key.sh            # default: ~/.config/belay
```

It creates `belay-release.p12` (PKCS12, RSA 4096, valid about 27 years; Android doesn't
check the expiry of app signing certificates) and `signing.properties`, which says where
the key is but holds no password. It refuses a directory inside the repository and
refuses to overwrite an existing key. It prints the certificate's SHA-256: keep a copy
(it isn't secret).

## Back it up, before using it

1. Copy `~/.config/belay/belay-release.p12` to two places that aren't this computer:
   for example an encrypted USB drive, and your password manager as an attachment.
2. Put the password in your password manager.
3. Once: restore on another computer and run `build-release.sh` to prove the backup works.

## Build a release

```bash
android/scripts/build-release.sh
```

It asks for the password (or reads `BELAY_STORE_PASSWORD`) and prints the APK's path and
certificate SHA-256. Gradle reads the key's location from
`~/.config/belay/signing.properties`, or from the file named in
`BELAY_SIGNING_PROPERTIES`. The key never enters the repository: `.gitignore` excludes
`*.p12`, `*.jks`, `*.keystore` and `signing.properties` anywhere, and CI builds release
APKs unsigned.

## Developer verification

From 2027, certified Android phones only install apps from registered developers, except
over adb ([platform-notes.md D1](platform-notes.md#d1-what-applies-and-when)). For a
family, the free **limited-distribution** account in the Android Developer Console fits:

1. Create the account (a Google account with 2-Step Verification, a payments profile and a
   contact email; no ID, no fee).
2. Register the package name `family.brooker.belay` with the release certificate's
   SHA-256 (the one `make-release-key.sh` printed).
3. Register each phone, one at a time: the phone scans a QR code or opens a link and
   shows a code you enter in the console. Unregistered phones can't install or update.
   The cap is 20 or 50 phones (Google's pages disagree).

The catch: a limited-distribution account only registers package names "that have never
been seen before on Android". Register before a release build goes on a Play-certified
phone; [phase0-checklist.md](phase0-checklist.md#2-register-the-package-name-first-recommended-your-call)
puts this before step 1. Otherwise, registering an existing package needs the full
account ($25 and ID) and a signed APK with an `assets/adi-registration.properties` proof.

## If the key is ever exposed

APK Signature Scheme v3.1 lets an app move to a new key: the old key signs a proof that
the new one replaces it. That needs the old key, so it helps if the key leaks, not if it's
lost. Back it up.
