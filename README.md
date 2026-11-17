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

## What exists today (Phases 1 and 2, and parts of 3, 4, 5, 6, 7, 8, 10 and 11)

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
  a policy too big to read is a reported problem, not a silent one. **Phase 3 (the phone's
  side):** when the family turns screen time on, the phone counts how long each app is on
  the screen from Android's usage events, and enforces daily limits (per app, per group, or
  a daily total) and school, bedtime and custom schedules by itself, offline too, on time
  with exact alarms; "lock now" and a bedtime that locks the screen. The kid sees time left,
  warnings, "Time's up" with "Ask for more time", self-serve minutes when allowed, their
  stage and what the next one changes, and the family agreement to agree with or talk about.
  If usage access is turned off, apps with a limit pause (or stay open, as the family
  chooses) and the kid is told how to turn it back on. Only while a parent has measuring on,
  each day's usage goes to the server; "What your parent can see" says so the moment it's on.
  **Phase 4 (the phone's side):** location is off by default, and Belay holds the location
  permission only while a parent has it on (granted and denied by policy, never by the kid). On
  demand, a parent's check (or their AI app's, named to the kid) takes one fix from the phone's
  GPS within a minute; periodic mode adds a fix every 15 to 120 minutes within set hours, sooner
  near a place's edge, and "arrived" and "left" for the family's places, worked out on the phone;
  lost mode puts the parent's message on the lock screen, locks it once and takes a fix every 5
  minutes. `keep_on` keeps location on. Single fixes, never a stream, and no Play services code.
  The kid gets a notification for every check and sees each one in "What Belay told your parent".
  **Phase 7 (the phone's side):** Belay's screen becomes the kid's app: Home says the phone's state
  in one line and what works now, with "I need help" (one tap tells the parents, with where the
  phone is only if the kid chooses to share it, once, even with location off) and an emergency
  card (911 and 988, call or text, the parents' numbers and Android's own emergency information)
  that work while the phone is paused; My requests shows every answer and lets the kid change or
  take back a waiting one; "Talk to my parent"; what the parent and their AI app can see; and what
  Belay told the parent, from the phone's own record.
- **`server/`: the family's server.** Node and SQLite in one Docker image. The device API,
  the parent pages (phones and their health, apps with "new" badges and reviews, the
  timeline, adding a phone, settings, the activity log), and OAuth 2.1 plus MCP for Claude.
  **Phase 2:** each phone's rules (protection in one step, new apps ask or allow, allow or
  block per app, pause, web filter and Chrome, locked settings, maintenance, hardening), the
  kid's requests, AI proposals, and end-to-end encrypted Web Push to parents' browsers. Over
  MCP, an AI client can block an app or pause the phone; anything that loosens is only a
  proposal a parent approves on the parent page. **Phase 3:** each phone's screen-time rules
  (limits, schedules, exempt apps, self-serve, and measuring, which only a parent turns on),
  stages the family writes and moves a phone through, the family agreement, the kid's
  requests for more time (answered with 15, 30 or 60 minutes), lock now, and each phone's
  screen time by the hour and by day, drawn on the server with a table beside each chart.
  Usage is kept 13 months by default. Over MCP, an AI client reads screen time, locks the
  phone and tightens the rules; the server decides whether a change only tightens, and
  anything else, or a move to another stage, is a proposal.
- **Phases 4 and 7 on the server: location, and the kid's side.** Location is off until a
  parent turns it on, on the phone's Location and help page: on demand (a parent's "Check
  now", which waits for the phone's fix) or every 15 to 120 minutes within set hours, with
  the family's places, arrivals and departures (pushed to the parents if they ask), keeping
  location on, the provider (GPS only by default), and lost mode. A fix is described by the
  family's places ("At School, within 40 m"), worked out on the server, with an "Open in a
  map" link only the parent's browser follows: no map, tile or address service is ever
  called. The server keeps only what the rules asked for, for days, not months. "I need
  help" pushes to every parent at once and stays at the top of the Requests page, with
  Call and where the phone was if the kid shared it, until a parent marks it seen, which the
  kid's phone shows; "Talk to my parent" and withdrawing a request too. The policy tells the
  phone which data the parents' AI app may read, and the numbers for its emergency card.
  Over MCP, an AI client reads location only if a parent turns that on (it starts off), may
  check where the phone is (the kid sees every check), and never changes any of it.
