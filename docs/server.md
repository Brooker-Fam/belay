# Running the Belay server

The server keeps the family's data, talks to the phones, serves the parent pages and the
MCP interface. One server is for one family. It's a single Docker image with a SQLite
database in `/data`.

Setting Belay up for the first time? [guide.md](guide.md) is the whole path for a parent, from
a used Pixel 8 to the first day and the years after, and links back here for the details.

It needs a **public HTTPS address**:

- the phone reaches it over cellular, not only at home;
- claude.ai connects to it from the internet;
- Android 17 enforces Certificate Transparency, so the certificate must come from a public
  CA (Let's Encrypt is fine). Self-signed certificates don't work.

The server makes two kinds of outbound requests, and no others:

- it reads the client metadata document of an allowlisted AI client (claude.ai's) when a
  parent connects it, with no family data in the request;
- if a parent turned on [notifications](#notifications), it sends them to the push service
  of that parent's browser, end-to-end encrypted, so the push service can't read them.

It never calls an AI or any other API.

## Option 1: a small VPS with Caddy (simplest)

Any small Linux VPS with Docker works (1 GB of memory is plenty).

1. Point a DNS name at the VPS, for example `belay.example.org`. Open ports 80 and 443.
2. Get the repository and go to `server/`:
   ```bash
   git clone https://github.com/brooker-fam/belay.git && cd belay/server
   cp Caddyfile.example Caddyfile
   ```
3. Put your name in `Caddyfile`, and the same name in a file called `.env` next to
   `docker-compose.yml`:
   ```bash
   echo BELAY_PUBLIC_URL=https://belay.example.org > .env
   ```
4. Start it, and read the one-time setup link from the log:
   ```bash
   docker compose up -d --build
   docker compose logs belay
   ```
5. Open the link (it works once, for 24 hours) and create the first parent account. You
   can invite a second parent from Settings.

Caddy gets and renews the certificate on its own. `Caddyfile` and `.env` stay out of git:
they name your server. **Don't edit `docker-compose.yml`:** your own changes (the backup
passphrase, a tunnel instead of Caddy) go in `docker-compose.override.yml` next to it, which
Docker Compose reads with it and git ignores, so [upgrading](#upgrades) is always a plain
`git pull`.

## Option 2: a computer at home, behind a tunnel

If the server runs at home (a mini PC, a NAS, a Raspberry Pi 4 or 5), don't open ports on
the home router. Use a tunnel that gives it a public HTTPS name:

- **Cloudflare Tunnel** (`cloudflared`): free with a domain on Cloudflare. Point a
  hostname at `http://localhost:8080` (or `http://belay:8080` in compose). Cloudflare
  terminates TLS, so it can see the traffic.
- **Tailscale Funnel:** `tailscale funnel 8080` gives `https://<machine>.<tailnet>.ts.net`
  with a Let's Encrypt certificate, and TLS ends on your machine.

Put the tunnel's address in `.env` (`echo BELAY_PUBLIC_URL=https://<the tunnel's name> > .env`),
and in `docker-compose.override.yml`, next to `docker-compose.yml`, leave Caddy out and
publish port 8080 on this machine only:

```yaml
services:
  belay:
    ports: ["127.0.0.1:8080:8080"]
  caddy:
    profiles: ["caddy"]   # not started: the tunnel is the one proxy in front
```

`BELAY_TRUST_PROXY` stays `1`: the tunnel is the one proxy in front. Then
`docker compose up -d --build`.

The phone always uses the public name, at home too, so it never needs the local-network
permission for this. (Belay pre-grants `ACCESS_LOCAL_NETWORK` anyway, for servers on the
home network; see docs/platform-notes.md.)

## Settings

| Variable | Default | What |
|---|---|---|
| `BELAY_PUBLIC_URL` | (required) | The public origin, like `https://belay.example.org`: no path. Phones, QR codes, OAuth and MCP use it. Plain `http` is refused except for localhost and private addresses, for testing. |
| `BELAY_DATA_DIR` | `/data` in the image, `./data` otherwise | Where `belay.db` lives, and `agents/`: the versions of Belay added for updates. |
| `BELAY_HOST` | `0.0.0.0` in the image, `127.0.0.1` otherwise | Address to listen on. |
| `BELAY_PORT` | `8080` | Port to listen on. |
| `BELAY_TRUST_PROXY` | off | `1` when exactly one reverse proxy (Caddy, a tunnel) is in front: client addresses for rate limits then come from the last `X-Forwarded-For` entry. Leave it off if clients can reach the server directly, or they could pretend to be anyone. |
| `BELAY_EXTRA_REDIRECT_URIS` | none | More OAuth redirect URIs to allow, comma-separated and exact, for MCP clients other than Claude. They get no refresh tokens. |
| `BELAY_BACKUP_PASSPHRASE` | none | Encrypts the daily backups with this passphrase, at least 15 characters ([Encrypted backups](#encrypted-backups)). Without it they're plain SQLite files. Prefer the `_FILE` form. |
| `BELAY_BACKUP_PASSPHRASE_FILE` | none | A file that holds the passphrase instead, like a Docker secret (`/run/secrets/belay_backup`); a final new line is ignored. Set one of the two, not both. |

The family's timezone, the silent threshold, what AI apps may read, how long screen time,
where the phone was, call records, network activity and the activity log are kept (the activity
log 400 days by default, at least 30), which map site "Open in a map" goes to, the numbers on
the kid's emergency card, notifications and the daily summary are set on the Settings page, not
here.

## Notifications

Off until a parent turns them on. Without them, a request from the kid shows on the parent
page (Requests in the menu shows how many are waiting) and through MCP.

**Turning them on:** Settings → Notifications → Turn on notifications on this browser, on
each browser where a parent wants them. The page registers a small service worker
(`/sw.js`) that shows each notice and opens the page it's about when tapped. Settings lists
each parent's own browsers, and Remove stops one; Send a test notice checks them. On an
iPhone or iPad, iOS only delivers notifications to web apps on the Home Screen: open the
parent page in Safari, choose Share → Add to Home Screen, open Belay from the Home Screen,
and turn them on there (iOS 16.4 or later).

**When:** when a phone sends a new request (one notice for the requests in one call), and
when an AI app proposes a change. Not again when a request is sent a second time, or the
same change is proposed again while it waits, and at most six notices an hour about one
phone: past that, requests and proposals still show on the parent page. Also when something
is urgent with the server itself ([Health monitoring](#health-monitoring)): at once, then at
most once a day while it lasts.

**"I need help"** (Phase 7) is urgent: each help request goes to every parent's browsers at
once, apart from the six-an-hour limit (its own limit is 20 an hour per phone, for a flood),
with Web Push's high urgency, and stays on the screen until the parent acts on it. It says
`Sam's phone needs help: "I'm lost"` (the kid's words, if any, and whether they shared where
the phone is: never where it is) and opens the Requests page. It goes again when the kid adds
words or where the phone is to a help request no parent has seen yet.

**Arrivals and departures** (Phase 4), for a place a parent asked to hear about:
`Sam's phone arrived at School`, with the time when the phone sent it late, at most one per
place and direction every 10 minutes. It opens the phone's Location page.

**The daily summary:** Settings → Notifications → Daily summary. Off by default: each
parent turns it on for themselves, and the hour (7 PM by default, in the family's timezone)
is the family's. Once a day at that hour it says what needs you, like "3 things need you: a
phone has been silent 14 hours, a request is waiting, the last backup failed", or "Nothing
needs you today." It has counts and kinds of problems only: no phone's or app's name,
nothing the kid wrote, and nothing Belay on the phone said in its own words. A server
that's down for that whole hour skips the day rather than send it late.

**What is sent, and to whom:**

- A short notice goes to the push service of every browser a parent turned on: Apple
  (`web.push.apple.com`) for Safari, Google (`fcm.googleapis.com`) for Chrome and most
  Android browsers, Mozilla (`updates.push.services.mozilla.com`) for Firefox, Microsoft
  (`*.notify.windows.com`) for Edge. The push service passes it to the browser. The server
  accepts no other address when a browser subscribes, sends to no other host, and never
  follows a redirect.
- The notice is the phone's name and the app's name or the proposed change, like
  `Sam's phone: "Chatter Box" is waiting for you` or
  `Sam's phone: Claude proposes resuming the paused phone`, and which page to open
  (Requests or Proposals). A request for more time names the limit and quotes the kid's
  reason, like `Sam's phone asks for 15 more minutes for Games: "One more level, please"`,
  and so does wanting to talk about the family agreement. Notices about the server and the
  daily summary name no phone or app, and open the Phones page. Each is encrypted for that browser (RFC 8291, `aes128gcm`):
  only the browser can read it, not the push service.
- The push service does see the browser's subscription address, when each notice is sent
  and how long it is, the server's VAPID public key, and a token signed with it (RFC 8292)
  that names the push service, expires within 12 hours, and contains the server's address
  (`BELAY_PUBLIC_URL`). A notice waits at the push service for up to a day while the browser
  is offline.

The server makes its VAPID key pair the first time it's needed and keeps it in the database
(so backups hold it); the private key never leaves the server. When a push service says a
browser's subscription is gone (404 or 410), the server deletes it. Sending never holds up
the phone's request that caused it: each push service gets 5 seconds, and a failure is
logged without the browser's address.

## Admin commands

Run them where the server runs:

```bash
docker compose exec belay node dist/cli.js setup-link             # a new one-time setup link (before the first parent exists)
docker compose exec belay node dist/cli.js create-code "Sam's phone"   # an enrollment code, without the web page
docker compose exec -it belay node dist/cli.js reset-password sam # asks for a new password; signs that parent out everywhere
docker compose exec belay node dist/cli.js backup /data/belay-backup.db   # a backup now; --encrypt seals it (Backups, below)
docker compose exec belay node dist/cli.js verify-backup /data/backups/belay-2026-11-17.db.enc   # proves a backup restores
docker compose exec belay node dist/cli.js restore-drill                  # the restore drill's steps, for the newest backup
docker compose exec belay node dist/cli.js status                 # each phone: status, apps, rules, requests, latest changes (--json for scripts)
```

And for a phone's rules, as the parent page sets them:

```bash
docker compose exec belay node dist/cli.js protect "Sam's phone"                       # turn protection on
docker compose exec belay node dist/cli.js policy "Sam's phone" --new-apps ask         # or allow
docker compose exec belay node dist/cli.js decide "Sam's phone" com.example.app allow  # or block, or undecided
docker compose exec belay node dist/cli.js pause "Sam's phone" --minutes 30            # without --minutes: until resumed
docker compose exec belay node dist/cli.js resume "Sam's phone"
```

The first time `--new-apps ask` (or `protect`) turns asking on, every user app already on the
phone is allowed. Later, after new apps were allowed for a while, it allows the apps
installed meanwhile and leaves the ones that were waiting before waiting, as the parent page
does by default. `--allow-waiting` allows those too; `--hold-new` keeps the apps installed
meanwhile waiting as well.

And for Belay itself on a phone (Phase 6 and 10), each a parent's action, never an AI app's:

```bash
docker compose exec -T belay node dist/cli.js agent-add - --version-code 4 --version-name 0.4.0 < belay-0.4.0.apk   # prints the SHA-256
docker compose exec belay node dist/cli.js agent-offer "Sam's phone" <sha256>   # offer that version to the phone
docker compose exec belay node dist/cli.js recovery-key "Sam's phone"           # a new recovery key: shown only now
docker compose exec belay node dist/cli.js remove-other-users "Sam's phone"     # remove every other user and profile
```

And at the end (Phase 11), a parent's action, never an AI app's:

```bash
docker compose exec belay node dist/cli.js handover "Sam's phone"   # hands the phone over to the kid (Off belay, below)
```

And for screen time (Phase 3), as the phone's Rules and Screen time pages set it:

```bash
docker compose exec belay node dist/cli.js limit "Sam's phone" com.example.game --minutes 60 --name Games   # a daily limit for one app
docker compose exec belay node dist/cli.js limit "Sam's phone" '*' --minutes 120              # a daily total for every app
docker compose exec belay node dist/cli.js limit "Sam's phone" com.example.game --remove
docker compose exec belay node dist/cli.js schedule "Sam's phone" --name Bedtime --start 21:00 --end 07:00 --lock   # every day unless --days mon,tue,…
docker compose exec belay node dist/cli.js schedule "Sam's phone" --remove <id>
docker compose exec belay node dist/cli.js lock-now "Sam's phone"                    # locks the screen once, if the phone gets it within 10 minutes (--minutes)
docker compose exec belay node dist/cli.js screen-time "Sam's phone" --measure on    # or off: whether the phone sends how long apps are used
docker compose exec belay node dist/cli.js network "Sam's phone" --on                # or --off: whether the phone notes which websites and services its apps look up
docker compose exec belay node dist/cli.js answer "Sam's phone" <request id> approve --minutes 15   # or decline, or talk; --note "…"
```

`limit` sets the limit that names only that app (or the daily total), so running it again
changes it; `schedule` adds a custom schedule (`--allow` lists apps that stay open, comma
separated; times are the phone's). Times like `21:00` to `07:00` end the next day.

And for location and the kid's side (Phases 4 and 7), as the phone's Location and help page
sets them:

```bash
docker compose exec belay node dist/cli.js location "Sam's phone" --mode periodic --every 30 --hours 07:00-21:00 --keep-on on   # or --mode off|on_demand; --provider gps|fused; --fallback on|off; --hours all
docker compose exec belay node dist/cli.js place "Sam's phone" --name School --lat 40.1 --lng -73.2 --radius 150 --notify arrive,leave   # prints only its id
docker compose exec belay node dist/cli.js place "Sam's phone" --remove <id>
docker compose exec belay node dist/cli.js locate-now "Sam's phone"            # a check now; prints only the command's id, and doesn't wait
docker compose exec belay node dist/cli.js lost "Sam's phone" --message "This phone is lost. Please call" --number 555-0100
docker compose exec belay node dist/cli.js lost "Sam's phone" --off
docker compose exec belay node dist/cli.js help-seen "Sam's phone" <request id>   # "I've seen it"; --note "…" goes to the phone
docker compose exec belay node dist/cli.js parent-number "Sam's phone" --name Mom --number +15555550100   # or --remove Mom
docker compose exec belay node dist/cli.js kid-number "Sam's phone" +15555550123   # for "Call"; --clear
```

`location` changes only what it's given (at least one flag). `place` with a name the phone
already has changes that place, keeping its id; `--notify` is `arrive`, `leave` or both (none
by default). `locate-now` refuses while location is off. `parent-number` gives the phone its
own list for the emergency card, starting from the family's numbers, and changes the number of
the one with that name.

And for calls (Phase 5), as the phone's Calls page sets them:

```bash
docker compose exec belay node dist/cli.js calls "Sam's phone" --mode contacts --unknown voicemail --withheld reject --outgoing contacts --quiet on --log on   # turns calls on
docker compose exec belay node dist/cli.js calls "Sam's phone" --off
docker compose exec belay node dist/cli.js contact "Sam's phone" --name Mom --number +15555550100 --parent   # prints only its id; --calls on|off, --texts on|off
docker compose exec belay node dist/cli.js contact "Sam's phone" --remove <id>
docker compose exec belay node dist/cli.js block-number "Sam's phone" +15555550199     # unblock-number to undo
docker compose exec belay node dist/cli.js private-number "Sam's phone" +15555550177   # --remove <number> to undo
docker compose exec belay node dist/cli.js answer "Sam's phone" <request id> approve --name "Coach Lee" --texts off   # a contact request
```

`calls` turns calls on with `--mode` (`open`: anyone can call; `contacts`: only contacts), and
once they're on changes only the rules it's given (`--unknown` and `--withheld` are `reject`,
`voicemail` or `ring`; voicemail unless given). It says on stderr when a number on the
emergency card isn't a contact, since with only contacts that parent's calls would follow
`--unknown`. `contact` with a name the phone already has adds the number to that contact,
keeping its id; calls and texts are on unless turned off, and a parent only with `--parent`.
Numbers are E.164 (`+`, the country code, the number). `block-number` refuses 911, 988 and
every emergency number, a contact's number, one on the emergency card and a private one, with
why.

They're logged as the server's ("The server" on the Activity page), and a running server
passes them to the phone within a second or two. `status --json` gives each phone's
`policy_version` (the server's), `enforcement` (what the phone last said it applied, exactly
as it sent it, or `null`), `requests` (`[{id, kind, package, status, reason}]`, with
`limit_id`, `minutes` and `given_minutes` for more time, `version` and `answer` for the
agreement), `agent_version_code` and `agent_signing_sha256` (as the phone reported them),
`agent_update` (the offer, and what the phone said about it), `recovery` (`{version,
last_used}`: the key version the policy carries, or `null`), `commands` (the latest, with
their results), `screen_time` (the policy's screen-time rules, or `null` while the phone has
none) and `usage` (the days the phone sent, newest first, at most 31: `[{day, zone, as_of,
screen_minutes, apps: [{package, minutes, opens}]}]`). Phase 4 adds `location` (the policy's,
`null` until a parent first sets it), `fixes` (newest first, at most 50: `[{id, at, lat, lng,
accuracy_m, provider, reason, command_id, mock}]`) and `place_events` (newest first, at most
50: `[{id, place_id, place_name, kind, at, fix_id}]`), their times as the phone sent them
(milliseconds since the epoch). Phase 7 adds `help` and `talk` entries to `requests` (help
ones with `seen_at`, in the family's timezone, `seen_by`, and `location`, the fix the kid
shared: `{id, at, lat, lng, accuracy_m, mock}` or `null`), `withdrawn_at` (as the phone sent
it) on any request the kid withdrew, and the policy's `help_seen`, `parent_numbers` and
`ai_reads`. Phase 5 adds the policy's `calls` (`null` while calls are off), `contacts`,
`private_numbers` and `blocked_numbers`, and `call_records` (newest first, at most 50: `[{id,
at, direction, contact_id, number, duration_s, outcome, reason}]`, `at` as the phone sent it),
and `contact` entries in `requests` with `contact_name`, `contact_number` and `contact_id` (the
contact an approval added, or the one that had the number; `null` until approved). Phase 11
adds `handover` (`{at, by, version}` or `null`: when, as the policy has it in milliseconds since
the epoch, the parent's name or `null` from the CLI, and the rules version that carried it).
Network logging adds `network_log` (the policy's: `{enabled}`) and `network` (the days the phone
sent, newest first, at most 31: `[{day, zone, as_of, entries: [{package, domain, lookups}],
dropped}]`, `as_of` as the phone sent it).
Hardening (factory reset, debugging, reset protection, and the accounts Play may use) can only
be turned on on the parent page; `handover` lifts it, as the phone page's "Hand this phone over"
does.

For scripts: `agent-add` prints only the APK's SHA-256 (lowercase) on stdout,
`recovery-key` prints only the key, grouped like `7KD2M-8Q4ZX-1HNP3-RT6VW-B9CF0G`,
`limit`, `schedule`, `lock-now`, `place`, `locate-now` and `contact` print only the id of the
limit, schedule, place, command or contact, and `handover` prints one sentence; everything else
goes to stderr. They exit 1 with a reason on stderr when they can't.

Outside Docker, use `npm run cli -- <command>` from `server/`.

## Updating Belay

Phase 6 updates Belay on the phones from this server, so a phone whose debugging is locked
doesn't need a computer and maintenance mode for each new version.

1. Build the release APK on the family's computer, with the family's key: the setup kit
   ([setup-kit.md](setup-kit.md#save-a-copy-of-this-app)), which keeps a copy of each build in
   the key's folder, named with its version code, or `android/scripts/build-release.sh`. Both
   print the version code, next to the certificate's SHA-256 and the file's. The signing key
   never leaves that computer ([signing.md](signing.md)).
2. Add it on a phone's page: under **Updating Belay**, **Add a version of Belay** takes the
   APK file, its version code and, if you like, its version name, as the build printed them.
   The page after it shows the file's SHA-256 and the version, with **Offer it to** the phone.
   Adding is a parent's action, never an AI app's, and the activity log keeps it.
   - Or with the server's command line: `agent-add <apk> --version-code <n> [--version-name
     <name>]` (or `-` to read the APK from stdin, as above).

   Either way the server streams the file into `agents/<sha256>.apk` in its data directory
   (written to a temporary file while it's hashed, at most 100 MB, then renamed; the same file
   added again is kept once, and it can't be added with another version code) and records the
   version given. It doesn't parse the APK beyond checking that it starts like a zip file. The
   page reads its upload as it arrives, with a limit of its own (100 MB and 64 KB) where the
   other parent pages take 64 KB, so a proxy in front must let a request that large through
   (Caddy does). The server keeps the 10 versions added last, and any version offered to a
   phone however old: adding an eleventh deletes the oldest of the rest, file and all, so the
   versions never take more than about a gigabyte.
3. Offer it to a phone: the button after adding it, the phone's page (Updating Belay), or
   `agent-offer`. The policy then carries `agent_update`, while the phone runs an older version
   code; the page warns when the phone already runs that version or a newer one, which Android
   won't replace.
4. The phone downloads it (`GET /api/v1/agent/<sha256>.apk`, only the file offered to that
   phone, resumable), checks that it's Belay, newer, and signed with the same certificate,
   and installs it. The phone's page shows each step it reports. If it fails, the parents get
   a notice, the page shows what Belay on the phone said, and the phone can still be updated
   over adb in maintenance mode. A phone that goes quiet within an hour of updating is
   flagged.

The server pins the first signing certificate each phone reports (`agent_signing_sha256`); a
different one later shows as a sign of tampering. Reconnecting a phone with a new code pins
again. Android doesn't install an older version over a newer one, so a version with a problem
is fixed with a newer one.

Backups hold the database, not the APK files: keep each release APK on the family's computer,
where it was built (the setup kit keeps them in the key's folder), and add it again after a
restore if a phone still needs it.

## The recovery key

If this server is ever lost, a phone with factory reset or debugging locked could be stuck:
Belay keeps both locked offline, and a factory reset from recovery mode then needs the
parent's Google account. The recovery key gets around that: typed on the phone (Belay's screen,
About Belay, then Recovery), it lifts both locks for 24 hours, with no server, so the phone can
be repaired or reset from Settings. It works once.

- The server makes one the first time a parent turns on factory reset or debugging for a
  phone that has none, and shows it once: print it, or keep it in a password manager. The
  phone's page has "Make a new recovery key" (the earlier one stops working once the phone has
  the new check), and so does `recovery-key`, with or without the locks on.
- The policy carries only a check of the key (a salted SHA-256, `recovery` in
  docs/protocol.md); the server keeps only that check too, never the key.
- When the phone reports a use of its current key, the server records it, once, the parents
  get a notice ("Sam's phone reports the recovery key was used on it"), and the phone's page
  asks for a new key. It's the phone's word: if no one in the family used the key, the phone
  may be out of the family's hands. A report about an earlier key changes nothing.
- AI apps see only whether a phone has a key, and when one was last used.

## Other users and profiles (Phase 10)

Android's own Parental Controls, in Settings, add a hidden profile, even though Belay locks
adding users. Belay on the phone counts the users and profiles besides the kid's own, and the
phone's page says so at the top, with "Remove other users and profiles": the phone removes
every one, with everything in it, when it gets that, if that's within 7 days. The page shows
whether it was done, couldn't be, or expired. It also lists the user restrictions in force that
Belay didn't set.

## Screen time, stages and the agreement (Phase 3)

Off until a parent sets a limit or a schedule, or turns measuring on: until then the policy's
`screen_time` is `null`, and the phone counts nothing. The phone counts and enforces by
itself, offline too; the server keeps the rules and what the phone reports.

- **Rules** (a phone's Screen-time rules tab): daily limits (one app, a group, or a daily total of every
  app), school, bedtime and custom schedules, apps never counted or paused, self-serve minutes
  the kid may take without asking, what happens when Belay can't count (pause the apps with a
  limit, the default, or keep them open), the warning before a limit or schedule, extra time
  for today, the time zone the phone's days follow (its own, by default) and when they start,
  and a preview of a day under the rules. **Measuring** is there too: whether the phone sends
  how long apps are used. Only a parent turns it on or off; without it the phone still keeps
  the limits, and the server keeps no minutes.
- **Screen time** (a phone's Screen time tab): a day by the hour and the last seven days,
  with the apps that took the time and the times Belay couldn't count, each chart with a table
  of the same numbers; **Lock now**, a pause of 15 minutes to 4 hours and the screen locked
  once if the phone gets it within 10 minutes; and the kid's requests for more time,
  answered with 15, 30 or 60 minutes, "Let's talk" or "No". Approving gives the minutes for
  that limit today, in the phone's day.
- **Stages** (in the menu): the family's numbered sets of rules. A phone on a stage gets its
  rules with the phone's own changes on top (Rules marks them, and "Put back all of the
  stage's rules" drops them); a change to a stage reaches every phone on it at once; moving
  a phone to a stage starts it on exactly that stage's rules. The kid's screen shows what the
  next stage changes, in sentences the server writes from the two sets of rules, and how to
  get there, in the family's words.
- **Agreement** (a phone's Agreement tab): the family agreement in sections. Each save is a
  new version, agreed by the parents as they save it. The kid answers on the phone: "I agree",
  or "I want to talk about it" with their reason, which waits on the Requests page.

Every change gives the phone a new rules version and is in the activity log. AI apps can
tighten screen time and lock the phone directly; anything that loosens, any schedule that locks
the screen, or a move to another stage, is a proposal ([mcp.md](mcp.md)), and each schedule an
AI app adds or changes runs at least 15 minutes. They can't turn measuring on or off, or
answer the kid, and what the kid reads is never their words: Belay names a limit or schedule an
AI app adds or renames after what it is (a limit after its apps, a schedule after its kind), and
an AI app's pause or lock has no note. Every name and note the kid sees, whoever wrote it, goes
to the phone without control, invisible or direction-changing characters.

Screen time is kept 13 months by default (Settings, 1 to 36 months): the hourly clean-up
deletes older days, and the extra time given for them. When a phone that measures or has a
limit reports it can't count, its page and the daily summary say so ("Usage access for Belay
is turned off, so Belay can't count screen time", and what that does to the apps with a
limit).

### Network logging (Phase 3)

Off for every phone until a parent turns it on, on the phone's page under Web (or with `network
"<phone>" --on`): until then the policy's `network_log` is `{enabled: false}`, and the phone
notes nothing. Turned on, Android logs the phone's DNS lookups for Belay, and the phone sends,
each time Android hands it a batch (every 90 minutes at most), how many times each app looked up
each website or online service that day, by name (`example.com`: the registrable part of the
name, never the page). Never the lookups of the apps the phone never blocks (the phone app,
texting, Belay…), and never 988's websites: the phone drops them, and so does the server. Android
shows the kid its own notice that the phone "may monitor network traffic", and Belay's list of
what the parent can see explains it.

- **The switch** says what's noted and what never is, how long it's kept, whether AI apps may read
  it, and whether Android paused it: Android stops logging while another user or profile is on the
  phone (Android's own Parental Controls make one), and the phone's page and the daily summary say
  "Network logging is paused".
- **Network** (a phone's tab, while logging is on): each day, newest first, each app most looked
  up first, with the names it looked up and how many times, and how many pairs the phone left out
  (it sends at most 5000 a day, the most looked up).

Only a parent turns it on or off: AI apps can't, and can't propose it, in either direction. With
Settings' "Network" category on (it starts off for every family), an AI app reads it with
`get_network_activity` ([mcp.md](mcp.md)), names as untrusted text. **Kept** (Settings, "Keep
network activity"): 30 days by default (1 to 90), then deleted by the hourly clean-up; turning it
off keeps what's there until then, and Off belay's Stop collecting deletes it now. Days sent while
it's off aren't kept, and are counted.

## Location and the kid's side (Phases 4 and 7)

Location is off until a parent turns it on, on the phone's **Location and help** page: until
then the policy's `location` is `null`, and Belay holds no location permission on the phone.
Only a parent changes any of it, there or with the CLI; AI apps can't, and can't propose it.

- **Sharing:** off; on demand (only when a parent checks); or periodic (every 15 to 120
  minutes, within hours in the phone's time if the family wants, with arrivals and departures
  for its places). Keep location on stops the kid turning it off. The provider is GPS only
  (the phone's own receiver: private, slower indoors) or Android's combined provider (faster
  and indoors too, but on a Pixel it's Google's location service that answers).
- **Where the phone is:** the last fix (by the phone's clock, but never more than 5 minutes after
  the server got it, so a fix dated in the future doesn't stay on top; arrivals and departures
  are shown and ordered the same way), described by the
  family's places ("At School, within 40 m", "1.2 km from Home"), worked out on the server, with
  how old and how accurate it is,
  and **Open in a map**, a plain link to OpenStreetMap (or Google Maps, in Settings) that only
  the parent's browser follows, when clicked. The server never asks a map, tile or address
  service anything, and the page embeds no map. What Belay on the phone says (permission,
  location on, its own words for a fix that failed) is there too, and a phone that should share
  where it is but can't is flagged on the phone's page and in the daily summary.
- **Check now** sends a check (`locate_now`, which lasts 2 minutes) and waits up to a minute
  for the phone's fix, then shows it. **Checks** lists every one of the last 30 days, a
  parent's or their AI app's: the same list the kid sees on the phone, where each check also
  posts a notice.
- **Places** (at most 20): a name the kid sees (at most 40 characters), a center from
  coordinates pasted from a map or "Use where the phone is now", a radius of 50 to 1000 m,
  and whether to tell the parents on arriving, leaving or both. They're used only in periodic
  mode. There's no address search: it would need another company's service.
- **Lost mode:** "This phone is lost": the lock screen shows the parent's message and a number,
  location stays on, the phone shares where it is every 5 minutes and locks its screen once,
  in any mode. Turning it off puts everything back.
- **Turning location off** (or lost mode, or a help request's shared fix, ending) takes Belay's
  location permission away, and Android restarts Belay when an app loses a permission it was
  granted ([platform-notes.md](platform-notes.md), L7): expect the phone to reconnect a moment
  later.
- **Help and the emergency card:** the kid's own number, for **Call** beside a help request (it
  stays on the server: the phone never gets it, and AI apps never see it); and the numbers on
  the kid's emergency card, the family's from Settings or the phone's own, at most 4.

**"I need help"** comes first on the Requests page (and above the Phones page and the
phone's page) until a parent presses **I've seen it**: what the kid wrote, where the phone
was if they shared it, **Call** (a `tel:` link to the parent's own phone app), and "If they're
in danger, call 911". The kid's phone then shows "Your parent saw this at 4:05 pm". **Talk to
my parent** is answered like the agreement: "Let's talk", or "Got it". A request the kid
withdraws leaves their phone's list; the Requests page keeps it, marked withdrawn.

**Kept** (Settings, "How long Belay keeps where the phone was"), then deleted by the hourly
clean-up: fixes shared on a schedule 7 days (1 to 30), checks 30 days (1 to 90), arrivals and
departures 90 days (1 to 365), lost-mode fixes 7 days after lost mode ends (1 to 30; never
while it's on), and the fix the kid shared with a help request as long as the request (until
the phone is deleted). A fix counts from its own time, or from when it arrived if the phone's
clock was ahead. Fixes and place events the rules didn't ask for aren't kept at all.

## Calls (Phase 5)

Calls are off until a parent turns them on, on the phone's **Calls** page: until then the
policy's `calls` is `null`, and Belay leaves calls alone. Turned on, Belay becomes the phone's
phone app (the default dialer), and decides who rings. Turned off, `calls` is `null` again; the
rules are kept for next time.

- **911, 988 and every emergency number always work**, in and out, in every mode, even when the
  phone is paused or at bedtime: the phone allows them in its own code, never from the policy,
  and Android sends an emergency call to the phone's own dialer. For 2 hours after a call to an
  emergency number or 988, every caller rings, so they can call back. Belay never records calls
  with them. If Belay stops working as the phone app, calls go through the phone's own app with
  no rules, on purpose, and the phone's page says "Calls are going through the phone's own app"
  (also in the daily summary).
- **The rules:** who can call (anyone, or only contacts who can call); with only contacts,
  callers who aren't contacts, and callers with no caller ID, ring, go to voicemail or are
  refused; whom the kid can call (any number, or only contacts); quiet times (during bedtime and
  school schedules, only parents ring); and whether Belay keeps a record of calls.
- **Contacts** (at most 500, each with a name the kid sees, at most 60 characters, and 1 to 5
  numbers in E.164, each one contact's): whether they can call and text (texts aren't managed
  yet: the phone ignores that part until Phase 5's texts are built), and whether they're a
  parent, who always rings and is on the kid's emergency card. The page warns when a number on
  the emergency card isn't a contact, with a button to add it as a parent. Belay keeps contacts
  in its own storage on the phone; it never writes them into Android's Contacts.
- **Blocked numbers** (at most 500): Belay, as the phone app, puts them on Android's block list,
  which blocks their texts too. Never 911, 988 or an emergency number (in any form, 988's full
  number included), a contact's number, one on the emergency card, or a private number: the
  server refuses, with why. A private number is a helpline the kid may call; blocking it would
  cut the kid off from its calls, so a parent takes it off the private numbers first, a choice
  of its own in the activity log (unmarking it as part of the block would start recording the
  kid's calls with it unasked). Adding a blocked number as a contact unblocks it.
- **Private numbers** (at most 50): numbers Belay never records, like a helpline, besides 911,
  988 and emergency numbers, which it never records anyway. Making a number private deletes the
  records already kept of it, and of the contact who has it: the server keeps no record about a
  contact with a private number.
- **Recent calls** (only while Belay records calls): the last 30 days, with **Add as contact**
  and **Block** beside someone who isn't a contact.
- **The kid's contact requests** come to the Requests page with their name for the contact, the
  number and why. **Approve** adds the contact, with the name and whether they can call and text
  as the parent chooses; a number that's a contact already adds no one.

Only a parent turns calls on or off, decides whether they're recorded, or chooses private
numbers, there or with the CLI: AI apps can't, and can't propose it. An AI app may tighten the
rest at once (only contacts, a stricter rule for unknown or withheld callers, calling only
contacts, quiet times, fewer contacts allowed to call, blocking a number) and proposes anything
else, adding a contact included; anything that takes from a parent contact is a parent's to
approve too.

**Kept** (Settings, "Keep the record of calls"): 90 days by default (1 to 365), then deleted by
the hourly clean-up. A record counts from its own time, or from when it arrived if the phone's
clock was ahead. Records sent while Belay doesn't record calls aren't kept, and are counted on
the Calls page; at most 1000 are kept a day per phone.

## Off belay (Phase 11)

The end of the rules, for when the kid outgrows Belay: each step is a parent's, on the parent page
(handing over from the CLI too), never an AI app's, not even as a proposal.

- **Off belay** is every family's last stage (Stages, in the menu): it has no limits or schedules,
  keeps its name and place, and can't be deleted. Its page takes the family's words for when it
  comes ("When you turn 16"), which every phone shows the kid from the first day, last on My stage.
  New stages go in before it. Moving a phone there (its Screen-time rules tab) stops its limits
  and schedules; turning protection off on its page stops the rest of the blocking.
- **Stop collecting** (a phone's page, "What the server keeps about this phone"): per kind of data,
  a confirmation lists exactly what goes and what stays, then the server deletes it at once and
  turns off the phone's switch where it has one (measuring; location, lost mode and keeping
  location on; recording calls; network logging). The app list and the kid's requests keep coming while Belay is on the phone;
  [privacy.md](privacy.md) has exactly what each stop deletes.
- **Hand this phone over** (a phone's page, after typing its name): lifts the locks on factory
  reset, debugging and accounts and clears reset protection and the accounts Play may use, and
  the phone shows the kid what to
  back up and how to reset it from Settings. While it lasts, those can't be locked again; "Take the
  hand-over back" stops the phone showing it (the locks stay lifted). The page says when the phone
  has it.
- **Afterwards,** once the phone is reset: it goes quiet here, as expected. Disconnect it, then
  delete everything about it, on its page. [phase11-checklist.md](phase11-checklist.md) walks
  through it on a Pixel.

## What a phone can make the server keep

A phone's token stays good until a parent disconnects the phone, so a stolen, sold or rooted
phone can send anything a phone may. Whatever it sends, the server keeps at most, per phone:

- **Apps** (Phase 1): 5,000 new app changes an hour (installs, updates and removals, the
  phone's own and those found in its app lists together), and 20,000 in all: past that the ones
  that arrived first go. At most 5,000 apps on the phone (an app list's own limit), and 2,000 that
  aren't on it any more, the ones removed last (so a reinstall is still recognized); an app a
  parent decided on or reviewed always stays, with its decisions and reviews. The record of the
  newest 1,000 app lists the phone sent. A change past the hour's limit, or one that would make
  more than 5,000 apps, is answered as accepted (the phone sends its changes in the same queue as
  the kid's requests, which never wait behind them) and isn't kept: the phone's next app list
  puts the apps right, as found by snapshot, and an app list past the hour's limit still updates
  the apps, without keeping its changes as changes.
- **Requests:** 300 new ones an hour (help requests aside: nothing holds one back), and 100 help
  requests no parent has seen. Of the requests that wait for no one any more (answered,
  withdrawn, asked again, the kid's "I agree"), the newest 1,000: past that the oldest go, the
  ones the phone settled itself before the ones a parent answered, and the hourly clean-up
  deletes them a year after they last changed. Help requests stay until the phone is deleted.
- **Where the phone was:** 600 new fixes and arrivals or departures an hour, lost-mode and help
  fixes included, and 10,000 fixes and 2,000 arrivals and departures in all (the fix a kid shared
  with a help request is kept with it): past that, the oldest go.
- **Screen time:** one day per date and zone, for dates the phone can have counted (up to
  tomorrow in its zone), in at most 3 zones, and for no longer than the family keeps it.
- **Calls** (Phase 5): records only while Belay records calls, at most 1000 a day.
- **Network activity** (Phase 3): only while a parent has network logging on, one day per date
  (sent again, it replaces the stored one), for dates the phone can have counted and no longer
  than the family keeps it, at most 5000 entries a day; `POST /network` is limited to 30 calls a
  minute per phone, apart from its other calls.

Past an hour's limit the phone is answered `429` with `Retry-After`, and sends the rest later
(app changes aside, as above); every device call is limited to 120 a minute per phone too. Disconnecting a phone stops its
token at once, and deleting it deletes everything it sent.

## Backups

Every day, from 2 AM in the family's timezone, the server makes a consistent copy of its
database while it runs (SQLite's `VACUUM INTO`): `/data/backups/belay-YYYY-MM-DD.db`, or
`belay-YYYY-MM-DD.db.enc` when it's [encrypted](#encrypted-backups). It keeps the newest 14
and deletes the older ones (only its own `belay-YYYY-MM-DD` files: anything else you put in
`/data/backups` stays). Every try is recorded; a failed one is tried again an hour later,
and the parent page and [health monitoring](#health-monitoring) say so. One backup runs at a
time, a backup never overwrites a file, and none is started when it would leave a disk nearly
full (it needs the database's size free where the backup goes, and 64 MB more; encrypting, the
same again where it makes the unencrypted copy). An encrypted backup makes that copy in a
private folder next to the database (the data dir, which holds the database anyway), never in
the backup's own folder, and deletes it once it's sealed or failed; only the sealed copy goes
where the backup goes.

These copies live on the same disk as the database: they help after a mistake or a damaged
database, not a lost disk. [Copy them off the machine](#off-site-copies) too.

To make one now, to a file of your choice:

```bash
docker compose exec belay node dist/cli.js backup /data/belay-now.db
docker compose exec belay node dist/cli.js backup /data/belay-now.db.enc --encrypt   # with the backup passphrase (asks for one if it isn't set)
```

With `--encrypt`, the file can go straight onto a USB stick or a synced folder: nothing but the
sealed copy is ever written there.

### Encrypted backups

Set a backup passphrase (`BELAY_BACKUP_PASSPHRASE`, or better `BELAY_BACKUP_PASSPHRASE_FILE`,
in [Settings](#settings)) and the daily backups are encrypted: AES-256-GCM with a key made
from the passphrase by scrypt (N = 2^17, r = 8, p = 1), with Node's own crypto and no other
library. The file is a small header (a format version, the scrypt settings, a salt, a nonce
and a passphrase check), the encrypted database, and GCM's tag, so a wrong passphrase, a file
cut short and a file changed after it was made are all refused. An encrypted backup is safe
to keep anywhere off the machine on its own. Without the passphrase nobody can read it, you
included: keep it in a password manager, and on paper with the family's papers, not only on
the server.

With Docker, keep the passphrase in a secret, in `docker-compose.override.yml` (next to
`docker-compose.yml`; add to it if you have one already):

```yaml
services:
  belay:
    environment:
      BELAY_BACKUP_PASSPHRASE_FILE: /run/secrets/belay_backup
    secrets: [belay_backup]

secrets:
  belay_backup:
    file: ./backup-passphrase.txt     # one line; git ignores it
```

Docker Compose hands the file to the container as it is, and Belay runs as the container's
`node` user (uid 1000), so make it that user's, readable by no one else:

```bash
sudo chown 1000 backup-passphrase.txt && sudo chmod 600 backup-passphrase.txt
```

A passphrase that's set but unusable (shorter than 15 characters, or a file that can't be
read) fails the backup, with the reason on the parent page; Belay never falls back to an
unencrypted one. A new passphrase applies to new backups; older ones keep the one they were
made with. After turning encryption on, the unencrypted ones age out within 14 days, or
delete them.

### Verify a backup

```bash
docker compose exec belay node dist/cli.js verify-backup /data/backups/belay-2026-11-17.db.enc
```

`verify-backup` proves a backup restores. It copies it into a private temporary folder
(decrypting an encrypted one there, with the backup passphrase or one it asks for), opens the
copy read-only, runs `PRAGMA integrity_check`, checks its schema against this server's (one
from an older Belay is upgraded, on the copy, to show the upgrade works; one from a newer
Belay is refused), and counts the phones, apps and parents in it with the server's own code.
It prints a short report and exits 0 if the backup restores, 1 if it doesn't:

```
/data/backups/belay-2026-11-17.db.enc: it restores.
  Encrypted: yes, and the passphrase works.
  Integrity: ok.
  Schema: version 4, the same as this server.
  In it: 2 phones, 143 apps, 2 parents.
  Newest data: Nov 17, 2026, 1:58 AM (UTC-05:00).
  Size: 1.2 MB.
Recorded as this server's latest backup check.
```

The backup itself is only read, and the temporary copy is deleted. A check of a backup in the
server's data dir is recorded: the parent page shows "last verified: 12 days ago", and one
that failed shows as a problem until a check works. It works on any computer with Belay's
code too, without a server or `BELAY_PUBLIC_URL`
(`npm run cli -- verify-backup ~/belay-2026-11-17.db.enc` in `server/`), and `-` reads the
backup from stdin (an encrypted one then needs `BELAY_BACKUP_PASSPHRASE`).

### Restore

`restore` checks a backup as `verify-backup` does, then puts it in place as `belay.db` in the
data dir. It only writes into a data dir without a database, so it can't overwrite the
family's data by mistake: move the old one aside first.

```bash
docker compose stop belay
docker compose run --rm belay sh -c 'mkdir /data/before-restore-$(date +%F) && mv /data/belay.db* /data/before-restore-$(date +%F)/'
docker compose run --rm belay node dist/cli.js restore /data/backups/belay-2026-11-17.db.enc
docker compose up -d
```

The restored database's activity log says it was restored, and from which file. The phones
reconnect by themselves (their tokens are in the backup) and apply the rules as the backup
has them, so check each phone's rules on its page. Whatever happened after the backup was
made is gone from the server; each phone sends its whole app list again within a day, and
the server fills in the changes. Without Docker: stop the service, move `belay.db*` aside,
run `BELAY_DATA_DIR=/var/lib/belay node dist/cli.js restore <backup>` as the service's user,
and start it.

### Restore drill

A backup nobody has restored is a hope. Every 3 months, restore the newest one into a
scratch server, sign in, and see the phones: the parent page reminds you, and
`docker compose exec belay node dist/cli.js restore-drill` prints these steps for the newest
backup.

1. Check it on the server (it asks for the passphrase of an encrypted one):
   `docker compose exec belay node dist/cli.js verify-backup /data/backups/belay-2026-11-17.db.enc`
2. Copy it to the computer for the drill (the server itself will do), from the folder with
   `docker-compose.yml`: `docker compose cp belay:/data/backups/belay-2026-11-17.db.enc .`
3. There, from the `server` folder of Belay's code, restore it into a scratch server with a
   volume of its own:
   ```bash
   docker build -t belay-server .
   docker volume create belay-drill
   read -rs BELAY_BACKUP_PASSPHRASE && export BELAY_BACKUP_PASSPHRASE   # for an encrypted one: type it, then Enter
   docker run --rm -i -e BELAY_BACKUP_PASSPHRASE -v belay-drill:/data belay-server node dist/cli.js restore --drill - < belay-2026-11-17.db.enc
   docker run -d --name belay-drill -p 127.0.0.1:8081:8080 -e BELAY_PUBLIC_URL=http://localhost:8081 -v belay-drill:/data belay-server
   ```
4. Open `http://localhost:8081` on that computer (for a server elsewhere:
   `ssh -L 8081:localhost:8081 <the server>` first), sign in with your usual username and
   password, and check that the phones are there.
5. Clean up: `docker rm -f belay-drill && docker volume rm belay-drill && rm belay-2026-11-17.db.enc`
6. On the real parent page, under "This server" on the Phones page, choose "We did a restore
   drill".

`--drill` marks the copy as a drill's: it sends no notifications, and its parent page says
what it is. The phones and AI apps never reach it, since they use the real server's address.

### Off-site copies

Copying backups off the machine is the family's job; encrypt them first. Either:

- **Plain copies:** now and then, from a computer of yours, `docker compose cp` (above) the
  newest `.db.enc` file onto a USB disk or into a cloud drive you trust;
- **Continuous replication** with [Litestream](https://litestream.io) to storage you control,
  as another container with the `belay-data` volume mounted. Litestream copies the live
  database as it is, not encrypted by Belay, so use storage that encrypts with a key only you
  hold.

A backup holds everything in the database: the family's data, and the server's own secrets
(its Web Push key, and the hashes of tokens and passwords). Keep plain ones as private as the
server, and none of them in this repository.

## Health monitoring

The server checks itself every 5 minutes and says what's wrong in plain words: under "This
server" on the parent page's Phones page, through MCP (`get_server_health`), and in short on
[`/healthz`](#healthz). It checks:

| Problem | When | |
|---|---|---|
| The disk is getting full | Less than 10% free on the filesystem that holds the data dir. | Urgent under 5% |
| The database is growing fast | It grew by at least 50 MB and by half within about a day; or, at its growth over the last few days (its size is noted hourly, for 8 days), the disk fills within 30 days. | |
| No backup | No backup has worked for 2 days (on a new server, 2 days after the first parent's account). It says why the last try failed. | Urgent |
| The last backup failed | The daily backup's last try failed; it tries again an hour later. | |
| The last backup check failed | The last `verify-backup` found that a backup doesn't restore. | |
| The server's clock is off | Two or more phones that checked in within a day all report a clock more than 5 minutes off in the same direction. One phone alone could be wrong itself: that's on its own page. | |
| The database can't be opened | See below. | Urgent |

Urgent problems reach every parent's browser where [notifications](#notifications) are on,
at once and then at most once a day while they last ("The server needs you: no backup for 3
days."). The rest are in the [daily summary](#notifications), for parents who turn it on.

**When the database can't be opened or upgraded** (a migration failed, the database is from
a newer Belay, the disk refuses), the server doesn't crash and restart in a loop with nobody
told why. It keeps listening: every page says "Belay isn't working right now" with the
reason, the device API, OAuth and MCP answer 503 with `Retry-After`, and `/healthz` gives the
reason. The phones keep enforcing their rules on their own meanwhile. It tries again every 5
minutes and starts normally once the database opens; the log has the details. A failed
migration is rolled back, so the database is still as it was: go back to the previous version
([Upgrades](#upgrades)) or restore a backup.

### /healthz

`GET /healthz` needs no login and says nothing about the family. It answers 200 while the
server is running, which Docker's healthcheck relies on, with `{"ok":true}` or the most
important problem in a few words: `{"ok":false,"reason":"the last backup failed"}`.

For your own uptime monitor (Uptime Kuma, or any service that checks a URL), use
`GET /healthz?strict=1`: it answers 503, with the same body, while a problem is urgent, so the
monitor tells you even when nobody looks at the parent page.

## Upgrades

```bash
git pull
docker compose up -d --build
```

Your settings are in `.env`, `Caddyfile` and `docker-compose.override.yml`, which git doesn't
touch. (On a server set up before they were, with the address in `docker-compose.yml`
itself: put it in `.env` and any other change you made in the override, then
`git checkout docker-compose.yml` and pull.)

Back up first (`backup /data/before-upgrade.db`: the daily one may be hours old). The
database schema upgrades itself when the server starts (versioned SQL migrations in
`server/src/migrations`). If an upgrade fails, the server says so on every page and on
`/healthz` instead of starting ([Health monitoring](#health-monitoring)); the failed step was
rolled back, so check out the previous version and `docker compose up -d --build` again. A
server won't open a database from a newer version, so downgrading after a successful upgrade
means restoring a backup made before it.

## Without Docker

Node 24 LTS:

```bash
cd server
npm ci --ignore-scripts      # native modules ship prebuilt; no install scripts needed
npm run build
BELAY_PUBLIC_URL=https://belay.example.org BELAY_DATA_DIR=/var/lib/belay node dist/index.js
```

Put it behind a reverse proxy with HTTPS, as a service of its own user (a systemd unit with
`User=belay`, `StateDirectory=belay`, and `Restart=on-failure` works well).

## What it logs

Startup, the one-time setup link, "a phone enrolled", notifications that didn't go out, each
daily backup (its file name and size, or why it failed), urgent notices about the server,
why the database couldn't be opened, and errors; that a phone sent location items or call
records its rules didn't ask for, or more app changes than the server keeps, and how many; that
a phone sent a call record Belay never keeps (an emergency number, 988 or a private number),
without the number, the phone or the time of the call, since the phone shouldn't; and,
likewise, days of network activity sent while network logging was off (how many), and network
activity naming 988's websites (only that it happened). Never tokens, passwords, passphrases,
browsers' push addresses, app names, domains, phone numbers or request bodies. The activity log
on the parent page is where parents see who did what, for as long as the family keeps it (400
days by default; the hourly clean-up deletes older entries).

## Development

```bash
cd server
npm ci --ignore-scripts
npm test                 # Vitest: device API, the policy and its long-poll, snapshots, login, CSRF, OAuth, Web Push, every MCP tool, the CLI, backups and the server's health
npm run typecheck && npm run lint
BELAY_PUBLIC_URL=http://localhost:8080 npm run dev
```

With `BELAY_PUBLIC_URL=http://10.0.2.2:8080` and `BELAY_HOST=0.0.0.0`, a debug build on
the emulator can enroll against it (debug builds allow plain http to the emulator's host).
