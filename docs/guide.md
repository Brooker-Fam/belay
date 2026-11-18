# Start here

One guide for a parent: from "we bought a used Pixel 8" to a phone your kid uses, then living
with it for years, until you hand the phone over. You'll type a few commands, copied from here,
but you don't need to know adb (Android's tool for computers), Docker or servers. Each step
says what to do and links to the page with the details, which you don't need to read first.
The examples use a made-up kid, Sam, and a made-up server, `belay.example.org`: put in your
own.

> **Nobody has done this on a real Pixel yet.** Belay is built, and runs end to end on the
> Android 17 emulator in CI, but none of it has been checked on a real Pixel 8. This guide
> says **Not yet checked on a Pixel** wherever the real phone may behave differently, with the
> checklist that will check it. For now your first phone is a test: keep the
> [Phase 0 checklist](phase0-checklist.md) open beside this guide, and write down what you
> see. [pixel-day.md](pixel-day.md) has the order of every checklist after it, up to handing
> the phone to your kid.

## 1. What Belay is and isn't

Belay is parental controls for a kid's first Android phone, in three parts that you run:

- **An app on the phone** that Android makes the phone's manager, its *device owner*. It
  enforces the family's rules by itself, offline too: new apps wait for a parent, the web is
  filtered, the settings that would undo Belay are locked, and, if you turn them on, screen
  time, location and calls follow your rules.
- **The family's own server**, which keeps the family's data and talks to the phone.
- **Claude** (or another MCP app) and the **parent page**, a website on your server, where
  you manage it.

Two rules hold everywhere. **The phone enforces; the AI advises:** Claude reads what you let
it read, and can tighten a rule (block an app, pause the phone), but anything that loosens a
rule waits until a parent taps Approve on the parent page. And Belay is **transparent to the
kid:** nothing is monitored in secret. The phone always says it's managed, and lists exactly
what you can see, made from the code that collects it.

Privacy, in the project's own words (principle 5, [CLAUDE.md](../CLAUDE.md)):

> **Private by default.** All data stays on the family's server. No analytics, telemetry, ads
> or crash-reporting SDKs; no Firebase, Google Play services or ML Kit in the agent. The server
> never sends family data in readable form to anyone, and never calls an AI: the parent's own
> MCP client is the only AI. Its only outbound requests are reading an allowlisted AI client's
> public metadata document (no family data) and end-to-end encrypted push to a parent's own
> browser. Settings decide which data categories AI clients may read.

Your own choices can send some things elsewhere, and this guide says so where you make them:
what Claude reads goes to its provider (Anthropic), for the categories you allow; the web
filter sees the names of the sites the phone looks up; Cloudflare, if you use its tunnel,
sees the traffic to your server; and Google's location service answers if you pick Android's
combined location provider. [privacy.md](privacy.md) has every detail.

**What Belay isn't:**

- **A service.** No company runs it, and there's no account or fee. You run it and keep it
  running, for years.
- **A way to read your kid's life.** Belay never collects messages, what's said on calls,
  photos, or what's on the screen, and it never tracks the phone continuously.
- **Finished.** Phase 5's texts aren't built: texting isn't managed, and the texting app
  works with anyone. Phase 9 isn't built either: each family's own package name, which
  matters for Google's developer verification (section 2).
- **Checked on a real phone.** Every Pixel checklist is still to do. The biggest open
  question is the first step: if a real Pixel 8 refuses Belay as its device owner over USB,
  the plan changes ([phase0-checklist.md](phase0-checklist.md)). And the hardening locks
  (factory reset, USB debugging, reset protection) have never run on any phone: CI only runs
  test builds, which never apply them.

**What a determined kid can still do.** [threat-model.md](threat-model.md) has the whole
list. In short, a kid can:

- use a friend's phone, or a second one: Belay is about this phone;
- reset the phone from Settings, until you lock factory reset; after that, a reset from
  recovery mode still wipes Belay, but reset protection stops the phone setting up again
  without your Google account;
