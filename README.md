# Belay

Open-source, AI-first parental controls for a kid's first Android phone.

> A belayer doesn't climb for you. They hold the rope so a fall stays short, and they give
> more slack as you get better.

**Status: Phase 1, monitoring only.** The phone reports its apps and their changes to the
family's own server, and a parent can ask Claude about them. Nothing is blocked yet: a kid
could still reset the phone, install anything and browse anything
([docs/threat-model.md](docs/threat-model.md)). Don't hand a phone running it to a kid as if
it were locked down. Phase 2 is the milestone where it becomes safe to hand over
([ROADMAP.md](ROADMAP.md)).

## What Belay is for

The model is Gabb's: parent-approved apps, approved contacts, no open web, and location.
But it runs on a regular used Pixel 8 and keeps its data on the family's own server, with
no monthly fee and no company that can change or disappear. A parent mostly manages it by
asking Claude (or any MCP client) things like "what did they install this week, and is it
OK?", with a web page as the fallback.

## What exists today (Phase 1)

- **`android/`: the device-owner agent.** Provisioned over adb, it becomes device owner and
  blocks its own uninstall. It always shows "This phone is managed by your parent", and its
  screen lists exactly what the parent can see. It notices app installs, updates and
  removals as they happen (with a full check after every restart and every day), records
  each app's source and sensitive permissions, and sends them to the family's server. It
  checks in every 2 hours. Changes wait in an outbox when the phone is offline. It enrolls
  with a one-time code: from `provision.sh`, a QR code, or typed.
- **`server/`: the family's server.** Node and SQLite in one Docker image. The device API,
  the parent pages (phones and their health, apps with "new" badges and reviews, the
  timeline, adding a phone, settings, the activity log), and OAuth 2.1 plus MCP for Claude.
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

For a real Pixel 8, follow [docs/pixel.md](docs/pixel.md) and
[docs/phase0-checklist.md](docs/phase0-checklist.md); a release build needs the release
key first ([docs/signing.md](docs/signing.md)).

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
| `docs/` | [server](docs/server.md), [MCP](docs/mcp.md), [privacy](docs/privacy.md), [threat model](docs/threat-model.md), [device API](docs/protocol.md), [platform notes](docs/platform-notes.md), [emulator](docs/emulator.md), [Pixel 8](docs/pixel.md), [Phase 0 checklist](docs/phase0-checklist.md), [signing](docs/signing.md), [prior art](docs/prior-art.md) |
| `ROADMAP.md` | Phases 2 to 5 and later. |
| `CLAUDE.md` | Conventions and commands, for people and for Claude. |

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Security issues:
[SECURITY.md](SECURITY.md).
