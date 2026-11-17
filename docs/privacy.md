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

**Not collected in Phase 1:** messages, calls, contacts, photos, files, browsing, searches,
location, what's on the screen, or how long apps are used. Later phases add some of these
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

The camera is used only to scan the enrollment QR code, only if the person scanning
allows it, and only while that screen is open. Camera frames are never stored or sent.

## Where it lives

- **On the phone:** Belay's own private storage: its app list, its recent changes (the
  last 300), the changes waiting to be sent (sent ones are kept 7 days), and its device
  token, encrypted with an AES key in Android Keystore.
- **On the family's server:** one SQLite database in `/data`, on a machine the family
  controls ([server.md](server.md)). Nothing goes to Belay's authors or anyone else. There
  are no analytics, telemetry, ads or crash-reporting SDKs, in the agent or the server.
- **In backups** the family makes ([server.md](server.md#backups)).

The phone only talks to the family's server. The server never sends family data in readable
form to anyone, and makes only two kinds of outbound request:

- reading the public client metadata document of an allowlisted AI client (claude.ai's)
  when a parent connects it, with no family data in the request;
- from Phase 2, push notifications to a parent's own browser, if that parent turned them
  on. They're end-to-end encrypted (Web Push): the browser's push service (Google, Apple or
  Mozilla) carries them but can't read them. It only sees that a notification was sent.

From Phase 2, when a parent turns protection on, the phone uses a filtering DNS service so
adult sites don't load: CleanBrowsing Family by default (AdGuard Family, a host of your
own, or none are the alternatives). Filtering works by sending the phone's DNS lookups,
the names of the sites it opens, to that service. That's the one thing the phone itself
sends outside the family's server, and the parent page says so where you choose the filter.

## Who can see it

- **Parents,** on the parent page, with their own accounts.
- **AI apps a parent connects** (like Claude), through MCP, and only the categories the
  parents allow in Settings: apps, device status, and (from Phase 2) requests, the kid's own
  words, all on by default. What an AI app reads goes to its provider under that
  provider's terms. [mcp.md](mcp.md#what-reaches-the-ai-provider) lists exactly what that
  is. Every read is in the activity log.

## What the kid sees (Phase 2)

- When a new app waits: a quiet notification naming it, and on Belay's screen a "Why I want
  it" box.
- Every answer, with the parent's note, who answered and when.
- While the phone is paused: the parent's note and until when.
- Which apps are blocked, and "This phone's rules": only the locks Belay actually applied,
  each with why, and that calling or texting 911 and 988 always works.

## What the kid sees

- A notification that never goes away: "This phone is managed by your parent".
- In the Belay app: that the phone is managed, the list of what the parent can see (above,
  in plain words), whether it's connected to the family's server, and when it last sent
  its app list.
- Nothing is collected in secret, and there is no hidden mode.

## How long it's kept

Until a parent deletes it. Deleting a disconnected phone on its page deletes everything
recorded about it: its apps, changes and reviews. Expired sessions, codes and tokens are
deleted automatically. The activity log is kept so parents can see what happened.

## Respecting the kid

Some apps are private for good reasons: health, identity, crisis support. Belay's
instructions to AI apps say not to speculate about the kid from their app choices: describe
what an app does and its risks, not what it says about the kid. Emergency numbers (911 and
988) always work, in every phase.
