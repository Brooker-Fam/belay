# Privacy

Belay is built so a parent can see what they need to keep a first phone safe, the kid
knows exactly what that is, and nobody else sees any of it.

## What the phone collects (Phase 1)

Only these two kinds of data, the same two the kid sees on the phone under "What your
parent can see" (built from the code that collects them: `inventory/Collectors.kt` and
`core/DataCategory.kt`):

**The apps on the phone**

- each app's name, package name and version, when it was installed and last updated, and
  whether it's a system app, turned off, or has an icon in the launcher;
- where it came from (the Play Store, another store, a downloaded file, a computer) and
  which app installed it;
- which sensitive permissions it holds: camera, microphone, location, contacts, texts,
  call history, photos and media, nearby devices, and special access (reading
  notifications, accessibility, device admin);
- when an app is installed, updated or removed, and how Belay noticed.

**How the phone and Belay are doing**

- the phone's model, Android version and security update date;
- battery level, whether it's charging, free storage;
- when it last restarted, its timezone and clock (to spot a wrong clock);
- whether Belay is still device owner and has the permissions and battery exemption it
  needs.

**What the kid asks for (Phase 2)**

- which apps they ask for and when: Belay asks by itself for each new app that waits for a
  parent;
- what they write in "Why I want it", up to 500 characters, in their own words.

**What Belay enforces (Phase 2)**

- the rules version the phone applied, how many apps it holds back, and what it couldn't do;
- a changed SIM card (opaque ids, never the phone number), and another user or profile on the
  phone, such as Android's own Parental Controls.

**Belay itself (Phases 6 and 10)**, all part of "How Belay and the phone are doing":

- the SHA-256 fingerprint of the key Belay is signed with (the server pins the first one it
  sees, so it can tell a different Belay);
