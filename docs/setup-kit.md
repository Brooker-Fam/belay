# The setup kit

Setting up a phone without installing a JDK, the Android SDK or adb (Phase 8,
[design](design/phase8-setup-without-sdk.md)). The kit is a container image you build and run
on your own computer. It makes your family's release key the first time, builds Belay and
signs it with that key, and serves a page at `http://localhost:8090`. In Chrome or Edge, that
page talks to the phone over the USB cable and takes it through the same steps, checks and
messages as [`provision.sh`](../android/scripts/provision.sh), because both run one plan,
[`provision-plan.json`](../android/scripts/provision-plan.json).

Already have JDK 21 and the Android SDK? `provision.sh` still works as it always has
([pixel.md](pixel.md), [emulator.md](emulator.md)).

## What you need

- A computer with Docker: Docker Desktop on macOS or Windows, Docker Engine on Linux. Give
  Docker at least 4 GB of memory (the Android build uses about that) and keep about 8 GB of disk
  free: the image holds a JDK, the Android SDK and the Gradle build (several GB), all downloaded
  once, when you build it.
- Chrome, Edge or another browser built on Chromium, on that computer. Firefox and Safari
  can't talk to USB devices (WebUSB), and no browser on an iPhone or iPad can.
- A USB cable that carries data, and the phone, freshly reset ([pixel.md](pixel.md)).
- A copy of this repository.

## Use it

```bash
docker build -f setup-kit/Dockerfile -t belay-setup .      # from the repository's root, once
mkdir -p ~/.config/belay                                    # the key's folder, yours
docker run --rm -it -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys belay-setup
```

1. **The first time, the key.** There's no key in the folder yet, so the kit makes one with
   [`make-release-key.sh`](../android/scripts/make-release-key.sh)'s rules (it runs that script):
   choose a password (at least 12 characters) and type it twice. It prints the certificate's
   SHA-256: write it down. Then back up the key and its password as [signing.md](signing.md)
   says (two copies of `belay-release.p12` away from this computer, the password in your
   password manager, and once, a test restore), and press Enter. The kit never overwrites a
   key: later runs use the one in the folder.
2. **The build.** It builds Belay and signs it with your key
   ([`build-release.sh`](../android/scripts/build-release.sh)), which asks for the key's
   password. It prints the certificate's SHA-256 again: it must be the one you wrote down.
