# Running the Belay server

The server keeps the family's data, talks to the phones, serves the parent pages and the
MCP interface. One server is for one family. It's a single Docker image with a SQLite
database in `/data`.

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
3. Put your name in `Caddyfile` and in `BELAY_PUBLIC_URL` in `docker-compose.yml`.
4. Start it, and read the one-time setup link from the log:
   ```bash
   docker compose up -d --build
   docker compose logs belay
   ```
5. Open the link (it works once, for 24 hours) and create the first parent account. You
   can invite a second parent from Settings.

Caddy gets and renews the certificate on its own. `Caddyfile` stays out of git: it names
your server.

## Option 2: a computer at home, behind a tunnel

If the server runs at home (a mini PC, a NAS, a Raspberry Pi 4 or 5), don't open ports on
the home router. Use a tunnel that gives it a public HTTPS name:

- **Cloudflare Tunnel** (`cloudflared`): free with a domain on Cloudflare. Point a
  hostname at `http://localhost:8080` (or `http://belay:8080` in compose). Cloudflare
  terminates TLS, so it can see the traffic.
- **Tailscale Funnel:** `tailscale funnel 8080` gives `https://<machine>.<tailnet>.ts.net`
  with a Let's Encrypt certificate, and TLS ends on your machine.

Run the `belay` service from `docker-compose.yml` without Caddy, publish port 8080 on
localhost (`ports: ["127.0.0.1:8080:8080"]`), set `BELAY_PUBLIC_URL` to the tunnel's
address, and set `BELAY_TRUST_PROXY=1` (the tunnel is the one proxy in front).

The phone always uses the public name, at home too, so it never needs the local-network
permission for this. (Belay pre-grants `ACCESS_LOCAL_NETWORK` anyway, for servers on the
home network; see docs/platform-notes.md.)

## Settings

| Variable | Default | What |
|---|---|---|
| `BELAY_PUBLIC_URL` | (required) | The public origin, like `https://belay.example.org`: no path. Phones, QR codes, OAuth and MCP use it. Plain `http` is refused except for localhost and private addresses, for testing. |
| `BELAY_DATA_DIR` | `/data` in the image, `./data` otherwise | Where `belay.db` lives. |
| `BELAY_HOST` | `0.0.0.0` in the image, `127.0.0.1` otherwise | Address to listen on. |
| `BELAY_PORT` | `8080` | Port to listen on. |
| `BELAY_TRUST_PROXY` | off | `1` when exactly one reverse proxy (Caddy, a tunnel) is in front: client addresses for rate limits then come from the last `X-Forwarded-For` entry. Leave it off if clients can reach the server directly, or they could pretend to be anyone. |
| `BELAY_EXTRA_REDIRECT_URIS` | none | More OAuth redirect URIs to allow, comma-separated and exact, for MCP clients other than Claude. They get no refresh tokens. |
| `BELAY_BACKUP_PASSPHRASE` | none | Encrypts the daily backups with this passphrase, at least 15 characters ([Encrypted backups](#encrypted-backups)). Without it they're plain SQLite files. Prefer the `_FILE` form. |
| `BELAY_BACKUP_PASSPHRASE_FILE` | none | A file that holds the passphrase instead, like a Docker secret (`/run/secrets/belay_backup`); a final new line is ignored. Set one of the two, not both. |

The family's timezone, the silent threshold, what AI apps may read, notifications and the
daily summary are set on the Settings page, not here.

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
  (Requests or Proposals). Notices about the server and the daily summary name no phone or
  app, and open the Phones page. Each is encrypted for that browser (RFC 8291, `aes128gcm`):
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

They're logged as the server's ("The server" on the Activity page), and a running server
passes them to the phone within a second or two. `status --json` gives each phone's
`policy_version` (the server's), `enforcement` (what the phone last said it applied, or
`null`) and `requests` (`[{package, status, reason}]`). Hardening (factory reset, debugging,
reset protection) can only be turned on on the parent page.

Outside Docker, use `npm run cli -- <command>` from `server/`.

## Backups

Every day, from 2 AM in the family's timezone, the server makes a consistent copy of its
database while it runs (SQLite's `VACUUM INTO`): `/data/backups/belay-YYYY-MM-DD.db`, or
`belay-YYYY-MM-DD.db.enc` when it's [encrypted](#encrypted-backups). It keeps the newest 14
and deletes the older ones (only its own `belay-YYYY-MM-DD` files: anything else you put in
`/data/backups` stays). Every try is recorded; a failed one is tried again an hour later,
and the parent page and [health monitoring](#health-monitoring) say so. One backup runs at a
time, a backup never overwrites a file, and none is started when it would leave the disk
nearly full (it needs the database's size free, twice that when encrypting, and 64 MB more).

These copies live on the same disk as the database: they help after a mistake or a damaged
database, not a lost disk. [Copy them off the machine](#off-site-copies) too.

To make one now, to a file of your choice:

```bash
docker compose exec belay node dist/cli.js backup /data/belay-now.db
docker compose exec belay node dist/cli.js backup /data/belay-now.db.enc --encrypt   # with the backup passphrase (asks for one if it isn't set)
```

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

With Docker, keep the passphrase in a secret rather than in `docker-compose.yml`:

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
why the database couldn't be opened, and errors. Never tokens, passwords, passphrases,
browsers' push addresses, app names or request bodies. The
activity log on the parent page is where parents see who did what.

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
