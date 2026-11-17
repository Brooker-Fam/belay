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

**Where this phone is (Phase 4), only while a parent has location on.** Off by default: with
location off, Belay doesn't even hold the location permission (it's denied by policy, so Settings
shows Belay without it and nobody can grant it). Only a parent turns it on, on the phone's
Location and help page, never an AI app:

- *On demand:* one fix each time a parent asks ("Check now", or their AI app with `locate_now`
  while the AI scope is on), and nothing in between. The kid gets a notification for every
  check, naming the AI app when one asked.
- *Periodic:* also a fix every 15 to 120 minutes (the family's choice), only within the hours they
  set, sooner near the edge of a place they named; and "arrived" and "left" for those places,
  worked out on the phone (the places' names are on the kid's screen). No continuous tracking,
  no trail between fixes.
- *Lost mode* (any mode): a fix every 5 minutes until a parent ends it.
- Each fix is the time, the coordinates to 5 decimals (about 1 m), how close it is (accuracy),
  which provider answered ("gps", the phone's own receiver, by default; "fused", Android's
  combined provider, which on a Pixel is Google's service, only if the family chose it or allowed
  it as a fallback), why it was taken, and whether it came from an app that fakes locations.
- With it, whether Belay can use location and whether location is turned on, in the check-in.
- Coordinates go only to the family's server. The server keeps only what the rules asked for
  and drops the rest; the parent page shows the last fix, each check, and arrivals and
  departures. The server never sends them to a map or address service; a parent's "Open in a
  map" link is followed only by the parent's own browser.

**"I need help" and "Talk to my parent" (Phase 7).** The kid's own choice, from Belay's screen:

- "I need help": that the kid needs help, when, and what they write with it, if anything. Only if
  the kid taps "Share where this phone is, this once": one fix, in the help request, even with
  location off. Belay grants itself location for that one fix (and turns location on for it if it
  was off), then denies it again (and turns location back off) once Belay's screens are closed.
- "Talk to my parent": the kid's words. It changes no rule.
- When the kid changes what they wrote in a request that's still waiting, or takes one back.

**Calls (Phase 5).** Nothing until a parent turns calls on for the phone; then Belay is its phone
app. Call records only while a parent also turns on "Keep a record of calls" (`log`), each one:

- when, incoming or outgoing, how long, and what happened (answered, missed, refused, voicemail,
  or not placed because the rules didn't allow it) and why (not a contact, no caller ID, a quiet
  time, a number the kid may not call);
- the contact's id, or the number of someone who isn't a contact, so a parent can add or block
  them. Nothing for a caller with no caller ID.

Never what anyone says, and never a call with 911, an emergency number, 988 or one of the
family's private numbers: the phone doesn't record those at all, and the server drops any record
of one it gets (it also treats 988's full number, 1-800-273-8255, as 988). For 2 hours after the
kid calls 911 or 988 (or taps one of Belay's buttons to text them), every caller rings, so they
can call back; a call that rings only because of that is never sent either, since its record
would tell. "Please add this contact": the name the kid gives, the number and why. The contacts
themselves, and the private and blocked numbers, are the family's own choices, on the server and
in Belay's own storage on the phone (the blocked ones also on Android's own block list while
Belay is the phone app); Belay never writes them into Android's Contacts. While calls is on,
Belay reads Android's call log on the phone, and never keeps or sends what it reads there: to
notice a call to 911 or 988 made without Belay (which starts those 2 hours), and to show the kid
their calls with 911, 988 and the private numbers in Belay's recent calls, for as long as
Android's own log has them.

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
- Phase 4: each fix and place event as soon as it's taken (it waits in the outbox while the phone
  is offline). When a parent turns location off, the ones not sent yet are dropped.
- Phase 7: a help or talk request at once; a shared fix as soon as Belay has it.
- Phase 5: each call record after the call, only while the phone's rules record calls; a contact
  request at once. When a parent turns recording or calls off, the phone drops the records it
  hasn't sent yet. Records the server gets while it doesn't record calls are dropped, and only
  counted.

The camera is used only to scan the enrollment QR code, only if the person scanning
allows it, and only while that screen is open. Camera frames are never stored or sent.

## Where it lives

- **On the phone:** Belay's own private storage: its app list, its recent changes (the
  last 300), the changes waiting to be sent (sent ones are kept 7 days), and its device
  token, encrypted with an AES key in Android Keystore. Phase 3 adds Belay's own count of
  screen time, for yesterday and today only (the minutes each app was on the screen, not what
  was on it), and the kid's self-serve minutes of the last 3 days; both are deleted when the
  family turns screen time off. A usage day that was sent is deleted from the phone at once.
  Phase 4 keeps no history of where the phone was: only the last fix (for the next one near a
  place's edge), whether it's inside each place, and what it still has to send; a fix or place
  event that was sent is deleted from the phone at once, and all of it goes when location is
  turned off. Phase 7's "What Belay told your parent" is the phone's own list of the checks it
  ran for the last 30 days (when, and the AI app's name if one was used; no coordinates).
  Phase 5 keeps Belay's own recent calls, the last 30 days (at most 500): when, which way, how
  long, what happened and why, and the contact or the number; never a call with 911, an
  emergency number, 988 or a private number. They're the kid's recent calls, kept whether or not
  calls are recorded, and deleted, with any records not sent yet, when calls is turned off. When
  the kid last called 911 or 988 (or tapped a button to text them) is kept only for the 2 hours
  every caller rings, and never sent.
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
  **Calls** (Phase 5) are off for every family too, until a parent turns them on: call records
  and other people's numbers (contacts', blocked ones, and the one in a contact request) are
  about the kid's relationships, and about people who never agreed to Belay. Until then an AI
  app sees the call rules and the contacts' names, never who called or a number. Which numbers
  are private is never shown to an AI app, only how many.

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

## What the kid sees (Phase 4)

- **What your parent can see** gains "Where this phone is" the moment location is on, with the
  mode in plain words (and the interval, hours and place names), and loses it when it's off.
- **The Location card:** "Your parent can check where this phone is. You get a notification every
  time they do.", or "Belay shares where this phone is every 30 minutes, between 7:00 AM and 9:00
  PM.", the places' names, whether location is locked on ("Location is locked on. Your parent
  decides this."), how many checks in the last 30 days, and what Android's own "your organization
  allows Belay to access your location" means ("your parent, through Belay").
- **A notification for every check:** "Your parent checked where this phone is (8:15 PM).", or
  "…, using Claude." when a parent asked their AI app; an ongoing one in lost mode ("This phone is
  in lost mode. Your parent can see where it is every 5 minutes until they turn lost mode off.");
  and periodic mode in the managed notice ("Shares where this phone is every 30 minutes, 7:00 AM
  to 9:00 PM."). Android adds its own: the location icon while GPS is used, "Belay has location
  access" when it's granted, and "Apps can access your location" when Belay turns location on.
- In lost mode, the parent's message on the lock screen.

## What the kid sees (Phase 7)

- **Home:** the phone's state in one line ("Everything's normal", "Bedtime until 7:00 AM",
  "Paused by your parent until 5:30 PM"), what works now (always ending with "You can always call
  or text 911 and 988."), "I need help", and the emergency card.
- **The emergency card**, also while the phone is paused: 911 and 988 (call or text), the numbers
  the parents put on it, and Android's own emergency information. Belay opens the phone app or the
  texting app with the number filled in; it doesn't place calls or send texts itself, and it
  doesn't see them.
- **"I need help":** one tap sends it. The confirmation always says "If you're in danger right
  now, call 911." with a button, and "988: call or text for crisis support, any time. It's free
  and private." Then "Your parent saw this at 4:05 PM." once a parent marks it seen.
- **My requests:** every request with the answer, the parent's note and who answered; one that's
  still waiting can be changed or taken back.
- **What your parent can see:** each kind of data, where it goes ("your parent's Belay server at …,
  and nowhere else"), and for each one the parents' AI app may read, "Your parent's AI app can read
  this." (the policy's `ai_reads`, which follows Settings' "What AI apps may read").
- **What Belay told your parent:** every check of the last 30 days, each lost mode, and each fix
  the kid shared, from the phone's own record, so none is left out.

## What the kid sees (Phase 5)

- **Belay as the phone app** once a parent turns calls on: a dial pad, the contacts the parents
  approved, recent calls, and Belay's own screens for a call that rings and a call going on, with
  two buttons that are always there: "Emergency (911)", and "988: Call or text for crisis
  support", which says that 988 is free and private and that Belay never tells anyone the kid
  called or texted.
- **Who can call them and whom they can call**, in plain words from the policy's rules and
  contacts ("Calls from other numbers don't ring.", "911 and 988 always work. For 2 hours after
  you call 911 or 988, anyone can call you back."), and "Ask to add a contact" (a name, the number
  and why), with the parent's answer under My requests.
- **What your parent can see** gains "Your calls" only while calls are recorded: who they call and
  who calls them, when, and for how long; not what anyone says; never 911 or 988. It loses it when
  recording stops. "How the phone and Belay are doing" adds whether Belay is the phone's calling
  app.
- A call the rules refused never rings; Belay's recent calls say why ("Missed: number not in your
  contacts"). Calls with 911, 988 and the private numbers show there, marked "only on this phone",
  only while the phone's own call history has them.
- When Belay isn't the phone's calling app (it broke, or Android refused), its screen says so:
  "calls go through the phone's own app. Your parent can see this."

These are the phone's words and screens ([protocol.md](protocol.md), "Calls rules"); the server
sends the rules and contacts they're built from, and nothing else about calls.

## What the kid sees

- A notification that never goes away: "This phone is managed by your parent".
- In the Belay app: that the phone is managed, the list of what the parent can see (above,
  in plain words), whether it's connected to the family's server, and when it last sent
  its app list.
- Nothing is collected in secret, and there is no hidden mode.

## How long it's kept

Until a parent deletes it. Deleting a disconnected phone on its page deletes everything
recorded about it: its apps, changes and reviews, and from Phase 3 its screen time, rules,
requests and agreement, and from Phase 5 its contacts, private and blocked numbers and call
records. The server's daily backups still hold it until they age out, 14 days
later, as do any copies the family made. Expired sessions, codes and tokens are deleted
automatically. The activity log is kept so parents can see what happened.

Screen time (Phase 3) doesn't wait for a parent: the server keeps each day 13 months by
default (the family chooses 1 to 36 in Settings), then deletes it, with the extra time given
that day. Turning measuring off stops new days; the ones kept stay until they age out.

Where the phone was (Phase 4) doesn't wait either, and is kept much less: fixes shared on a
schedule 7 days, a parent's checks 30 days, arrivals and departures 90 days, lost-mode fixes
until 7 days after lost mode ends (the family chooses each in Settings, within limits), then
deleted by the hourly clean-up ([server.md](server.md) has the details). The one fix a kid
shares with "I need help" is kept with that request, which, like every request, stays until the
phone is deleted. Turning location off stops new fixes; the ones kept stay until they age out.
The AI scope "location" is off by default: while it's off, AI apps see that a phone has location
on, never a fix or a place event.

Call records (Phase 5) are kept 90 days by default (the family chooses 1 to 365 in Settings),
then deleted by the hourly clean-up; a record counts from its own time, or from when it arrived
if the phone's clock was ahead. Making a number private deletes the records already kept of it.
Turning recording or calls off stops new records; the ones kept stay until they age out.
Contacts, private and blocked numbers stay until a parent removes them, or deletes the phone.
The AI scope "calls" is off by default for every family.

## Respecting the kid

Some apps are private for good reasons: health, identity, crisis support. Belay's
instructions to AI apps say not to speculate about the kid from their app choices: describe
what an app does and its risks, not what it says about the kid. Emergency numbers (911 and
988) always work, in every phase.