- **Phase 5 on the server: calls.** Calls are off until a parent turns them on, on the
  phone's Calls page; then the phone's policy makes Belay its phone app. The family decides who
  can call (anyone, or only contacts, and what happens to callers who aren't contacts or have no
  caller ID), whom the kid can call, quiet times at bedtime and school, and whether calls are
  recorded; the contacts (parents always ring and are on the kid's emergency card), private
  numbers Belay never records, and blocked numbers. 911, every emergency number and 988 always
  work, in the phone's own code: the server refuses to block one and never keeps a record of
  one. Recent calls (only while recorded, 90 days by default) have "Add as contact" and "Block";
  the kid's "Please add this contact" comes to the Requests page. Over MCP, an AI client reads
  calls and other people's numbers only if a parent turns that on (it starts off), may tighten
  the rules, and proposes anything else; it never turns calls on, records them or answers a
  request.
- **Phase 6, so far: backups that are proven to restore, and health monitoring.** The server
  backs itself up every day (the newest 14 kept, encrypted with the family's passphrase if
  they set one); `verify-backup` proves a backup restores, `restore` puts one back, and the
  parent page asks for a restore drill every 3 months. The server reports its own problems
  (disk space, a fast-growing database, failing backups, its clock, a database it can't
  open) on the parent page, over MCP and on `/healthz`, pushes the urgent ones to the
  parents, and sends an opt-in daily summary with counts only.
- **Phases 6 and 10 on the server: updates, the recovery key, other users.** A parent offers
  a phone a newer Belay (added to the server with `agent-add`), and its page shows how the
  update goes, with a notice if it fails and a flag if the phone goes quiet after it; the
  server pins Belay's signing certificate. Each phone gets a recovery key, shown once, that
  lifts the factory reset and debugging locks offline if the server is ever lost. When
  another user or profile appears (Android's own Parental Controls make one), the phone's
  page says so and a parent can remove it. AI clients can only read these.
- **Phase 11: off belay, both sides.** Every family's stage list ends with Off belay, which
  blocks nothing; the kid's "My stage" shows it last from the first day, with the family's words
  for when it comes, and says so once Belay really blocks no app or website. A parent can stop
  collecting each kind of data on a phone's page, which deletes what the server keeps of it after
  a confirmation that lists exactly what goes, and can hand the phone over (after typing its
  name): the server lifts the locks on factory reset, debugging and accounts and clears reset
  protection, and the phone, which then holds none of them, shows the kid what to back up, to
  remove the parent's account, and to reset it from Settings. A release build clears its reset
  protection policy itself; nothing in it switches Belay off: the reset does. Then the parent
  disconnects the phone and deletes everything about it. AI apps can do none of this, not even
  as a proposal. The Pixel checklist, ending in a reset and a setup with the kid's own account, is
  [docs/phase11-checklist.md](docs/phase11-checklist.md).
- **`setup-kit/`: setting up a phone without the Android SDK (Phase 8).** A container you
  build and run on your own computer: it makes the family's release key (once, in a folder of
  yours), builds and signs Belay, and serves a page on `localhost` that sets up the phone from
  Chrome over USB (WebUSB, with Tango). `provision.sh` and the kit run the same provisioning
  plan, held to the same fixtures; not yet tried with a real Pixel 8.
- **CI:** Android build, unit tests and lint, an Android 17 emulator job that provisions
  the agent and checks it end to end, the server's tests and Docker image, and the setup
  kit's tests, with an informational emulator job that provisions with the kit's runner.
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

**2. A phone.** Two ways, with the same steps and checks (one plan,
[`provision-plan.json`](android/scripts/provision-plan.json)):

- **The setup kit, without the Android SDK** ([docs/setup-kit.md](docs/setup-kit.md)): with
  Docker and Chrome or Edge on your computer. It makes your family's release key the first
  time (kept in the folder you give it, never on the server), builds and signs Belay, and
  serves a page on `http://localhost:8090` that sets up the phone over USB.

  ```bash
  docker build -f setup-kit/Dockerfile -t belay-setup .      # from the repository's root
  mkdir -p ~/.config/belay
  docker run --rm -it -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys belay-setup
  ```

- **With the Android SDK** (JDK 21 and platform 37.0): start with the emulator
  ([docs/emulator.md](docs/emulator.md)). On the parent page, choose Add a phone, name it,
  and run the command it shows:

  ```bash
  cd android
  scripts/provision.sh --debug --server https://belay.example.org --code 7KQ2M9XA
  ```

For a real Pixel 8, follow [docs/pixel.md](docs/pixel.md), then the
[Phase 0](docs/phase0-checklist.md) and [Phase 1](docs/phase1-checklist.md) checklists; a
release build needs the release key first ([docs/signing.md](docs/signing.md)), which the
setup kit makes for you.

**3. Claude.** Add a custom connector with the URL `https://belay.example.org/mcp`, sign
in, and approve ([docs/mcp.md](docs/mcp.md)). Then ask: "Is Sam's phone OK, and what did
they install this week?"

## Repository

| Path | What |
|---|---|
| `android/core` | Plain Kotlin: package records, inventory diffs, the reconcile plan, the device API types, the outbox policy. JVM tests. |
| `android/app` | The agent: device owner, receivers, services, sync, enrollment, the screens. |
| `android/scripts` | Provisioning (its plan, `provision-plan.json`, and the plan's fixture tests), release key, QR test, the emulator tests. |
| `setup-kit/` | Setting up a phone without the Android SDK: the plan's second interpreter, the page, the container ([docs/setup-kit.md](docs/setup-kit.md)). Vitest tests. |
| `server/` | The family's server: device API, parent pages, OAuth and MCP. Vitest tests. |
| `docs/` | [server](docs/server.md), [MCP](docs/mcp.md), [privacy](docs/privacy.md), [threat model](docs/threat-model.md), [device API](docs/protocol.md), [platform notes](docs/platform-notes.md), [emulator](docs/emulator.md), [Pixel 8](docs/pixel.md), [Phase 0](docs/phase0-checklist.md), [Phase 1](docs/phase1-checklist.md), [Phase 2](docs/phase2-checklist.md), [Phase 3](docs/phase3-checklist.md), [Phase 4](docs/phase4-checklist.md), [Phase 6](docs/phase6-checklist.md), [Phase 7](docs/phase7-checklist.md) and [Phase 11](docs/phase11-checklist.md) checklists, [signing](docs/signing.md), [prior art](docs/prior-art.md) |
| `ROADMAP.md` | Phases 2 to 5 and later. |
| `CLAUDE.md` | Conventions and commands, for people and for Claude. |

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Security issues:
[SECURITY.md](SECURITY.md).
