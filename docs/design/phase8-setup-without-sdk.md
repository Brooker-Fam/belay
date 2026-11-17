# Phase 8: setup without the Android SDK

**Status: design.** A new phase, from ROADMAP's "Later". Android and tool facts cite
[platform-notes-drafts.md](platform-notes-drafts.md) (X1) and the existing notes (P1 to P5).

## Goals

1. **A parent who isn't a developer can set up a phone** from desktop Chrome, without installing
   JDK, the Android SDK or adb.
2. **The same steps as `provision.sh`,** in the same order, with the same checks and messages, so
   the two can't drift.
3. **The signing key never touches the internet-facing server.**

Not goals: QR or zero-touch provisioning (blocked for unapproved controllers, P1); phones other
than the Pixel 8 class this project tests.

## What's possible

| Need | Fact | Notes |
|---|---|---|
| adb in a browser | Tango (ya-webadb): `@yume-chan/adb` 2.6.4 and `@yume-chan/adb-daemon-webusb`, MIT (X1) | Chromium-based browsers only; one program can hold the phone's ADB interface at a time, so a running adb server blocks it (X1). |
| Secure context | WebUSB needs https or localhost (X1) | A page from `http://localhost` works. |
| Device owner | `dpm set-device-owner` is a shell command (P2, P3) | Tango runs shell commands; untested. |
| Install | `pm install` streams over adb; adb installs allowlist restricted permissions (I4) | Same as `provision.sh` today. |
| Windows | WebUSB needs a WinUSB-compatible driver for the ADB interface | Unverified for the Pixel 8. |

The hard part isn't adb: it's the signed APK. A release build needs the family's own key (and from
Phase 9, its own application id), and building one needs JDK and the Android SDK.

## Design: a setup kit

A **Belay setup kit**, a container image the parent runs on their own computer (the same Docker
they use for the server):

```bash
docker run --rm -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys ghcr.io/…/belay-setup
```

- It holds JDK, the Android SDK and the Gradle build, pinned like CI's.
- **First run:** it makes the release key into the mounted folder (`make-release-key.sh`'s rules:
  never inside the repository, never overwrite), shows the certificate's SHA-256, and walks the
  parent through backing it up (docs/signing.md).
- **Build:** it builds and signs the release APK with that key, inside the container.
- **Provision:** it serves a page at `http://localhost:8090` (a secure context for WebUSB). The page
  uses Tango to connect to the phone over USB, runs the provisioning plan (below), and enrolls the
  phone with a code from the family's server, pasted or scanned from the "Add a phone" page.

The key stays on the parent's computer, in the folder they chose. The family's server never holds
it; that keeps a compromised server from signing a malicious update (Phase 6).

### One provisioning plan, two runners

`provision.sh` today is the single source of the steps and checks (accounts, users, the role
holder, install, `dpm set-device-owner`, grants, the battery exemption and its 8-second wait,
enroll with retries, restart). Phase 8 moves the *plan* into a data file,
`android/scripts/provision-plan.json`: each step's command, how to check its result, the message on
failure, and waits. `provision.sh` reads it (with a small interpreter in `lib.sh`), and so does the
setup kit's page. CI runs both runners against the emulator: the shell one as today, the browser
one with Tango under Node (Tango also runs in Node with the `usb` package, X1), so a change to one
step changes both.

### A server-hosted page (optional, later)

The parent page could offer "Set up a phone" in desktop Chrome, with the parent choosing the
signed APK from their own disk. It's simpler for parents who already built the APK, but a
compromised server could serve a page that installs a different app as device owner on a fresh
phone. If it's built, the page shows the APK's certificate SHA-256 and asks the parent to compare
it with the one they wrote down, and the setup kit stays the recommended path.

## Protocol

No change to the device API: enrollment uses the existing code flow (docs/protocol.md). The setup
kit never talks to the family's server itself: it hands the server's address and the code to the
phone, as `provision.sh --server --code` does (E1), and the phone enrolls.

## Privacy and transparency

No new data. The setup kit is local; the page loads nothing from the internet (Tango is bundled
in the image, with its MIT license in NOTICE).

## Threat model changes

| Who, what | With Phase 8 |
|---|---|
| A malicious page on the internet | Can't reach the phone: WebUSB asks the parent to pick the device, and the kit's page is on localhost. |
| A compromised family server | Never sees the key; the recommended kit doesn't depend on it. |
| A tampered setup image | Pin the image by digest in the docs; the build is reproducible from the repository's Dockerfile. |

## Test plan

- **Unit:** the plan interpreter in bash and TypeScript, on the same fixture plans and fake
  outputs.
- **CI:** the browser runner (Tango under Node) provisions the emulator from the plan; the shell
  runner does too; both reach the same end state, checked by `ci-emulator-test.sh`'s checks.
- **By hand:** desktop Chrome on Linux, macOS and Windows with a Pixel 8, from a factory-fresh
  phone.

## Decisions the family must make

1. Setup kit (recommended) or a server-hosted page.
2. Where the key folder lives on their computer, and its backups.

## Open questions

- Does Tango's shell and install path handle everything `provision.sh` does (the ordered broadcast
  reply from `am broadcast`, the reboot and reconnect)?
- Windows: does the Pixel 8's ADB interface bind to WinUSB without the Google USB driver?
- Is a container with the Android SDK acceptable to download (several GB)? A slimmer path: the kit
  downloads only the build tools it needs, pinned by hash.
