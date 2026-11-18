# Try Belay without a phone: the demo

`npm run demo` starts a Belay server on your own computer with a made-up family and a simulated
phone, so you can click through every parent page and connect Claude Code to it over MCP, with no
Android phone. It's for a parent whose Pixel isn't ready yet, a contributor who wants a server
with a week of data in one command, and a family deciding whether Belay is for them.

Nothing in it is real, and every page says so at the top: "Demo: a made-up family. Nothing here is
real." A screenshot of it can't pass for a real family's.

## Run it

You need Node 24 and a copy of this repository; no Android SDK, no Docker, no phone.

```bash
cd server
npm ci --ignore-scripts
npm run demo
```

It makes the family's week first, which takes a few seconds, then prints the parent page's address
(`http://localhost:8080`), the username (`demo`) and a password made for this run, and a line that
connects Claude Code (below). Open the address, sign in and look around. The terminal shows what
the simulated phone does as you change things. Ctrl-C stops the phone and the server.

- `npm run demo -- --port 8081` listens on another port. It always listens on this computer only
  (127.0.0.1), never on your network.
- `npm run demo -- --dir ~/belay-demo` keeps the demo in that directory, to come back to it with the
  same command. Each run makes a new password, and keeps the Claude Code token (a new one if the
  port changed); the phone comes back as if it had restarted.
- Both at once: `npm run demo -- --port 8081 --dir ~/belay-demo`.

Without `--dir`, everything goes in a new temporary directory, deleted when the demo stops. With
`--dir`, the demo uses a new or empty directory, or one it made before, and refuses any other
before it opens anything in it: a directory holding a Belay database it didn't make (a real
family's data directory, say) or any other files. It marks what it makes: a `belay-demo.json` file,
the same id in its database's settings, and a `.gitignore` that keeps git out of it.

It reads no `.env` and no `BELAY_*` settings from your environment (it says which it ignored): it
sets its own, `BELAY_PUBLIC_URL=http://localhost:8080` (or the port you gave), its directory,
`BELAY_HOST=127.0.0.1` and `BELAY_DEMO_BANNER=1`, which puts the banner on every page and changes
nothing else. Its daily backup has no passphrase, whatever your shell says.

## What's in it

All made up: the names, the apps (package names under `org.example.`, with no icons) and the phone
numbers (in North America's 555-01xx range, which is kept for fiction).

- **Jordan**, the parent (username `demo`), and **Robin**, the kid, with **Robin's phone**: a
  simulated phone ("Demo phone (simulated)", by a made-up maker called Example, on Android 17)
  with a made-up phone's own apps (`org.example.os.*`: the phone app, texting, Settings…) and
  Robin's apps, like Pebble Path, Comet Kart, Doodle Den and Trail Maps.
- **About a week of history**, as if Belay had been set up a week ago, in the evening: protection
  on (new apps wait for a parent, the web filter, the locked settings); the Starter stage, with an
  hour of games on school days and an hour and a half at the weekend, school from 8:30 to 3 on
  weekdays and bedtime from 9 to 7, which locks the screen; Explorer as the next stage, and the
  family's words for Off belay; screen time measured; the family agreement, which Robin agreed to;
  calls on, with four contacts, Jordan on the emergency card and calls recorded. Then the week:
  apps updating, a math app Robin asked for and Jordan approved, a video app Jordan declined and
  Robin removed, 15 more minutes of games given one evening, a restart, and a few calls.
- **Waiting for you:** Lantern Chat, a chat app Robin asked for, with why, and 30 more minutes of
  games.
- **Off, as for every new family:** location and network logging. You can turn them on, to see
  their pages; the simulated phone says it can't do them (below).
- **No caregivers.** Add one on the Caregivers page and open their link in a private window to
  see a caregiver's pages under `/care`, which carry the banner too; the terminal shows Robin's
  phone listing them, as the kid's screen does.

Times follow your computer's timezone, so school and bedtime are at your local times, and the Phones
page shows the phone checking in now.

## The simulated phone

`server/demo/phone.ts` is a client of the device API ([protocol.md](protocol.md)) that plays the
phone's side the way Belay's agent does on a real phone, with no Android behind it:

- It enrolled with a one-time code, sends its facts and health in a check-in every 2 hours, its app
  list every day and after a restart, and its changes and Robin's requests as they happen.
- It holds the policy long-poll, like the agent's service, so a parent's change reaches it within
  a second or two, and applies each policy the way the agent reports it: new apps waiting for a
  parent, blocked apps hidden, a pause, a schedule, a limit used up (each app held suspended, and
  how many), the answers to Robin's requests, the commands it ran (a lock now is done; removing
  other users is done, as it has none) and the version it applied. Then it checks in, so the
  phone's page says the rules are applied.