- how an update the parent chose is going (downloading, checking, installing, done, or
  Android's own words when it refused), when the recovery key was last used and until when it
  opened repair access, and the result of each thing the parent asked Belay to do (like
  removing another user);
- which apps the phone never blocks (Belay, the phone and texting apps, the keyboard, the
  home screen and Android's own parts), so the parent page doesn't offer to block them;
- how many other users or profiles there are (a count: nothing about what's on them), and the
  names of phone settings something other than Belay has locked, like `no_factory_reset`.

Nothing new about the kid's own use of the phone: no content, no names, no accounts.

**How long apps are used (Phase 3), only while the family has screen time on.** The phone
counts it itself, from Android's usage events, to keep the limits and schedules: which app
is on the screen, from when to when, and when the screen is on and unlocked. What it *sends*
depends on the policy's `measure`, which only a parent sets (never an AI app):

- With `measure` on (the kid sees "How long you use apps"): each day's minutes per app and how
  many times each was opened, the screen minutes in each hour and the number of unlocks, and
  the times Belay couldn't count (usage access off, the phone off). The phone app, the texting
  app, the home screen, Settings, the keyboard, Belay and Android's own parts are left out of
  the per-app list, so a call or text to 988 never shows (their time still counts in the
  screen minutes). Only what was counted after a parent turned it on is sent: the part of that
  first day before is sent as "couldn't count". Turning it off drops what's still waiting.
- Always, while screen time is on (the kid sees "Whether your time limits are used up" when
  `measure` is off): whether each limit is open, used up or running on extra time today,
  which schedule is on, whether Belay can count, and the self-serve minutes the kid took and
  when. With `measure` on, the minutes used and left on each limit and today's screen minutes
  too.
- The kid's requests gain two kinds: more time (how many minutes, for which limit and app,
  and their own words if they write some) and their answer to the family agreement ("I agree"
  or "I want to talk about it", and their words).
- On the server: a usage day sent while measuring is off isn't kept, and the time of the
  apps the phone never blocks isn't kept even if a phone sends it. AI apps read usage only
  with Settings' "Screen time" category on, and the stage, the family agreement and the kid's
  answers to it only with "Stage and agreement"; the more-time requests are under "Requests".

Not collected: what's on the screen, what's typed, websites, notifications, or anything inside
an app. Network logging (which domains apps look up) is a later part of Phase 3, off by
default, and not built yet.

**Where this phone is (Phase 4), only while a parent turns it on.** Off by default: Belay then
holds no location permission at all. A parent chooses, on the phone's Location and help page
(never an AI app):

- **On demand:** one fix each time a parent (or their AI app, if they allow it) checks. The kid
  gets a notification for every check, naming the AI app when one asked.
- **Periodic:** a fix every 15 to 120 minutes, within the hours the family sets, and when the
  phone arrives at or leaves one of the family's places (their names are on the kid's screen).
- **Lost mode**, in any mode: a fix every 5 minutes until a parent turns it off.

Each fix is a time, a latitude and longitude to 5 decimal places (about a meter), how accurate
it is, which of the phone's providers answered (its own GPS, or Android's combined provider,
which on a Pixel is Google's location service), and whether Android says an app made it up. The
server keeps only what the rules asked for, and drops the rest. Belay never collects a "trail":
the parent page shows the last fix, each check, and arrivals and departures.

**What the kid sends for help (Phase 7):** "I need help" (when, and a few words if they write
some), and, only if they tap "Share where this phone is, this once", one fix, even while
location is off. "Talk to my parent" with what they'd like to talk about. Withdrawing a
request they made.

**Not collected in Phase 1:** messages, calls, contacts, photos, files, browsing, searches,
location (Phase 4 adds it, off by default), what's on the screen, or how long apps are used. Later phases add some of these
only as listed in [ROADMAP.md](../ROADMAP.md), each shown to the kid on the phone first,
and some (location, network logs) off by default for AI.

## When it's sent

- An app change: as soon as Belay notices it (it waits in an outbox while the phone is
  offline, and goes out in order when it's back).
- A check-in with the phone's status: every 2 hours.
- The whole app list: once a day, after every restart, and right after the phone connects
  to the server.
- Changes Belay noticed before the phone was connected to a server are sent when it
  connects, and the phone's screen says so.
- Phase 3, with `measure` on: today's usage every 15 minutes or so while the phone is used
  (nothing while it isn't), each day once more when it's over, and yesterday and today again
  if the phone's clock moves. Where the limits stand goes with each check-in, and a check-in
  goes early when a limit runs out, a schedule starts or ends, or usage access changes.

The camera is used only to scan the enrollment QR code, only if the person scanning
allows it, and only while that screen is open. Camera frames are never stored or sent.

## Where it lives

- **On the phone:** Belay's own private storage: its app list, its recent changes (the
  last 300), the changes waiting to be sent (sent ones are kept 7 days), and its device
  token, encrypted with an AES key in Android Keystore. Phase 3 adds Belay's own count of
  screen time, for yesterday and today only (the minutes each app was on the screen, not what
  was on it), and the kid's self-serve minutes of the last 3 days; both are deleted when the
  family turns screen time off. A usage day that was sent is deleted from the phone at once.
- **On the family's server:** one SQLite database in `/data`, on a machine the family
  controls ([server.md](server.md)). Nothing goes to Belay's authors or anyone else. There
  are no analytics, telemetry, ads or crash-reporting SDKs, in the agent or the server.
- **In backups:** the server's own daily backups in `/data/backups` (the newest 14), and any
  copies the family makes ([server.md](server.md#backups)). A backup holds everything in the
  database. With a backup passphrase the family sets, they're encrypted (AES-256-GCM, a key
  made from the passphrase): a copy kept off the machine can't be read without it, so it's
  safe on its own. Unencrypted ones are as private as the server.

The phone only talks to the family's server. The server never sends family data in readable
form to anyone, and makes only two kinds of outbound request:

- reading the public client metadata document of an allowlisted AI client (claude.ai's)
  when a parent connects it, with no family data in the request;
- from Phase 2, push notifications to a parent's own browser, if that parent turned them
  on. They're end-to-end encrypted (Web Push): the browser's push service (Google, Apple or
  Mozilla) carries them but can't read them. It only sees that a notification was sent.
  Notices about the server itself, and the daily summary a parent can turn on, carry only
  counts and kinds of problems ("2 things need you: a phone has been silent 14 hours, the
  last backup failed"): no phone's or app's name, and nothing the kid wrote. A help request's
  notice carries the kid's words, and an arrival's the place's name, encrypted like the rest;
  never coordinates.

Where the phone is never leaves the family's server either. The server describes a fix by the
family's own places, by itself, and calls no map, tile or address service. "Open in a map" is a
plain link on the parent page: only the parent's browser follows it, when the parent clicks,
and then the map site the family picked (OpenStreetMap by default, or Google Maps) sees those
coordinates, as it would if the parent typed them in.

From Phase 2, when a parent turns protection on, the phone uses a filtering DNS service so
adult sites don't load: CleanBrowsing Family by default (AdGuard Family, a host of your
own, or none are the alternatives). Filtering works by sending the phone's DNS lookups,
the names of the sites it opens, to that service. That's the one thing the phone itself
sends outside the family's server, and the parent page says so where you choose the filter.

## Who can see it

- **Parents,** on the parent page, with their own accounts.
- **AI apps a parent connects** (like Claude), through MCP, and only the categories the
  parents allow in Settings: apps, device status, (from Phase 2) requests, the kid's own
  words, and (from Phase 3) screen time, and the stage and agreement, all on by default (a
  category added in an upgrade starts off for a family that had turned one off, and Settings
  marks it new). **Location** (Phase 4) is the exception: off for every family until a parent
  turns it on; until then an AI app sees whether a phone shares where it is, never where. The
  server's own health (its backups, disk and clock) is open to them too; it holds no family
  data. What an AI app reads goes to its provider under that provider's terms.
  [mcp.md](mcp.md#what-reaches-the-ai-provider) lists exactly what that is. Every read is in
  the activity log, and every check of where the phone is, a parent's or an AI app's, is on
  the kid's phone too. The kid's own phone number (for "Call") is only on the parent page.

## What the kid sees (Phase 2)

- When a new app waits: a quiet notification naming it, and on Belay's screen a "Why I want
  it" box.
- Every answer, with the parent's note, who answered and when.
- While the phone is paused: the parent's note and until when.
- Which apps are blocked, and "This phone's rules": only the locks Belay actually applied,
  each with why, and that calling or texting 911 and 988 always works.

## What the kid sees (Phases 6 and 10)

- **Updates:** Android's own "Updated by your admin" notice, and Belay's: "Belay was updated
  to version … by your parent." Under About Belay, how an update the parent chose is going.
  Belay never asks the kid to confirm one, and installs nothing but Belay itself.
- **The recovery key:** a "Recovery" screen under About Belay, for the parent: "For your
  parent, if Belay's server is gone. It opens repair access for 24 hours." It sends nothing
  and stores nothing typed there: the key is checked on the phone against the check the
  server sent (never the key itself), and only the count of wrong tries and the last use are
  kept. While the key's repair access is open, "This phone's rules" say so.
- **Commands:** before Belay removes another user or profile, the kid sees: "Your parent is
  removing Android's own Parental Controls from this phone, because Belay does that job."
  Only a parent can ask for that, or for an update (on the parent page or the server's
  command line), never an AI app.

## What the kid sees (Phase 3)

- **What your parent can see** gains "How long you use apps" the moment a parent turns
  measuring on (or "Whether your time limits are used up" while screen time only keeps the
  limits), generated from the collectors that are on, and loses it when it's off.
- **Today:** the time left for each limit ("20 minutes left today for Games"), the schedule on
  now ("School time until 3:00 PM"), every schedule with its days, "Ask for more time" (15, 30
  or 60 minutes, and why if they want to say) with the parent's answer, self-serve minutes when
  the family allows them, and that the phone app, the texting app, Belay, 911 and 988 always
  work. If usage access is off: why apps with a limit are paused, and "Turn usage access back
  on".
- **Notifications:** a warning before a limit runs out or a schedule starts, "Time's up for
  Games today. It comes back tomorrow at 12:00 AM." with "Ask for more time", bedtime with what
  still works ("You can still call and text your parents, 911 and 988."), and Belay can't
  count.
- **Your stage** and what the next one changes (in Belay's words from the two sets of rules, or
  the family's), and how to get there; **your family agreement**, in full, with "I agree" and
  "I want to talk about it".

## What the kid sees (Phases 4 and 7)

- **What your parent can see** gains "Where this phone is" while location is on, with how
  (when a parent checks, or every so many minutes between which hours, and the places' names),
  and, for each category, "Your parent's AI app can read this" when Settings lets it (the
  policy's `ai_reads`).
- **Every check:** a notification each time ("Your parent checked where this phone is", "…using
  Claude" when an AI app asked), and the list of the last 30 days' checks on Belay's screen,
  from the phone's own record. Android itself tells the kid when an admin app is allowed their
  location ("Your organization allows Belay to access your location"; platform note L1).
- **Lost mode:** "This phone is in lost mode", and the parent's message on the lock screen.
- **Help:** "I need help" (on every screen, even paused), what happens next, "Your parent saw
  this at 4:05 pm" once a parent has, and the emergency card: 911 and 988, call or text, the
  family's numbers, and Android's own emergency information.

## What the kid sees

- A notification that never goes away: "This phone is managed by your parent".
- In the Belay app: that the phone is managed, the list of what the parent can see (above,
  in plain words), whether it's connected to the family's server, and when it last sent
  its app list.
- Nothing is collected in secret, and there is no hidden mode.

## How long it's kept

Until a parent deletes it. Deleting a disconnected phone on its page deletes everything
recorded about it: its apps, changes and reviews, and from Phase 3 its screen time, rules,
requests and agreement. The server's daily backups still hold it until they age out, 14 days
later, as do any copies the family made. Expired sessions, codes and tokens are deleted
automatically. The activity log is kept so parents can see what happened.

Screen time (Phase 3) doesn't wait for a parent: the server keeps each day 13 months by
default (the family chooses 1 to 36 in Settings), then deletes it, with the extra time given
that day. Turning measuring off stops new days; the ones kept stay until they age out.

Where the phone was (Phase 4) doesn't wait either, and is kept much less: fixes shared on a
schedule 7 days, a parent's checks 30 days, arrivals and departures 90 days, lost-mode fixes
until 7 days after lost mode ends (the family chooses each in Settings, within limits), then
deleted by the hourly clean-up. The one fix a kid shares with "I need help" is kept with that
request, which, like every request, stays until the phone is deleted. Turning location off
stops new fixes; the ones kept stay until they age out.

## Respecting the kid

Some apps are private for good reasons: health, identity, crisis support. Belay's
instructions to AI apps say not to speculate about the kid from their app choices: describe
what an app does and its risks, not what it says about the kid. Emergency numbers (911 and
988) always work, in every phase.
