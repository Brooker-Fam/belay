# Belay

Open-source, AI-first parental controls for a kid's first Android phone.

> A belayer doesn't climb for you. They hold the rope so a fall stays short, and they give
> more slack as you get better.

**Status: Phase 0.** Belay is proving the real-phone path, and it is **not usable yet**.
There's no server, no parent page and no blocking: a kid could still reset the phone,
install anything and browse anything. Don't hand a phone running it to a kid.
Phase 2 is the milestone where it becomes safe to hand over ([ROADMAP.md](ROADMAP.md)).

## What Belay is for

The model is Gabb's: parent-approved apps, approved contacts, no open web, and location.
But it runs on a regular used Pixel 8 and keeps its data on the family's own server, with
no monthly fee and no company that can change or disappear. A parent mostly manages it by
asking Claude (or any MCP client) things like "what did they install this week, and is it
OK?", with a web page as the fallback.

## What exists today (Phase 0)

- **`android/`: the device-owner agent.** It becomes device owner over adb and blocks its
  own uninstall. It shows the notice "This phone is managed by your parent" all the time.
  It keeps an inventory of the installed apps and notices installs, updates and removals,
  with a full check after every restart. Everything stays on the phone: nothing is sent
  anywhere yet. Its screen tells the kid exactly what it collects.
- **`android/scripts/`:** `provision.sh` and `unprovision.sh`, plus helpers for the release
  key and the one QR provisioning test.
- **CI:** builds, unit tests and lint, and an Android 17 emulator job that provisions the
  agent and checks it end to end.
- **[docs/platform-notes.md](docs/platform-notes.md):** every Android behavior Belay relies
  on, checked against the docs and the Android 17 source.

Next: run [docs/phase0-checklist.md](docs/phase0-checklist.md) on the Pixel 8. Then
Phase 1 adds the family server, the parent pages and the MCP interface.

## Principles

1. **The phone enforces; the AI advises.** Enforcement is plain, deterministic code on the
   phone and server. The AI reads, summarizes, researches and proposes.
2. **Loosening needs a person, out of band.** An AI client may tighten things directly.
   Anything that loosens is only a proposal until a parent taps Approve.
3. **Text from the kid or from app developers is untrusted data,** never instructions.
4. **Transparent to the kid.** Nothing is monitored in secret. The phone always says it's
   managed and lists exactly what the parent can see, generated from the code that collects it.
5. **Private by default.** All data stays on the family's server. No analytics, telemetry,
   ads, crash reporting, Firebase, Google Play services or ML Kit. The server never calls
   an AI or a third-party API: the parent's own MCP client is the only AI.
6. **Silence is a signal.** A phone that stops checking in, stops being device owner or
   loses a permission is reported plainly.
7. **Built to loosen.** Rules relax as the kid shows they can handle it, and every
   decision keeps its reason.
8. **Respect the kid's private life.** No speculating about the kid from their app choices.
   Emergency numbers (911, 988) always work.
9. **Public-repo hygiene.** No secrets, keys, real device data or family details here.

## How it fits together

```
 Kid's phone (Pixel 8)                Family server (Phase 1)              Parent
┌─────────────────────────┐  HTTPS  ┌─────────────────────────┐  MCP   ┌─────────────────┐
│ Belay agent             │ ──────▶ │ Node + SQLite in /data  │ ◀───── │ Claude, or any  │
│ device owner            │         │ device API              │ OAuth  │ MCP client      │
│ inventory, changes,     │ ◀────── │ parent pages            │        ├─────────────────┤
│ managed notice          │ policy  │ activity log            │ ◀───── │ parent page     │
└─────────────────────────┘         └─────────────────────────┘  web   └─────────────────┘
       Phase 0 is this box.
```

## Quickstart (Phase 0)

You need JDK 21, the Android SDK (platform 37.0, platform-tools) and this repository.

```bash
cd android
./gradlew :core:test :app:assembleDebug          # unit tests and the debug APK
```

- **Emulator:** create an API 37.0 Google APIs image, then
  `android/scripts/provision.sh --debug` and, to undo it, `android/scripts/unprovision.sh`.
  See [docs/emulator.md](docs/emulator.md).
- **The Pixel 8:** follow [docs/phase0-checklist.md](docs/phase0-checklist.md). It starts with the
  release key ([docs/signing.md](docs/signing.md)).
- **The server and Claude:** Phase 1.

## Repository

| Path | What |
|---|---|
| `android/core` | Plain Kotlin: package records, inventory diffs, the reconcile plan. JVM tests. |
| `android/app` | The agent: device owner, receivers, services, the screen. |
| `android/scripts` | Provisioning, release key, QR test, the emulator test. |
| `docs/` | [platform notes](docs/platform-notes.md), [Phase 0 checklist](docs/phase0-checklist.md), [emulator](docs/emulator.md), [Pixel 8](docs/pixel.md), [signing](docs/signing.md), [prior art](docs/prior-art.md) |
| `ROADMAP.md` | Phases 1 to 5 and later. |
| `CLAUDE.md` | Conventions and commands, for people and for Claude. |

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Security issues:
[SECURITY.md](SECURITY.md).