- Every 15 minutes it counts a few more minutes in an app that's open, most of the time (from 7 in
  the morning to 9 at night, never past a limit), and sends the day's screen time.
- Every minute it looks again at what its rules hold as the clock moves (school or bedtime
  starting or ending, a pause running out, a limit used up), says what changed, and checks in
  early, as the agent does, so the parent page shows it within a minute.
- The settings Belay locks, the web filter and Chrome's settings have nothing to show on a
  simulated phone: it takes them as applied, and reports no problem with them.

What it can't do, it says in its own words, as Belay on a real phone reports what it couldn't do:

- **Location:** it has no GPS. With location on, the phone's Location page shows what it says, and
  a check ("Check now") fails with it. The page waits its minute for an answer first, as it would
  for a real phone that can't find where it is.
- **Network logging:** it can't note which websites its apps look up, so it sends nothing: the
  phone's page shows that as a problem from the phone.
- **Updating Belay:** it can't install a new version, so an update offered to it fails.

There's no kid's screen: what Robin would see (an answer, a pause, "Time's up") is in the lines the
terminal prints. No new calls happen while it runs: the ones on the Calls page are the week's. A
parent who disconnects the phone on the parent page stops it for good, as a real one would be; give
`--dir` a new directory to start again.

Everything it sends is checked against the server's own schemas (`server/src/device/schemas.ts`) by
`server/test/demo-phone.test.ts` and `demo-family.test.ts`, so it never sends what a real phone
couldn't. `demo-main.test.ts` runs `npm run demo` itself: it signs in, approves the waiting app,
watches the phone apply it, connects over MCP with the printed token and presses Ctrl-C.

## Connect Claude Code

The demo prints a line like this, with a personal access token it made for the demo's parent
(Settings → AI access lists it as "Claude Code (demo)"):

```bash
claude mcp add --transport http belay-demo http://localhost:8080/mcp \
  --header "Authorization: Bearer belay_pat_…"
```

Run it, start Claude Code, and ask what you'd ask about your own kid's phone:

- "Is Robin's phone OK, and what's waiting for me?"
- "What did Robin install this week, and is any of it worth a look?"
- "Block Comet Kart." Tightening, so Claude does it, and the terminal shows the phone hide the
  app.
- "Allow Lantern Chat." Loosening, so it's only a proposal: it waits on the Proposals page until
  you approve it there.

As for any family, Claude reads apps, the phone's status, requests, screen time and the stage and
agreement; calls, location and network activity stay hidden from it until you turn them on in
Settings → "What AI apps may read". The name `belay-demo` keeps it apart from a real Belay you
connect as `belay`; `claude mcp remove belay-demo` takes it away.

**claude.ai and the Claude desktop app** connect only to a server on a public HTTPS address
([server.md](server.md)). The demo is on localhost over plain http, so it's Claude Code (or another
MCP client on the same computer). What Claude reads goes to Anthropic, as with a real server
([mcp.md](mcp.md)): here, only the made-up family.

## What it isn't

- **Not a server for a family.** It's on localhost over http: a real phone can't reach it, and
  claude.ai can't either. [server.md](server.md) is how to run the real one, and
  [guide.md](guide.md) the whole path with a phone.
- **Not a different Belay.** It's the family's server, with its own pages, MCP, rules and activity
  log: what you do goes through the same code a family's server runs (the demo's week went through
  it too, with a clock that ran from a week ago). Its daily backup goes in its directory.
- **Not in the server's build or image.** The demo lives in `server/demo/`, outside `src/`:
  `npm run build` compiles only `src/` (`tsconfig.build.json`), the Dockerfile copies only `src/`,
  and `.dockerignore` leaves `demo/` out of the image's build context. The only part of it in the
  server is `BELAY_DEMO_BANNER`, and all that does is the banner. `test/demo-build.test.ts`
  checks all three, and that nothing in `src/` imports the demo.
