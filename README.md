# Belay

Open-source, AI-first parental controls for a kid's first Android phone.

> A belayer doesn't climb for you. They hold the rope so a fall stays short, and they give
> more slack as you get better.

**Status: Phase 2, safe to hand over once it's checked on the real phone.** The phone
reports its apps to the family's own server, new apps wait until a parent approves them, the
web is filtered, and the settings that undo Belay are locked when a parent turns protection
on. A parent manages it by asking Claude or on the parent page. Locking factory reset and USB
debugging is a separate step a parent takes when ready. What a determined kid can still do is
in [docs/threat-model.md](docs/threat-model.md); [docs/phase2-checklist.md](docs/phase2-checklist.md)
is the real-phone check, and [ROADMAP.md](ROADMAP.md) has what comes next (screen time,
location, calls and texts, and more).

## What Belay is for

The model is Gabb's: parent-approved apps, approved contacts, no open web, and location.
But it runs on a regular used Pixel 8 and keeps its data on the family's own server, with
no monthly fee and no company that can change or disappear. A parent mostly manages it by
asking Claude (or any MCP client) things like "what did they install this week, and is it
OK?", with a web page as the fallback.

## What exists today (Phases 1 and 2, and part of 6)

- **`android/`: the device-owner agent.** Provisioned over adb, it becomes device owner and
  blocks its own uninstall. It always shows "This phone is managed by your parent", and its
  screen lists exactly what the parent can see. It notices app installs, updates and
  removals as they happen (with a full check after every restart and every day), records
  each app's source and sensitive permissions, and sends them to the family's server. It
  checks in every 2 hours. Changes wait in an outbox when the phone is offline. It enrolls
  with a one-time code: from `provision.sh`, a QR code, or typed. **Phase 2:** it enforces
  the family's rules within seconds of a change (a long-poll), and keeps enforcing them
  offline: new apps wait for a parent, blocked apps are hidden, the phone can be paused, and
  safe mode, new users, sideloading, VPNs, Private DNS, the clock and default apps are locked.
  Calls, texts, 911 and 988 always work. The kid sees every rule, asks for apps with a "Why I
  want it" box, and sees every answer. **Phase 6 (the phone's side):** it updates itself to
  the version a parent approved, without adb: downloaded (resuming), checked (Belay's own
  package, the offered and a newer version, exactly its own signing key) and installed
  silently as device owner, and the kid is told. Its Recovery screen takes the recovery key,
  offline, to open repair access (USB debugging and factory reset) for 24 hours if the
  server is ever gone. **Phase 10 (the phone's side):** it reports other users or profiles
  (Android's own Parental Controls make one) and restrictions it didn't set, and removes the
  others when a parent asks, telling the kid first. It reports the apps it never blocks, and
  a policy too big to read is a reported problem, not a silent one.
- **`server/`: the family's server.** Node and SQLite in one Docker image. The device API,
  the parent pages (phones and their health, apps with "new" badges and reviews, the
  timeline, adding a phone, settings, the activity log), and OAuth 2.1 plus MCP for Claude.
  **Phase 2:** each phone's rules (protection in one step, new apps ask or allow, allow or
  block per app, pause, web filter and Chrome, locked settings, maintenance, hardening), the
  kid's requests, AI proposals, and end-to-end encrypted Web Push to parents' browsers. Over
  MCP, an AI client can block an app or pause the phone; anything that loosens is only a
  proposal a parent approves on the parent page.
- **Phase 6, so far: backups that are proven to restore, and health monitoring.** The server
  backs itself up every day (the newest 14 kept, encrypted with the family's passphrase if
  they set one); `verify-backup` proves a backup restores, `restore` puts one back, and the
  parent page asks for a restore drill every 3 months. The server reports its own problems
  (disk space, a fast-growing database, failing backups, its clock, a database it can't
  open) on the parent page, over MCP and on `/healthz`, pushes the urgent ones to the
  parents, and sends an opt-in daily summary with counts only.
- **CI:** Android build, unit tests and lint, an Android 17 emulator job that provisions
  the agent and checks it end to end, and the server's tests and Docker image.
- **Docs:** [running the server](docs/server.md), [connecting Claude](docs/mcp.md),
  [privacy](docs/privacy.md), the [threat model](docs/threat-model.md), the
  [device API](docs/protocol.md), and [platform notes](docs/platform-notes.md): every
  Android behavior Belay relies on, checked against the docs and the Android 17 source.

## Principles

1. **The phone enforces; the AI advises.** Enforcement is plain, deterministic code on the
   phone and server. The AI reads, summarizes, researches and proposes.
2. **Loosening needs a person, out of band.** An AI client may tighten things directly.
   Anything that loosens is only a proposal until a parent taps Approve.
3. **Text from the kid or from app developers is untrusted data,** never instructions.
4. **Transparent to the kid.** Nothing is monitored in secret. The phone always says it's
   managed and lists exactly what the parent can see, generated from the code that collects it.
5. **Private by default.** All data stays on the family's server. No analytics, telemetry,
   ads, crash reporting, Firebase, Google Play services or ML Kit. The server never sends
   family data in readable form to anyone and never calls an AI: the parent's own MCP
   client is the only AI. (Push notifications to a parent's browser are end-to-end
   encrypted.)
6. **Silence is a signal.** A phone that stops checking in, stops being device owner or
   loses a permission is reported plainly.
7. **Built to loosen.** Rules relax as the kid shows they can handle it, and every
   decision keeps its reason.
8. **Respect the kid's private life.** No speculating about the kid from their app choices.
   Emergency numbers (911, 988) always work.
9. **Public-repo hygiene.** No secrets, keys, real device data or family details here.

## How it fits together

```
 Kid's phone (Pixel 8)                Family server                        Parent
┌─────────────────────────┐  HTTPS  ┌─────────────────────────┐  MCP   ┌─────────────────┐
│ Belay agent             │ ──────▶ │ Node + SQLite in /data  │ ◀───── │ Claude, or any  │
│ device owner            │ events, │ device API              │ OAuth  │ MCP client      │
│ inventory, changes,     │ app     │ parent pages            │        ├─────────────────┤
│ managed notice, outbox  │ lists   │ activity log            │ ◀───── │ parent page     │
└─────────────────────────┘ ◀────── └─────────────────────────┘  web   └─────────────────┘
                            policy (empty until Phase 2)
```

## Quickstart

**1. The server.** On a machine with a public HTTPS name ([docs/server.md](docs/server.md)
has the options):

```bash
cd server
cp Caddyfile.example Caddyfile          # put your server's name here and in docker-compose.yml
docker compose up -d --build
docker compose logs belay               # open the one-time setup link it prints
```

For development, without Docker: `cd server && npm ci --ignore-scripts && BELAY_PUBLIC_URL=http://localhost:8080 npm run dev`.

**2. A phone.** Start with the emulator ([docs/emulator.md](docs/emulator.md)). You need
JDK 21 and the Android SDK (platform 37.0). On the parent page, choose Add a phone, name
it, and run the command it shows:

```bash
cd android
scripts/provision.sh --debug --server https://belay.example.org --code 7KQ2M9XA
```

For a real Pixel 8, follow [docs/pixel.md](docs/pixel.md), then the
[Phase 0](docs/phase0-checklist.md) and [Phase 1](docs/phase1-checklist.md) checklists; a
release build needs the release key first ([docs/signing.md](docs/signing.md)).

**3. Claude.** Add a custom connector with the URL `https://belay.example.org/mcp`, sign
in, and approve ([docs/mcp.md](docs/mcp.md)). Then ask: "Is Sam's phone OK, and what did
they install this week?"

## Repository

| Path | What |
|---|---|
| `android/core` | Plain Kotlin: package records, inventory diffs, the reconcile plan, the device API types, the outbox policy. JVM tests. |
| `android/app` | The agent: device owner, receivers, services, sync, enrollment, the screens. |
| `android/scripts` | Provisioning, release key, QR test, the emulator test. |
| `server/` | The family's server: device API, parent pages, OAuth and MCP. Vitest tests. |
| `docs/` | [server](docs/server.md), [MCP](docs/mcp.md), [privacy](docs/privacy.md), [threat model](docs/threat-model.md), [device API](docs/protocol.md), [platform notes](docs/platform-notes.md), [emulator](docs/emulator.md), [Pixel 8](docs/pixel.md), [Phase 0](docs/phase0-checklist.md) and [Phase 1](docs/phase1-checklist.md) checklists, [signing](docs/signing.md), [prior art](docs/prior-art.md) |
| `ROADMAP.md` | Phases 2 to 5 and later. |
| `CLAUDE.md` | Conventions and commands, for people and for Claude. |

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Security issues:
[SECURITY.md](SECURITY.md).