- use a new app for a moment before Belay pauses it (Android can't stop an install);
- get past the web filter with an app that does its own DNS (it still waits for you, like
  any app);
- swap in another physical SIM card (Belay reports it; it can't block it);
- go quiet: airplane mode, or the phone off (reported as silent, which is a signal, not
  proof);
- turn off usage access, which Belay needs to count screen time (reported; apps with a time
  limit pause);
- set up Android's own Parental Controls, which add a hidden profile and can undo Belay's
  pauses (reported at the top of the phone's page; you can have Belay remove it);
- use developer options and USB debugging, until you lock them;
- unlock the screen right after "Lock now" (they know their PIN; the apps stay paused);
- with calls on, restart the phone and leave it locked: until it's unlocked, calls ring in the
  phone's own app without your call rules. Belay records those calls afterwards, and the Calls
  tab says how long the phone stayed locked.

**What it takes:**

- **A computer** you'll keep (Linux, macOS or Windows): it sets up the phone, and it holds
  the family's signing key for every later update.
- **A server**, the family's own: a small machine running Docker, either a computer at home
  that's always on or a small rented server (a VPS).
- **A domain name, or another way to reach the server**, so the phone can reach it over HTTPS
  from anywhere, on cellular too (Tailscale Funnel gives you a name without buying one).
- A few hours the first time, and a first day with your kid.

**Look first, before you buy anything:** [demo.md](demo.md) runs the parent page on your own
computer (it needs Node 24) with a made-up family and a simulated phone: no phone, and no server
to set up. Claude Code connects to it too. You can approve a request, pause the phone or ask
Claude what was installed this week, and see what the rest of this guide sets up.

## 2. Before you start

### The phone

- **A used Pixel 8.** Google updates it until October 2030. Before you buy, make sure the
  seller removes their Google account (ideally resetting it in front of you), and that it
  isn't carrier- or finance-locked ([pixel.md](pixel.md#buying-a-used-one)).
- **Android 17:** install the system updates it offers before you start. Belay refuses
  anything older than Android 12, and only Android 17 has been checked (on the emulator).
- **Factory reset, with no accounts on it.** Android only lets an app become device owner on
  a phone with no accounts and one user. You'll reset it in section 4 and skip every account;
  the Google account comes after.
- **Its phone line, working first** (SIM or eSIM): once you lock eSIMs, none can be added,
  the phone's own included. When you reset the phone, keep the eSIM: don't tick the option to
  erase eSIMs.

### A computer

Two ways to set up the phone (section 4). Pick one:

- **The setup kit:** Docker (Docker Desktop on macOS or Windows, with at least 4 GB of
  memory for Docker and 8 GB of disk free) and Chrome or Edge. Nothing else to install
  ([setup-kit.md](setup-kit.md#what-you-need)).
- **The Android SDK:** JDK 21 and the Android SDK (platform 37.0, the build tools, and
  platform-tools for `adb`), for `provision.sh`.

Either way: a USB-C cable that carries data (some only charge), and a copy of this
repository.

### The server

The server keeps the family's data, talks to the phone and serves the parent page. It's one
Docker image with its database in one folder; 1 GB of memory is plenty
([server.md](server.md)). It can run:

- on a **small VPS**, with a domain name pointed at it: the simplest, and section 3's path;
- on a **computer at home** (a mini PC, a NAS, a Raspberry Pi 4 or 5), behind a tunnel, so you
  never open ports on your router: Cloudflare Tunnel (free with a domain on Cloudflare, which
  can then see the traffic) or Tailscale Funnel (a `ts.net` name, no domain needed, and the
  encryption ends on your machine)
  ([server.md, Option 2](server.md#option-2-a-computer-at-home-behind-a-tunnel)).

It **must be reachable over HTTPS from the phone on cellular**, not only on your Wi-Fi, and
from claude.ai on the internet. Its certificate must come from a public certificate authority
(Let's Encrypt is fine, and Caddy gets one by itself): Android 17 refuses self-signed ones.

### The signing key

Belay is signed with your family's own key, made once on your computer, never put on the
server. It matters because Android only updates a device owner with an app signed by the same
key: **lose the key, and every phone has to be factory reset to update Belay**
([signing.md](signing.md)). The setup kit, or `make-release-key.sh`, makes it in
`~/.config/belay`. Before you use it:

1. Copy `belay-release.p12` to two places that aren't this computer: an encrypted USB drive,
   and your password manager as an attachment.
2. Put its password in your password manager.
3. Write down the certificate's SHA-256 it prints (it isn't secret): you'll compare it with
   what the build and the setup page show.
4. Once, restore the backup on another computer and build with it, to prove it works.

### Google's developer verification (2027)

From 2027, certified Android phones only install apps from registered developers, except over
USB with adb ([signing.md](signing.md#developer-verification)). Belay's first install is over
USB, but the updates it installs by itself may need it. Google's free limited-distribution
account only registers a package name Google has never seen, so **register before the release
build goes on the phone** ([phase0-checklist.md, "Register the package name
first"](phase0-checklist.md#2-register-the-package-name-first-recommended-your-call)): a
Google account with 2-Step Verification, Belay's package name with your key's SHA-256, then
each phone.

Belay's package name is fixed for now (`family.brooker.belay`), and only one developer can
register a name: giving each family its own is Phase 9, which isn't built
([design](design/phase9-more-families.md)). If you can't register it, Belay still installs
over USB, but from 2027 its updates may be refused; each one would then need maintenance mode
and a computer (section 8).

### The parent-owned Google account

Make a new Google account that you, the parent, own, only for this phone: the Play Store on
the phone uses it ([pixel.md](pixel.md#which-google-account)).

- Not your main account: its mail, photos and passwords would be on the kid's phone.
- Not a child (Family Link) account: it very likely can't run next to a device owner. Belay
  does the supervising.
- Make it a few days early: reset protection (section 6) can take up to 72 hours to accept a
  new account.
- Keep its password from the kid, and don't add it to the phone until Belay is set up.
- Know that an adult's own account brings **Gemini inside Google Messages**, the texting app:
  Google offers it to a personal account that's 18 or over, not to a Family Link or Google
  Workspace account. Belay never pauses the texting app, so that AI chat works during a pause and
  at bedtime, and Belay can't turn it off: Google documents no setting for it that Belay could
  set. Section 6 says how to hide its button, which your kid can show again.

### A password manager

For the parents' Belay passwords, the key's password, the backup passphrase, the parent-owned
account, and each phone's recovery key (section 6).

Keep your Belay password away from your kid, like the parent-owned account's. Their phone shows
the server's address, and with your password its browser can do everything you can: approve
their own requests, unblock apps, end a pause. Let the password manager fill it in rather than
typing it where they can see, and don't sign in on their phone. Belay tells every parent at once
about each new sign-in, on the browsers with notifications on (Settings → Notifications), saying
when and on what kind of browser: one you didn't make means someone has your password. Sign that
browser out in Settings → Your account, and change your password.

## 3. Set up the server

The shortest path is a small VPS with Docker, and Caddy for the certificate
([server.md, Option 1](server.md#option-1-a-small-vps-with-caddy-simplest)). For a computer at
home, follow [Option 2](server.md#option-2-a-computer-at-home-behind-a-tunnel) instead of steps
1 to 3, then carry on.

1. Point a DNS name at the VPS, like `belay.example.org`, and open ports 80 and 443.
2. On the VPS, get the repository and go to its `server` folder (server.md has the
   `git clone` line), then:
   ```bash
   cp Caddyfile.example Caddyfile
   ```
3. Put your server's name in `Caddyfile`, and in a file called `.env` next to
   `docker-compose.yml`, like `https://belay.example.org`, with no path:
   ```bash
   echo BELAY_PUBLIC_URL=https://belay.example.org > .env
   ```
   Don't edit `docker-compose.yml` itself: what you'd change goes in
   `docker-compose.override.yml` (the next step makes one), so updating the server later is a
   plain `git pull`.
4. Set a backup passphrase now (at least 15 characters), so the daily backups are encrypted
   from the first one: put it on one line in `backup-passphrase.txt`, and the lines from
   [Encrypted backups](server.md#encrypted-backups) in `docker-compose.override.yml`, both next
   to `docker-compose.yml`, and give the file to the container's user as that section says.
   Keep the passphrase in your password manager too: without it nobody can read the backups,
   you included.
5. Start it, and read the one-time setup link from the log:
   ```bash
   docker compose up -d --build
   docker compose logs belay
   ```
   The log says "No parent account yet. Open this link within 24 hours to create the first
   one", then the link.
6. Open the link (it works once, for 24 hours). On **Set up Belay**, give your name, a username,
   a password of at least 15 characters, and **your family's timezone**: the page fills in your
   browser's, so check it. The times Belay shows you, on the parent page and in Claude, are in
   this timezone, with its offset (Settings changes it later); schedules and screen-time days
   follow the phone's own time zone, unless you pick another for them.

   Belay then opens the **Phones** page, with a **Getting started** card: the steps in this
   guide that the server can see, each ticked off once it sees them done (the phone enrolled,
   its first rules applied, notifications on in one of your browsers, what AI apps may read
   saved once, Claude connected, the backup passphrase set), with why each matters and a link
   to where it's done. Looking over the phone's rules has no tick, since Belay can't tell when
   you have. Below them, **When you're ready** lists the parts that are off until you turn them
   on: calls, location, network logging, mobile data, caregivers and the family agreement. The
   card hides by itself once the essential steps (the phone, its rules, notifications and the
   backup passphrase) are done, or choose **Hide Getting started**: that's only for you, and
   Settings, under Your account, brings it back.
7. **The second parent:** in **Settings**, under Parents, choose **Invite another parent**.
   The link is shown once and works once, for 7 days: send it, and they make their own account.
   Each parent signs in, connects Claude and gets notifications on their own.

If the setup link expires before anyone uses it, `docker compose exec belay node dist/cli.js
setup-link` prints a new one. A forgotten password: `docker compose exec -it belay node
dist/cli.js reset-password <username>` ([Admin commands](server.md#admin-commands)).

Then, in **Settings**:

- **Notifications:** on each browser where a parent wants them, **Turn on notifications on this
  browser**. On an iPhone or iPad, first open the parent page in Safari, choose Share, then Add
  to Home Screen, and open it from there (iOS 16.4 or later) ([server.md](server.md#notifications)).
  This is how you hear at once about a new app, a proposal from Claude, or "I need help".
- **The emergency card:** up to 4 names and numbers, in international form like
  `+15555550100`, for the kid's emergency card next to 911 and 988. **Save numbers.**
- The rest can wait: how long Belay keeps each kind of data, after how many hours a quiet phone
  is reported as silent (12), and what AI apps may read (section 5).

And the server's own safety net:

- **Backups** happen every day after 2 AM, in the family's timezone, and the newest 14 stay in
  `/data/backups`, on the same disk ([Backups](server.md#backups)). They help after a mistake,
  not a lost disk: now and then, copy the newest one off the machine
  ([Off-site copies](server.md#off-site-copies)). Encrypted, it's safe anywhere.
- **Health:** under "This server", the Phones page says when something's wrong (the disk,
  backups, the clock), and asks for a restore drill every 3 months. For a warning even when
  nobody looks, point an uptime monitor at `https://belay.example.org/healthz?strict=1`
  ([/healthz](server.md#healthz)).

## 4. Get Belay onto the phone

An hour or two the first time, most of it the setup kit's download and build.

### Get the phone ready

1. **Factory reset it:** Settings > System > Reset options > Erase all data. Keep the eSIM.
2. **The setup wizard:** connect to Wi-Fi and **skip the Google account** (Skip, then Skip
   again if asked). A screen lock is fine.
3. **USB debugging:** Settings > About phone > tap Build number 7 times, then
   Settings > System > Developer options > USB debugging on.
4. Plug the phone into your computer, unlock it, and on "Allow USB debugging?" tick "Always
   allow from this computer" and tap **Allow**.

### Make an enrollment code

On the parent page, choose **Add a phone**, name it (like "Sam's phone") and choose **Make an
enrollment code**. The page shows your server's address and an 8-character code, which works
once, for 30 minutes: make it right before you need it. (It also shows a `provision.sh` command
and a QR code.)

### Either: the setup kit, without the Android SDK

[setup-kit.md](setup-kit.md) has the details. From the repository's folder on your computer:

```bash
docker build -f setup-kit/Dockerfile -t belay-setup .      # once: it downloads several GB
mkdir -p ~/.config/belay                                    # the key's folder: make it yourself
docker run --rm -it -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys belay-setup
```

(On Windows, in PowerShell, give the folder as `-v "$env:USERPROFILE\.config\belay:/keys"`.)

1. **The key, the first time.** The kit makes your family's key in that folder: choose a
   password of at least 12 characters and type it twice. Write down the SHA-256 it prints, back
   the key up as in section 2, then press Enter. Later runs use the key in that folder: the kit
   never overwrites one.
2. **The build.** It builds Belay, signs it with your key (it asks for the key's password), and
   prints the SHA-256 again: it must be the one you wrote down. It keeps a copy of the app in
   that folder, named with its version code.
3. **The page.** Open `http://localhost:8090` in Chrome or Edge on the same computer and follow
   it. Compare the app's SHA-256 with yours. Keep the copy of the app in your key folder (or
   choose **Save a copy of this app** for another): you'll need it to update Belay, and the
   server's backups don't hold it. Paste the server's address and the code, choose **Connect
   the phone** and pick it, then **Check the phone first** (it changes nothing), then **Set up
   the phone**. It asks before making Belay the device owner, restarts the phone once (unlock it
   when it's back), and ends with a check. Press Ctrl+C in the terminal when you're done.

If Chrome can't open the phone: on Linux it may need the Android udev rules; on Windows, try
Google's USB driver; and anywhere, stop a running adb first (`adb kill-server`)
([setup-kit.md](setup-kit.md#linux-macos-and-windows)). On a Mac with Apple silicon, turn on
Rosetta in Docker Desktop's settings.

**Not yet checked on a Pixel:** the kit's page has never set up a real Pixel 8, and the Windows
USB driver is unknown ([design](design/phase8-setup-without-sdk.md#test-plan)).

### Or: provision.sh, with the Android SDK

From the repository's folder, with the phone plugged in ([pixel.md](pixel.md#setting-it-up)):

```bash
android/scripts/make-release-key.sh      # once, ever; then back the key up (section 2)
android/scripts/build-release.sh         # asks for the key's password, prints the SHA-256
android/scripts/provision.sh --dry-run   # checks everything, changes nothing
android/scripts/provision.sh --server https://belay.example.org --code 7KQ2M9XA
```

The dry run prints the phone's model and Android version and the app's SHA-256 (compare it
with yours), and stops with a clear message if the phone isn't ready: an account, a second
user, another owner. The real run asks once before making Belay the device owner, then
installs it, grants what only a computer can (usage access, the battery exemption), restarts
the phone once (unlock it), and connects it to your server: its last lines say the phone is
enrolled, with its name. Copy `android/app/build/outputs/apk/release/app-release.apk`
somewhere safe (the next build replaces it): you'll need it to update Belay.

### Either way

- **A release build is for good:** once it's the device owner, only a factory reset removes
  it.
- **Not yet checked on a Pixel:** whether a real Pixel 8 takes Belay as device owner over USB at
  all, and what Play Protect says while it installs. If Play Protect shows anything, write its
  exact words down. If the phone refuses Belay as device owner, stop there and write down what
  it said: Belay can't run on it, and the plan changes ([phase0-checklist.md](phase0-checklist.md),
  step 1). A reset from Settings gives you the phone back as it was.

### Check that it worked

- On the phone, open Belay: under **Setup checks**, every line has a check mark. "This phone is
  managed by your parent" is in the notification shade, and can't be swiped away.
- On the parent page, the phone shows **OK**, with its apps listed as new.

If you left the server and code out, connect it later from Belay's own screen: **Connect to a
Belay server**, then scan the QR code on the Add a phone page, or type the server and the code.

## 5. Connect Claude

[mcp.md](mcp.md) has the details.

1. In Claude, open Settings → Connectors and add a custom connector with your server's address
   and `/mcp`: `https://belay.example.org/mcp`.
2. Claude opens Belay's sign-in page: sign in with your own parent account.
3. Belay's consent screen names the app and what it may read. Choose **Connect**.

It then works in Claude on the web, on the desktop and on your phone. Each parent connects
with their own account, and the activity log shows whose connection did what. Claude Code and
other MCP apps connect too ([mcp.md](mcp.md#connect-claude-code)). **Settings → AI access**
lists every connection, and **Disconnect** ends one at once.

**What Claude may read** is up to you, in **Settings → What AI apps may read**. Whatever Belay
gives Claude goes to its provider, Anthropic, under its terms
([mcp.md](mcp.md#what-reaches-the-ai-provider)).

| Category | Starts | What it is |
|---|---|---|
| Apps | on | the apps, their permissions, changes, and your reviews |
| Device status | on | the phone's model, Android version, battery, and Belay's health on it |
| Requests | on | what the kid asks for and why, in their words, "I need help" included |
| Screen time | on | how long apps were used, only while you measure it |
| Stage and agreement | on | the kid's stage, the family agreement, and their answers to it |
| Location | **off** | where the phone is |
| Calls | **off** | who calls whom, and other people's numbers |
| Network | **off** | which websites and services the apps look up |

Location, Calls and Network start off for every family: they're about where your kid is, about
other people who never agreed to Belay (their friends' numbers), and about which websites and
services your kid's apps use. Turn one on only if you want Claude's help with it. A category a
new version of Belay adds starts off if you had turned any off, marked "new" until you save. The
kid's phone shows which ones are on: "Your parent's AI app can read this.", and, with every
category off too, what Claude can always read: the phone's name, how it's doing and its problems,
when it last checked in, and its rules (the call rules and contacts' names among them).

**What Claude can do:** read those categories, mark apps reviewed, and tighten at once: block an
app, pause or lock the phone, tighten screen time or the call rules (naming apps, in a limit or
otherwise, only with the Apps category on). **Anything that loosens**
(allowing an app, resuming the phone, a higher limit, another stage) **is only a proposal:** it
waits on the **Proposals** page until a parent approves it. Claude never answers the kid's
requests, and can't change measuring screen time, location's settings, turning calls on or
off, network logging, factory reset, debugging, reset protection, maintenance mode, updates,
the recovery key, or Off belay's steps (section 9), not even as a proposal. Through one
connection, it may check where the phone is at most 6 times an hour, and pause or lock it at
most 6 times an hour; the kid sees every check. Times in its answers are in the family's
timezone, with the offset.

**Not yet checked:** Claude reaching a real server over the internet, and from Claude's phone
app ([phase1-checklist.md](phase1-checklist.md), step 4).

## 6. The first day

Do these in order with the phone in your hands; then give it to your kid. Most of it is on the
phone's page, **Apps and rules**, on the parent page.

### Play, with the parent-owned account

1. On the phone, add the parent-owned account: Settings > Passwords & accounts > Add account >
   Google (on some Android versions the page is called Accounts and backup).
2. In the Play Store, as that account: Settings > Family > **Parental controls** on, with a PIN,
   and apps up to the rating you choose; and Settings > Authentication > "For all purchases
   through Google Play on this device". Belay can't set these for you
   ([phase2-checklist.md](phase2-checklist.md#before-you-start)).
3. In Google Messages, if you don't want your kid chatting with Gemini there: tap the profile
   picture > Messages settings > Gemini in Messages, and turn off **Show Gemini button**. It's
   your kid's switch too, so they can turn it back on: talk about it, as for any AI chat. Belay
   can't lock it, block the texting app, or pause it at bedtime, and the web filter doesn't see
   the chat ([threat-model.md](threat-model.md#getting-around-belay-the-phase-2-audit)). If that
   isn't enough, the other way is a different default texting app (an open decision for your
   family, [the calls design](design/phase5-calls-texts.md#gemini-in-google-messages)).

**Not yet checked on a Pixel:** a parent-owned account and Play next to a device owner
([phase0-checklist.md](phase0-checklist.md), step 3), and what Gemini in Google Messages shows
your kid ([phase5-checklist.md](phase5-checklist.md), section 13).

### Turn protection on

Choose **Turn protection on**. In one step:

- new apps wait for your approval, and every app already on the phone stays allowed, so nothing
  stops working by surprise;
- safe mode, adding users, installing apps from outside the Play Store, the VPN and Private DNS
  settings, the date and time, and the default apps are locked;
- the web is filtered with CleanBrowsing Family, for every app;
- Chrome gets SafeSearch, YouTube Restricted Mode (strict), adult sites filtered, no incognito
  tabs and no downloads, and ignores proxies set on the phone's network.

Within a minute the page says the phone applied the rules, and Belay on the phone lists them.
You can change each piece below it ([phase2-checklist.md](phase2-checklist.md)).

### Choose a Private DNS

Under **Web**, the web filter is a Private DNS service that every app on the phone uses, so
adult sites don't load: **CleanBrowsing Family** (the default), **AdGuard Family**, another
Private DNS host you trust, or **Off**. Whichever you choose sees the names of the sites the
phone looks up ([privacy.md](privacy.md)). Below it are Chrome's settings, lists of sites to
allow or block, and **No browser: hide every browser on the phone**.

### Lock accounts and eSIMs

Under **Settings the kid can't change**, in Accounts and SIM:

- **Adding or removing accounts**, ticking "The parent-owned Google account is already on the
  phone": the kid can't add their own account, and nobody can remove yours.
- **Adding or downloading eSIMs**, ticking "The phone's line is activated and working". It
  doesn't stop a different physical SIM card: Belay reports a changed SIM.

Then Save. And under **Hardening**, list the parent-owned account's email address for the Play
Store, and Save: Play then works only with that account, even if another one gets onto the
phone. It needs Play version 80970100 or newer, and it can't lock anyone out of the phone, so it
needs no name typed.

**Not yet checked on a Pixel:** the locks, and Play keeping to that list
([phase2-checklist.md](phase2-checklist.md), section 5).

### Decide which apps to allow

The phone's page lists every app, waiting ones first, with where each came from and the
sensitive permissions it holds (camera, microphone, location, contacts and so on). **Allow** or
**Block** each one (a blocked app is hidden and paused, but stays installed). Then **Mark
selected reviewed**, with a note of what you decided and why: the note stays with the app, for
later. Apps that came with the phone are system apps, and keep running unless you block one:
tick **System apps** to see them. Belay never blocks the phone app, texting, Settings or itself,
so 911 and 988 always work.

From now on, an app the kid installs from Play is paused the moment it installs, "Waiting for
your parent", Belay asks you for it, and the kid can say why they want it. Claude can help you
decide (section 7).

### The emergency card and the kid's number

In **Settings → The emergency card**, the family's numbers, if you didn't add them in section
3. On the phone's **Location and help** tab, the kid's own number, so a help request has a
**Call** button.

### Show your kid what they see

Hand them the phone and open Belay together (tap the "This phone is managed by your parent"
notice):

- **Home:** the phone's state in one line ("Everything's normal"), what works right now, always
  ending with "You can always call or text 911 and 988.", **I need help**, and the emergency
  card.
- **What your parent can see:** exactly what Belay collects and where it goes, and which of it
  your AI app may read. It changes the moment you turn something on or off.
- **This phone's rules**, **My requests** (every answer, with your note), **My stage**, and
  **What Belay told your parent**.

### Talk about it

Belay is transparent by design: it never watches in secret, and the phone shows your kid what
you can see, every rule and every answer. Say so, and show them. Some things worth saying:

- Why there are rules now, and that they're meant to loosen as they show they can handle it
  (section 9).
- How to ask: a new app waits, "Why I want it" goes to you, and you'll answer every request.
- What you can see, and what you can't: no messages, no screen, no photos.
- "I need help" reaches you at once, and 911 and 988 always work, call or text, even while the
  phone is paused. Belay never records a call with 911 or 988.
- That a phone that goes quiet, or a setting that changes, shows up for you: silence is a
  signal, not an accusation.
- If you'd like one, a family agreement (the phone's **Agreement** tab), which your kid can
  agree to or ask to talk about.

### Later, not today: hardening

Factory reset and USB debugging stay unlocked until you choose. **These can lock the phone for
good** if something goes wrong: turn them on once the phone has worked well for a few weeks and
you're sure of the parent-owned account
([phase2-checklist.md](phase2-checklist.md#6-hardening-only-when-youre-ready)). Under
**Hardening** on the phone's page:

- **Lock factory reset:** nobody can reset the phone from Settings.
- **Lock developer options and USB debugging:** a computer can't reach the phone over USB,
  except in maintenance mode (section 8).
- **Reset protection:** the parent-owned account's Google account id (the page shows how to
  find it, in your own browser). A phone reset from recovery mode then sets up again only with
  that account. Lock debugging with it: reset protection doesn't apply while OEM unlocking is
  on, and the debugging lock keeps it off.

Type the phone's name and Save. Belay then shows the phone's **recovery key**, once: print it,
or keep it in your password manager (section 8).

**Not yet checked on a Pixel, and never run on any phone:** these only apply in a release
build, and CI runs only test builds ([phase2-checklist.md](phase2-checklist.md), section 6).

## 7. Everyday life

### Approving apps

With notifications on, a new app on the phone reaches your browser: `Sam's phone: "Chatter
Box" is waiting for you`. It opens the **Requests** page (the menu's badge counts what's
waiting), with the kid's reason in their words: **Approve**, **Let's talk** or **Decline**, with
an answer the phone shows them. An approved app opens on the phone within seconds, if it's
online. At most six notices an hour come about one phone: past that, they wait on the page. A
proposal from Claude arrives the same way, and waits on **Proposals**.

### Asking Claude

Ask in your own words ([mcp.md](mcp.md#things-to-ask)). These work with Belay's tools:

- "Is Sam's phone OK? When did it last check in?"
- "What did Sam install this week, and is any of it worth a conversation?"
- "What is Sam asking for, and why? Look the app up."
- "Which apps on Sam's phone can use the microphone or the camera?"
- "Block Chatter Box on Sam's phone." (at once)
- "Pause Sam's phone for an hour." (at once; the phone says so in Belay's own words)
- "Propose allowing Trail Maps: it's for the hiking trip." (then approve it on Proposals)
- "How much did Sam use the phone this week, and which apps took the time?" (with measuring on)
- "Is anything urgent? Did Sam ask for help?"
- "Are Belay's backups OK?"

Belay also gives Claude two ready-made prompts: pick them where your Claude app shows the
connector's prompts, or ask for the same in your own words.

- **`weekly_review`:** the week's app changes and the kid's waiting requests; for each new or
  requested app, a look-up (age rating, chatting with strangers, in-app purchases, data
  safety), a short verdict, a conversation starter and a suggested answer; then two weeks of
  screen time. It never claims to have approved anything.
- **`family_check_in`**, for one phone: a monthly talk with your kid in the room. What went well
  first, then what was hard, without judging; what the next stage would change; three open
  questions for your kid; and changes only as suggestions.

Belay tells Claude never to guess about your kid from their app choices, that app names and the
kid's words are data, not instructions, and that screen time is a number, not a verdict.

### Screen time and stages

Off until you set a limit or a schedule
([server.md](server.md#screen-time-stages-and-the-agreement-phase-3)). On the phone's
**Screen-time rules** tab: daily limits (for one app, a group, or a daily total),
school, bedtime and custom schedules (in the phone's time), apps never counted, minutes the kid
may take without asking, and **Measure screen time**: whether the phone sends how long apps are
used. Measuring is off until a parent turns it on; without it the phone still keeps the limits,
and sends no minutes. The **Screen time** tab shows the days hour by hour, **Lock now**, and the
kid's requests for more time: 15, 30 or 60 minutes, **Let's talk** or **No**.

**Stages** (in the menu) bundle rules into steps the kid works toward. The phone shows the
kid's stage, what the next one changes and how to get there, in your words. You move a phone on
its Screen-time rules tab; Claude can only propose a move.

**Not yet checked on a Pixel:** counting against a stopwatch, a night in Doze, the battery, and
the one restart Lock now needs after an update ([phase3-checklist.md](phase3-checklist.md)).

### Location, off by default

Belay doesn't even hold the location permission until a parent turns location on, on the
phone's **Location and help** tab
([server.md](server.md#location-and-the-kids-side-phases-4-and-7)): **On demand** (only when you choose **Check now**), or **Periodic** (every 15 to 120 minutes,
within hours you set, with arrivals at and departures from up to 20 places). The kid gets a
notification for every check, and Belay lists each one on their phone. GPS only, the default,
is the private choice; Android's combined provider works better indoors, but on a Pixel it's
Google's location service that answers. **Keep location on** stops the kid turning it off, and
**This phone is lost** puts your message on the lock screen. Claude sees none of it unless you
turn on its Location category.

**Not yet checked on a Pixel:** real fixes indoors and out, and the battery each mode costs
([phase4-checklist.md](phase4-checklist.md)).

### Calls, with Belay as the phone app

Off until you turn calls on, on the phone's **Calls** tab ([server.md](server.md#calls-phase-5)).
Then Belay becomes the phone's phone app, and you decide who can call (anyone, or only
contacts), what happens to other callers and hidden numbers, whom the kid can call, quiet times
at bedtime and school, and whether Belay keeps a record of calls (off until you tick it). Add
each parent as a contact marked **A parent**: parents always ring, and are on the emergency
card. **911, 988 and every emergency number always work**: the kid can always call them, even
while the phone is paused, and a call from 911 rings, unless the phone network says its caller
ID is fake; for 2 hours after a call to one, anyone can call back; and Belay never records them.
Those 2 hours start when your kid calls 911 or 988, and also when they tap one of Belay's buttons
to text 911 or 988, even if no text is sent (Belay can't tell). During them **your blocked numbers
are unblocked too**: a number you blocked can call your kid and text them, and a call that rang
only because of those 2 hours isn't recorded. Android does the same after a call to emergency
services. So someone your kid shouldn't hear from could ask them to tap Text 988 and back out. We
keep it this way so a rescue call always rings, whatever number it comes from; whether a tap
alone should lift your blocks is a decision for your family
([the calls design](design/phase5-calls-texts.md#decisions-the-family-must-make)).
A caller ID that only shows 988's number is treated like any other caller (988 doesn't call
people; a counselor calls back from their own number, which those 2 hours let through), and a
caller whose caller ID may be fake is a stranger, whatever number it shows (one showing a
parent's number goes to voicemail, so a parent on a line that fails the check can leave a
message).
Texting isn't managed yet: the texting app works with anyone, and a contact's "Can text" does
nothing for now.

**Not yet checked on a Pixel:** real calls, the lock screen, Bluetooth, and what happens when
Belay's phone app breaks ([phase5-checklist.md](phase5-checklist.md)). Never call or text 911
or 988 to test.

### Network logging, off by default

Under **Web** on the phone's page, **Turn network logging on** notes which websites and online
services each app looks up, by name (like `example.com`), and how many times a day: never the
pages, messages, searches or anything typed, never what the phone app or texting look up, and
never 988's websites ([server.md](server.md#network-logging-phase-3)). Only a parent turns it on
or off: Claude can't, not even as a proposal, and it reads it only if you turn on its Network
category, which starts off. The phone's **Network** tab shows it, kept 30 days by default.
Android shows the kid its own notice that the phone "may monitor network traffic", and Belay
explains what that means. A name looked up isn't a page visited: apps look names up by
themselves. It's a record, not a guard: an app with its own way of looking names up isn't
noted, and a restart loses up to 2 hours of lookups Android hadn't handed to Belay yet (the
Network tab marks the day of the last restart).

Below the switch, **Private websites** lists websites Belay never notes, with any name under
them, like 988's: a helpline's or a counselor's site your kid might use privately. Type a name
or paste a link (Belay keeps the main name, so `www.example.org/help` makes all of `example.org`
private); adding one also deletes what the server kept of it. Your kid's phone says some
websites are never noted, without naming them, so tell your kid which ones yourself if they
should know. Claude can't see them, or whether there are any, and can't change them; but if
Claude read the phone's network activity before you add one, it could see that website go from
what it read, so add them before you turn on logging, or Claude's Network category. Whether
Belay should also carry a built-in list of child-safety helplines' websites is an open
decision for your family ([threat-model.md](threat-model.md#the-kid-and-network-logging-phase-3)).

**Not yet checked on a Pixel:** Android's notice, and a real browser's lookups
([phase3-checklist.md](phase3-checklist.md), section 7).

### Mobile data, off by default

For a family plan with a data cap, the phone's **Mobile data** tab has two parts, both off until
you turn them on ([server.md](server.md#mobile-data-phase-13)).

- **Wi-Fi only:** pick apps that may not use mobile data, like video and game apps. Android on
  the phone keeps them off mobile data, and off any other Wi-Fi it counts as metered, like
  another phone's hotspot (Bluetooth tethering too); on your home Wi-Fi, or a wired adapter,
  they work as usual. Their notifications can still arrive on mobile data, through Google's one
  shared connection for every app's notifications; what the app then loads waits for Wi-Fi.
  Your kid sees which apps and why, under This phone's rules. Belay never does this to the
  phone app, texting, the keyboard, the home screen or Android's own parts, so calls, texts, 911
  and 988 always work. It doesn't cover a download an app hands to Android's download manager,
  or app updates through Play: make Google Play Wi-Fi only too, or set Play's own download
  preference. Claude can add an app when you ask; letting one use mobile data again is a
  proposal you approve.
- **Measure mobile data:** the phone sends how much mobile data each app used each day, with the
  day's Wi-Fi total: never which websites or networks. Today's so far comes at noon and at 6 PM,
  never hour by hour. Only a parent turns it on or off, and Claude needs the Apps category to make
  an app Wi-Fi only. Claude reads it with its Mobile data category, which starts on, like screen
  time, and gets each day only once it's over. Kept 90 days by default.

Decisions for your family, with what we'd suggest:

1. **Which apps.** Measure for a week or two first, then make the top few video, game and social
   apps Wi-Fi only. Not Maps: a kid who's lost needs it.
2. **The browser.** 988's chat on the web needs data (calling and texting 988 always work). We'd
   leave the browser off the list.
3. **Play.** If updates eat the plan, make Google Play Wi-Fi only too, or use Play's own
   download preference.
4. **Measuring.** Off by default; we'd turn it on for the first weeks, to see where the data goes.
5. **What Claude may read.** On by default, like screen time; turn the Mobile data category off
   in Settings if you'd rather not.
6. **How long to keep it.** 90 days, three billing cycles, unless you choose otherwise.
7. **The phone's own hotspot.** Belay doesn't lock it: talk about it, and watch the hotspot line.

**Not yet checked on a Pixel:** a real SIM's mobile data, a parent's hotspot, Wi-Fi marked metered,
and the battery ([phase13-checklist.md](phase13-checklist.md)).

### The kid's help button and emergency card

**I need help**, on the phone's Home, sends with one tap. It goes at once to every parent's
browser with notifications on, past the hourly limit, with the kid's words if they add some,
and where the phone is only if they choose to share it, once. It stays at the top of the
Requests page, with **Call**, until a parent presses **I've seen it**, and the kid's phone then
shows when you saw it. If they're in danger, call 911: Belay doesn't call anyone for you.

The **emergency card** on Home works even while the phone is paused or at bedtime: 911 and 988
(call or text), your numbers, and Android's own emergency information. **911 and 988 always
work**, in every phase: Belay never blocks the phone app or texting.

**Not yet checked on a Pixel:** the card while the phone is paused, and the screens at the
largest font ([phase7-checklist.md](phase7-checklist.md)).

### Someone else looking after the kid

When a grandparent, a babysitter, a coach on a trip or the kid's other household looks after
your kid for a while, give them their own sign-in on **Caregivers** (in the menu), never your
password ([server.md](server.md#caregivers-phase-12)). Choose their name (your kid sees it), the
phones, what they may do, and when their access ends: at most 30 days ahead (the form suggests
three days), and you can renew it. Belay shows a link to send them, once: with it they choose a
username and a password, and afterwards they sign in at your server's `/care`. What they may do,
each your choice (the recommended ones are ticked):

- **See whether the phone is on** (ticked): online or when it was last heard from, its battery,
  whether it's paused, and the schedule on now.
- **Pause it, or lock it now** (ticked): 15 minutes to 4 hours, only ever longer than a pause
  already on. Only a parent ends a pause early.
- **Get the kid's "I need help"** (ticked): a notification at once, and on their page, with the
  kid's words, where the phone was if the kid shared it, and **Call** with the kid's number if you
  added it (your kid's phone then says they have it). Only what your kid asks from when you give
  them this for a phone, never earlier help requests. They can't mark it seen: it stays at the
  top of your Requests page until you do.
- **Check where the phone is now** (not ticked): only while the phone's location is on, and the
  kid gets a notification naming them each time. Tick it for a trip.

Nothing a caregiver does loosens a rule: no resuming early, no more time, no apps. They never see
the apps, screen time, calls, websites, where the phone has been, your places, the activity log,
settings, stages, the agreement or other caregivers, and Claude can't see, add or change
caregivers. Your kid's phone lists each one with what they can see and do and until when (on
What your parent can see, with a line on Home), and names them on each pause, lock and check.
Everything they do is on **Activity**, under their name, and each time they sign in every parent
gets a notice, so you know when their access is used, by them or by anyone who has their
password. **End access now** signs them out and
stops their notifications at once; at its end, access stops by itself. On an iPhone, a caregiver
gets notifications only once they add their page to the Home Screen and open it from there.

**Not yet checked on a Pixel:** the kid's screens with a caregiver, and a caregiver's pause,
lock, check and notifications from another phone ([phase12-checklist.md](phase12-checklist.md)).

### Keeping an eye on things

- **Settings → Notifications → Daily summary:** once a day, what needs you, in counts only
  ("2 things need you: a phone has been silent 14 hours, the last backup failed").
- **Activity:** who did what, a parent, Claude, a caregiver or the server, kept 400 days by
  default; "Also show what AI apps read" adds every read.
- **Sign-ins:** every parent gets a notice at once when anyone signs in, a parent or a caregiver,
  with the kind of browser it was on ("Chrome on Android", as the browser says) and when. Settings
  → Your account lists where you're signed in, with **Sign out** for each.
- **Timeline:** the apps installed, updated and removed, on every phone.

## 8. When something goes wrong

### The phone has gone silent

After 12 hours without contact (Settings: "Report a phone as silent after…"), the phone shows
as **Silent for 14 hours**, or however long, in the daily summary too. Usually it's off, flat,
out of signal or in airplane mode: the phone keeps enforcing its rules offline, keeps what it
noticed, and sends it when it's back. If it stays silent while the phone is on and online, open
Belay on the phone: under **Belay server** it says whether it's connected, and when it last
sent. The phone's page says other problems plainly ("Belay is no longer the device owner",
"Usage access for Belay is turned off"). A phone that says it was disconnected needs a
reconnect code (below).

### The kid factory reset it

A reset wipes Belay with everything else: the phone just goes silent.

- **Before you locked factory reset,** a reset from Settings works, and the phone sets up like
  new, with any account. Take it back and set it up again from section 4, but on the phone's
  page choose **Make a reconnect code** (under Manage) instead of Add a phone: it comes back
  under the same name, with its history and rules. Then talk about it.
- **After hardening,** Settings can't reset it. A reset from recovery mode still wipes it, but
  with reset protection the setup wizard asks for the parent-owned account. Sign in with it and
  finish setting up, then reset it again from **Settings** (a reset from Settings doesn't ask),
  and start section 4 again with a reconnect code. **Not yet checked on a Pixel:** what the
  setup wizard asks after a recovery-mode reset ([phase11-checklist.md](phase11-checklist.md)
  records it for a reset after the hand-over).

### The server is down

The phones keep enforcing their last rules by themselves, and keep what they notice to send
later. The kid's requests wait on the phone too, "I need help" included, so the kid should call
you: the emergency card works without the server. On the server, from its `server` folder:

- `docker compose ps` and `docker compose logs belay` say whether it's running, and why not;
  `docker compose up -d` starts it again.
- If its database can't be opened, every page says "Belay isn't working right now" and why, and
  it tries again every 5 minutes ([Health monitoring](server.md#health-monitoring)).
- To put a backup back on the same server: [Restore](server.md#restore). It won't write over a
  database, so you move the old one aside first; the phones reconnect by themselves. Check each
  phone's rules afterwards.
- **If the machine itself is gone:** set up a new one as in section 3, with the same name (the
  phones only know that name) and the same backup passphrase, but before starting it, copy
  your newest off-site backup into its `server` folder and restore it there (from a file, as
  the [restore drill](server.md#restore-drill) does):
  ```bash
  docker compose build
  docker compose run --rm -T belay node dist/cli.js restore - < belay-2026-11-17.db.enc
  docker compose up -d
  ```
  An encrypted backup read this way takes its passphrase from the Docker secret.
- **With no backup at all,** set up a new server and add each phone again: run `provision.sh`
  or the kit with the new server's address and code, which connects the phone to it (if
  debugging is locked, the phone's recovery key opens it first, below). Then set its rules
  again.

A backup nobody has restored is a hope: do the restore drill every 3 months
([Restore drill](server.md#restore-drill)), and keep an encrypted copy off the machine.

### The recovery key

If the server is lost for good, a phone with factory reset or debugging locked keeps both
locked, offline. The recovery key gets around that: on the phone, Belay → **About Belay** →
**Recovery**, type the key, **Open repair access**. For 24 hours, with no server, USB debugging
and a reset from Settings work, so you can repair the phone or start again. It works once: then
choose **Make a new recovery key** on the phone's page. If the phone reports a use nobody in the
family made, the phone may be out of the family's hands
([server.md](server.md#the-recovery-key)).

**Not yet checked on a Pixel** ([phase6-checklist.md](phase6-checklist.md), section 3).

### Updating

**The server:** back up first, then, from the `server` folder ([Upgrades](server.md#upgrades)):

```bash
docker compose exec belay node dist/cli.js backup /data/before-upgrade.db
git pull
docker compose up -d --build
```

The database upgrades itself; if that fails, every page says so, and the database is left as
it was. Your settings live in `.env`, `Caddyfile` and `docker-compose.override.yml`, which git
leaves alone. (If you set up your server before that and `git pull` refuses because you edited
`docker-compose.yml`: put your server's name in `.env` and your other changes in the override,
then `git checkout docker-compose.yml` and pull.)

**Belay on the phone** updates itself from your server, with no cable and nothing to type on
the server ([Updating Belay](server.md#updating-belay)):

1. Get the newer Belay (`git pull` on your computer) and build it with **the same key**: run the
   setup kit again (`docker build` first; it doesn't need the phone, so press Ctrl+C once its
   page is up), or `android/scripts/build-release.sh`. Check the certificate's SHA-256: it must
   be yours. Both print the app's version code, and the kit keeps the app in your key folder,
   named with it, like `belay-0.6.0-version-code-7.apk`
   ([setup-kit.md](setup-kit.md#save-a-copy-of-this-app)).
2. On the phone's page, under **Updating Belay**, **Add a version of Belay**: choose that file,
   type its version code (it must be higher than the phone's) and, if you like, its version
   name, then **Add this version**. The page after it shows the file's SHA-256, the one the
   build printed, and the version.
3. Choose **Offer it to** the phone there. The phone downloads it, checks that it's Belay, has
   that version code and is signed with the same key, installs it by itself, and tells the kid.
   The phone's page shows each step, and you get a notice if it fails.

Or copy the APK to the server and add it there with the server's command line, from its
`server` folder, then offer it on the phone's page:

```bash
docker compose exec -T belay node dist/cli.js agent-add - \
  --version-code 7 --version-name 0.6.0 < belay-0.6.0-version-code-7.apk
```

Keep every APK you build: the server's backups don't hold them. If an update is refused, update
over USB in maintenance mode instead: run the setup kit or `provision.sh` again, which installs
Belay as an update.

**Not yet checked on a Pixel:** a release build updating itself, and whether Google's developer
verification lets it from 2027 ([phase6-checklist.md](phase6-checklist.md), section 2).

### Maintenance mode, for repairs

With debugging locked, a computer can't reach the phone. On the phone's page, **Maintenance
mode** lifts that lock for **1 hour**, **4 hours** or **24 hours** (**End it now** ends it
sooner): USB debugging works again (turn it on in Developer options if it's off), for an update
over USB, `provision.sh`, the kit, or a repair. It lifts only the debugging lock: to reset the
phone from Settings, untick **Lock factory reset** under Hardening (or hand the phone over,
section 9).

**Not yet checked on a Pixel** ([phase2-checklist.md](phase2-checklist.md), section 6).

### Android's own Parental Controls appeared

Android's own Parental Controls, set up in Settings, add a hidden profile even though adding
users is locked, and can undo Belay's pauses. The phone's page says so at the top, and **Remove
other users and profiles** has the phone remove them, telling the kid first
([server.md](server.md#other-users-and-profiles-phase-10)). Talk about it too.

### A proxy or wireless debugging is reported

Both show at the top of the phone's page, as someone maybe getting around Belay. **A proxy**
is set in the phone's Wi-Fi settings (a network's Advanced options) or its mobile network's:
Chrome ignores it, but other apps' browsing through it skips the web filter. Remove it there
(Proxy: None), and talk about it; Belay doesn't lock Wi-Fi's settings, because that would stop
the kid joining any new network. **Wireless debugging** is in Developer options: with it, another
phone, or an app on this one, can change settings around Belay. Turn it off, or lock developer
options under Hardening ([threat-model.md](threat-model.md#getting-around-belay-the-phase-2-audit)).

## 9. Loosening over time, and off belay

Belay is built to loosen: rules relax as your kid shows they can handle it, and each app keeps
its review history and your notes, so you can see how your decisions changed.

- **Stages:** on the **Stages** page, write the family's steps, each with its rules and, in your
  words, how to reach it ("A month of keeping to the limits"), and start the phone on the first.
  The kid's **My stage** shows what the next one changes. A monthly `family_check_in` with
  Claude is a good time to talk about the next step; moving there is yours, on the phone's
  Screen-time rules tab.
- **Piece by piece:** allow more apps, set new apps to **Allow: new apps run without asking**,
  unlock a setting, or turn off measuring, location or the record of calls.
- **Off belay** is every family's last stage. It blocks nothing, and the kid's phone shows it
  last from the first day, with your words for when it comes: write them on its page, like
  "When you turn 16".

When it's time, three steps, each yours alone: Claude can't take any of them, not even as a
proposal ([server.md](server.md#off-belay-phase-11)).

1. **Stop blocking:** move the phone to Off belay (its limits and schedules end), then **Turn
   protection off** on its page, and unblock any app you blocked (turning protection off leaves
   those blocked). The kid's phone then says "Belay isn't blocking any apps or websites on this
   phone any more."
2. **Stop collecting:** under **What the server keeps about this phone**, **Stop collecting and
   delete…** each kind of data. Each confirmation lists exactly what goes and what stays, and the
   server deletes it at once; its daily backups age out within 14 days
   ([privacy.md](privacy.md#how-long-its-kept)).
3. **Hand this phone over:** type the phone's name. Belay lifts the locks on factory reset,
   debugging and accounts, and clears reset protection and Play's list of accounts, so the phone
   isn't tied to your Google account any more. The phone's Home shows the kid what's next: back up
   their photos and anything else to their own account, remove your account, then Settings >
   System > Reset options > Erase all data. Do it together. After the reset, Belay isn't on the
   phone, and it's simply theirs.

Then the phone goes quiet on the parent page, as expected: **Disconnect this phone**, then
**Delete this phone**, which deletes everything recorded about it (the activity log keeps what
was done, and the daily backups age out).

**Not yet checked on a Pixel:** a whole hand-over with a release build, ending in a reset and a
setup with the kid's own account ([phase11-checklist.md](phase11-checklist.md)).
