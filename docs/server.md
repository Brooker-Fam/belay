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

The family's timezone, the silent threshold, what AI apps may read and notifications are set
on the Settings page, not here.

## Notifications

Off until a parent turns them on. Without them, a request from the kid shows on the parent
page (Requests in the menu shows how many are waiting) and through MCP.

**Turning them on:** Settings → Notifications → Turn on notifications on this browser, on
each browser where a parent wants them. The page registers a small service worker
(`/sw.js`) that shows each notice and opens the page it's about when tapped. Settings lists each parent's own browsers, and
Remove stops one; Send a test notice checks them. On an iPhone or iPad, iOS only delivers
notifications to web apps on the Home Screen: open the parent page in Safari, choose Share →
Add to Home Screen, open Belay from the Home Screen, and turn them on there (iOS 16.4 or
later).

**When:** when a phone sends a new request (one notice for the requests in one call), and
when an AI app proposes a change. Not again when a request is sent a second time, or the
same change is proposed again while it waits, and at most six notices an hour about one
phone: past that, requests and proposals still show on the parent page.

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
  (Requests or Proposals). It is encrypted for that browser (RFC 8291, `aes128gcm`): only
  the browser can read it, not the push service.
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
docker compose exec belay node dist/cli.js backup /data/belay-backup.db
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

They're logged as the server's ("The server" on the Activity page), and a running server
passes them to the phone within a second or two. `status --json` gives each phone's
`policy_version` (the server's), `enforcement` (what the phone last said it applied, or
`null`) and `requests` (`[{package, status, reason}]`). Hardening (factory reset, debugging,
reset protection) can only be turned on on the parent page.

Outside Docker, use `npm run cli -- <command>` from `server/`.

## Backups

The database is one SQLite file, `/data/belay.db`, in WAL mode: don't copy it while the
server runs. Make a consistent copy with the `backup` command, then copy it off the
machine:

```bash
docker compose exec belay node dist/cli.js backup /data/belay-backup-$(date +%F).db
docker compose cp belay:/data/belay-backup-$(date +%F).db .
docker compose exec belay rm /data/belay-backup-$(date +%F).db
```

For continuous backups, [Litestream](https://litestream.io) can replicate the database to
storage you control; run it as another container with the `belay-data` volume mounted.

A backup holds the family's data. Keep it as private as the server, and never in this
repository.

To restore: stop the server, put the file at `/data/belay.db` (delete any `belay.db-wal`
and `belay.db-shm` next to it), and start the server.

## Upgrades

```bash
git pull
docker compose up -d --build
```

Back up first. The database schema upgrades itself when the server starts (versioned SQL
migrations in `server/src/migrations`). A server refuses to start on a database from a
newer version, so downgrading means restoring a backup.

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

Startup, the one-time setup link, "a phone enrolled", notifications that didn't go out, and
errors. Never tokens, passwords, browsers' push addresses, app names or request bodies. The
activity log on the parent page is where parents see who did what.

## Development

```bash
cd server
npm ci --ignore-scripts
npm test                 # Vitest: device API, the policy and its long-poll, snapshots, login, CSRF, OAuth, Web Push, every MCP tool, the CLI
npm run typecheck && npm run lint
BELAY_PUBLIC_URL=http://localhost:8080 npm run dev
```

With `BELAY_PUBLIC_URL=http://10.0.2.2:8080` and `BELAY_HOST=0.0.0.0`, a debug build on
the emulator can enroll against it (debug builds allow plain http to the emulator's host).