3. **The page.** Open `http://localhost:8090` in Chrome or Edge on this computer and follow it:
   get the phone ready, check the app (its certificate's SHA-256, to compare with yours), paste
   the server's address and the code from the parent page's **Add a phone** (or leave them
   empty and connect the phone later from Belay's own screen), connect the phone, then **Check
   the phone first** (a dry run that changes nothing) and **Set up the phone**. It asks before
   making Belay the device owner, restarts the phone once, and ends with the same check as
   `provision.sh`. Press Ctrl+C in the terminal when you're done.

`docker run … belay-setup serve` only serves the page, and the page installs an APK you choose
(one you built before, with the kit or `build-release.sh`), again showing its certificate's
SHA-256 for you to compare.

The APK you choose can be a debug build too (`./gradlew :app:assembleDebug`), for a test phone.
The page says which it is: a test-only build, which
[`unprovision.sh`](../android/scripts/unprovision.sh) can remove without a reset, or a release
build, which only a factory reset removes.

## What stays on your computer, and why

- **The release key** (`belay-release.p12`, and `signing.properties`, which says where it is
  but holds no password) is only in the folder you give as `/keys`. The kit refuses to run
  without that folder (a key made inside the container would be lost when it stops) and refuses
  a folder that looks like a copy of the repository. The image is built without any key (its
  `.dockerignore` leaves out `*.p12`, `*.jks`, `*.keystore`, `signing.properties` and `.env`
  files), and the page never sees the key, only the signed APK.
- **The family's server never holds the key.** A phone updates Belay only with an APK signed by
  the key it was set up with (Phase 6), so whoever takes over the server still can't make the
  phones install anything but what you signed. The kit doesn't talk to the server at all: the
  phone enrolls itself with the address and code you paste, as `provision.sh --server --code`
  does.
- **The page's own adb key**, which the phone asks you to allow ("Allow USB debugging?"), is
  kept by the browser for `http://localhost:8090` (IndexedDB), as adb keeps `~/.android/adbkey`.
  Tick "Always allow from this computer" so the restart doesn't ask again.
- **Nothing goes to the internet while it runs.** The page is built into the image (Tango
  included), loads nothing from elsewhere, and only asks the kit for itself, the plan and the
  APK. The kit's server answers only requests addressed to `localhost` or `127.0.0.1` (so a
  website can't reach it through DNS rebinding), and `-p 127.0.0.1:8090:8090` keeps it off
  your network.
- **Building the image downloads**, from the publishers: the Node and JDK base images (pinned
  by digest), the Android SDK's command-line tools (pinned by SHA-256), the SDK platform and
  build tools (sdkmanager checks each against Google's checksum; the kit checks the revision),
  Gradle (the wrapper checks its SHA-256), the Android build's dependencies (versions pinned in
  `android/gradle/libs.versions.toml`) and the kit's npm packages (`package-lock.json`, with
  integrity hashes). Installing the SDK accepts the
  [Android SDK License](https://developer.android.com/studio/terms). No image is published:
  you build it from this repository's Dockerfile.

## Linux, macOS and Windows

**Linux.** Chrome needs permission to open the phone's USB device. Most distributions have a
package with the rules for Android phones (`android-sdk-platform-tools-common` on Debian and
Ubuntu, `android-udev-rules` on Arch). Without it, add `/etc/udev/rules.d/51-android.rules`
with `SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0660", TAG+="uaccess"` (18d1 is Google),
run `sudo udevadm control --reload-rules`, and plug the phone in again. Files the container
makes in your key folder are given to the folder's owner, so make the folder yourself first
(`mkdir -p ~/.config/belay`): if Docker makes it, root owns it.

**macOS.** No driver is needed. The image is built for x86_64 Linux (Google only makes the SDK's
build tools for it), so on Apple silicon Docker Desktop runs it under emulation: turn on "Use
Rosetta for x86_64/amd64 emulation" in Docker Desktop's settings; the build is slower.

**Windows.** Use Docker Desktop (WSL 2), and in PowerShell give the folder as
`-v "$env:USERPROFILE\.config\belay:/keys"`. On Windows, Chrome's WebUSB can only open a USB
interface that uses Windows' WinUSB driver. **Not checked yet for the Pixel 8** (platform notes
X1): if Chrome lists the phone but can't open it, try Google's
[USB driver](https://developer.android.com/studio/run/win-usb), which Google says adb needs on
Windows with Google devices. Windows lets only one program open the interface at a time: stop
adb (`adb kill-server`) and close Android Studio.

On every system, a running adb server holds the phone's ADB interface, and then the page can't
open it ("Another program on this computer is using the phone's USB debugging"): run
`adb kill-server`.

## The command-line runner

`node setup-kit/dist/run.js` runs the same plan with the kit's interpreter from a terminal,
talking to an adb server over TCP (Tango's client) instead of the browser: for CI and for
developers. It takes `provision.sh`'s options, plus `--apk APK`, `--adb-host`, `--adb-port` and
`--plan`, and prints what `provision.sh` prints, but for the two lines adb's own client adds
around an install's answer ("Performing Streamed Install", and "adb: failed to install …:").

```bash
cd setup-kit && npm ci --ignore-scripts && npm run build
adb start-server
node dist/run.js --debug --yes --server http://10.0.2.2:8080 --code 7KQ2M9XA
```

## One plan, two runners

[`android/scripts/provision-plan.json`](../android/scripts/provision-plan.json) is the only
place the steps are written down: each step's command, how its result is checked, what it says
when that fails, its waits and retries, and which steps only apply to a debug (test-only) build.
Two interpreters run it: [`lib.sh`](../android/scripts/lib.sh)'s, for `provision.sh` (bash 3.2
and later, no jq), and the kit's ([`setup-kit/src/plan/`](../setup-kit/src/plan)). Change a
step there and both runners change.

They're held to it by the same fixtures, [`android/scripts/plan-tests/`](../android/scripts/plan-tests):
each is a made-up phone (what adb answers to each command, and how that changes after a restart
or `dpm set-device-owner`), an APK (what the build tools say about it), and either
`provision.sh`'s arguments or a small plan of its own; `<name>.out` is what must be printed and
`<name>.calls` what adb must be asked, sleeps included.

- `android/scripts/test-plan.sh` runs them with `provision.sh` and lib.sh and fake `adb`,
  `aapt2`, `apksigner` and `sleep`. `test-plan.sh --against DIR` runs the provision fixtures with
  another version's `provision.sh`, comparing what it prints and its exit status: every fixture
  prints exactly what the `provision.sh` before the plan printed.
- The kit's tests run them with its interpreter: once with a fake phone, and once through
  Tango's real adb-server client, over TCP, to a fake adb server that answers for the fixture.
- `test-plan.sh --update` rewrites `.out` and `.calls` after a deliberate change; read the
  diff, then run the kit's tests too.

Where the runners differ, on purpose:

- **Finding the phone.** `provision.sh` and the command-line runner ask adb for its devices (the
  plan's `device` messages); the page asks the browser, and the parent picks the phone.
- **The APK.** lib.sh asks `aapt2` and `apksigner`, which also verifies the signature. The kit
  reads the package, the test-only flag and the signing certificate from the APK itself; it
  doesn't verify the signature, and Android does when it installs, refusing an APK that doesn't
  match the certificate it names.
- **A lost connection.** `provision.sh` carries on with adb's errors; the kit stops and says so.
- **The page's own words** around the plan's: titles for its parts (each top-level step's
  `page`), the question in a dialog, and "Warning:" where `provision.sh` prints "WARNING:".

### The plan's format

A plan is a JSON object: `format` (1), `package`, `admin`, `device.messages` (the four ways
finding the phone can fail), and `steps`. Keys are letters, digits and single underscores, and
strings don't use `\u` escapes, so lib.sh's JSON reader can read it; `note` fields are for
people.

Each step has a `kind`, optionally an `id` (reported as progress) and a `page` (its title on
the page), and `when` and `unless`: lists of conditions, all of which must hold (`when`), or not
all (`unless`). A condition is `[!]{a}[OP text]`: `{a}` alone holds when the variable isn't
empty; `=`, `!=`, `~` (contains) and `<` (a whole number below; empty counts as 0) compare it
with the text after them, which is a template too. Every text is a template: `{name}` becomes
that variable, in one pass, and other braces stay.

| Kind | What it does |
|---|---|
| `group` | Runs its `steps` (its `when` is read once, at the start). |
| `say` | Prints `text` at a `level`: `say` (the default), `info` (indented), `warn` or `err` (standard error); with a `prefix`, on each line. |
| `stop` | Stops with `message` (exit status 1). |
| `set` | Sets `var` to `value`. |
| `read` | Runs `run` (`adb shell`) and keeps its output `into` a variable: all of it, or only the number of lines with the text `count`, the lines with the text `lines` (re-indented by `indent`), or a `tally` of an expression's first group. `stderr` is `drop`, `merge`, or left alone. |
| `check` | `run` on the phone, or a `value`, against `contains`, `matches` (an extended regular expression; for a command, line by line) or `equals`, then its `pass` or `fail` steps; `into` is 1 or empty. For a command, `contains` and `matches` also need exit status 0. |
| `wait` | Up to `tries` times, `run` it and check; `every` seconds between. |
| `run` | A command that changes the phone; with `quiet`, its output is hidden. A dry run only prints it; if it fails, the run ends with its exit status. |
| `change` | Like `run`, but its output is shown and checked: no line matching `success` runs the first of `failures` whose `contains` is in it. |
| `install` | `adb install` with `args` (each when its own `when` holds) and the APK, checked like `change`. |
| `confirm` | Asks `text`; anything but yes stops with `no`. Not asked with `{dry_run}` or `{assume_yes}`. |
| `sleep` | Waits `seconds`. |
| `reboot` | `adb reboot`, then waits for the phone to come back. |
| `broadcast` | An ordered broadcast (`am broadcast`) whose answer is `Broadcast completed: result=…, data="…"`: tries again while the result has `retry.contains`, then runs the first of `outcomes` whose `prefix` and `contains` fit, with `{data}` kept `into` a variable. |
| `apk` | What the build tools say about `{apk}`: `{apk_found}`, `{apk_package}`, `{test_only}` (yes, no or unknown), `{signer}`, `{signer_sha256}`, `{signer_dn}`, `{signer_tool}`. |
| `device` | Finds the phone (`{serial}`, if given, or the only one), or stops with the plan's `device` messages. |
| `exit` | Ends the run with `code`. |

The runners set `{apk}`, `{server}`, `{code}`, `{serial}`, `{dry_run}`, `{assume_yes}` and
`{reboot}` from their options, and `{package}` and `{admin}` from the plan. A regular expression
must read the same in POSIX extended syntax (bash, grep) and JavaScript: literal characters,
`.`, `[...]` without POSIX classes, `* + ? {m,n}`, groups, `|`, `^`, `$`, and `\` before
punctuation.

## What CI checks, and what it doesn't

CI (`.github/workflows/setup-kit.yml`) runs the kit's typecheck, lint, tests and page bundle,
shellcheck and both interpreters on the fixtures, and, as an informational job, provisions the
Android 17 emulator (`aosp_atd`) with the command-line runner, against a real Belay server,
checks the end state `provision.sh` leaves (device owner, Belay's foreground service, the
battery exemption, usage access, the exempt standby bucket, the enrollment) and unprovisions.
The Android workflow's emulator job, with `provision.sh`, stays the required one.

Not checked by CI: WebUSB itself (no browser can reach the emulator's USB), the page's
reconnection after the restart, Windows' driver, and a real Pixel 8. The by-hand check, from a
factory-fresh Pixel 8 with desktop Chrome on Linux, macOS and Windows, is in the
[design](design/phase8-setup-without-sdk.md#test-plan).
