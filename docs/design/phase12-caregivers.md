# Phase 12: caregivers

**Status: built** (server and phone, run end to end in CI's emulator job;
[the Pixel checklist](../phase12-checklist.md) is open). No new Android capability: the phone runs
the same pause, `lock_now` and `locate_now` it already runs, and shows the kid more words from its
policy. The work is on the server (a second, much smaller kind of account) and in what the kid's
screens say.

A parent sometimes hands the kid to someone else for a while: a grandparent for a weekend, a
babysitter for an evening, a coach on a trip, or the kid's other household. That person may want
to know whether the phone is on, to pause it at dinner, and to hear at once if the kid presses
"I need help". Today the only way is to give them a parent's password, which gives them
everything, for good, and the kid doesn't know.

## Goals

1. **Limited:** a caregiver sees and does only what a parent chose, from a short list, on the
   phones a parent chose. Nothing a caregiver can do loosens a rule (principle 2).
2. **Time-boxed:** every caregiver's access has an end, at most 30 days away, which a parent can
   renew; it stops by itself at that moment, and a parent can stop it at once.
3. **Never a parent:** a separate kind of account with its own few pages and a session no parent
   page, form, upload, OAuth step, MCP call or device API call accepts. No AI app, OAuth grant or
   token for caregivers.
4. **The kid always sees who has it** (principle 4): each caregiver, what they can see and do,
   and until when, on the kid's own screen, generated from the policy; and every pause, lock and
   check names the caregiver who did it.
5. **Parents see everything a caregiver does**, in the activity log, with the caregiver's name.

Not goals: a caregiver who gives more time, approves apps, answers requests or resumes the phone
(that would need principle 2 changed: a family decision below); a caregiver who sees the app
list, screen time, calls, websites, where the phone has been, the places, the activity log,
settings, stages or the agreement; messages from a caregiver to the kid; access that starts later.

## What Android 17 allows

Nothing new is needed on the phone. A caregiver's pause is an ordinary `pause` in the policy, a
lock is the existing `lock_now` command (`DevicePolicyManager.lockNow`, platform notes S5), and a
check is the existing `locate_now` (Phase 4, L1 to L6). The kid's words come from the policy,
like `ai_reads` and `help_seen` (Phase 7). No new permission, API or Room table: the phone keeps
its policy, its location wants and "What Belay told your parent" as JSON already.

Web Push to a caregiver's browser uses the same push services and the same end-to-end encryption
as a parent's (server.md, "Notifications"). On an iPhone or iPad a web page gets notifications only
once it's added to the Home Screen (iOS 16.4 or later), so the caregiver pages carry their own web
app manifest that opens `/care`.

## Design

### A caregiver account

A parent adds a caregiver on the parent page's new **Caregivers** page:

- **A name**, the parent's words for them ("Grandma", "Coach Lee"): 1 to 40 characters, one line,
  cleaned like the kid's own text (no control characters, nothing that hides or reorders text),
  and different from every other caregiver's. The kid sees it, and so does the caregiver.
- **The phones** it covers: at least one.
- **What they may do**, each a choice (below), at least one.
- **When access ends:** required; a date and time in the family's time zone, at most 30 days from
  now. The form suggests three days from now.

The server answers with a **one-time link** (`/care/join/<token>`), shown once, like a parent's
invite: 32 random bytes, kept only as a hash, working once, for 7 days or until access ends,
whichever is sooner. The caregiver opens it, sees the family's phones it covers and what they may
do, and chooses a username and a password, with a parent's rules: at least 15 characters,
argon2id. A parent can make a new link at any time (a caregiver who forgot the password): it
replaces any unused one, and using it sets a new password and signs the caregiver out everywhere
else.

A parent can **change** a caregiver (name, phones, what they may do), **renew** it (a new end, at
most 30 days from then), **end access now**, and **remove** an ended one. Ended caregivers stay
listed, so the same account can be given access again next month ("Give access again": a new
start, so the help requests from between don't show); removing one deletes the account, and the
activity log keeps its name.

At most 20 caregivers per server, ended ones included. AI apps can't see, add or change
caregivers, not even as a proposal: giving someone access to the kid's phone is a parent's
decision, out of band. The server's command line adds, lists, renews and ends them too
(`caregiver-add`, `caregivers`, `caregiver-renew`, `caregiver-end`), through the same functions,
with the same limits, logged as the server's.

### What a caregiver may do

Each is a parent's choice per caregiver. The recommended defaults are in brackets.

| Capability | What the caregiver sees and does | Default |
|---|---|---|
| `status` | For each phone: whether it's online now (it asked the server for its rules in the last 5 minutes), or when it was last heard from; its battery and whether it's charging; whether it's paused now and until when; the schedule on now (its name, and until when, as the phone last reported); whether it's disconnected. | on |
| `pause` | Pause the phone for 15 minutes to 4 hours, or pause it and lock the screen now (the existing pause and `lock_now`): only ever longer than a pause in force (a pause at least as long is kept, and the caregiver is told nothing changed), never "until a parent resumes it", and with no note of their own: the kid's phone says the caregiver's name. Only a parent resumes early. At most 6 pauses and locks an hour per caregiver and phone, as for an AI app. | on |
| `help` | The kid's "I need help" from these phones, by Web Push at once (urgent, like a parent's), and on the caregiver's page: those received since their access began, at most 7 days back, with the kid's words, where the phone was if the kid shared it (described as the parent page describes it, with "Open in a map"), whether a parent has seen it, and "Call" with the kid's number if a parent set one. A caregiver can't mark it seen: it stays at the top of the parents' Requests page until a parent does. | on |
| `locate` | "Check where it is now", only while the phone's location is on (on demand or periodic, as a parent's "Check now"): the existing `locate_now`, waiting up to a minute for the fix, then that one fix, described by the family's places. Never earlier fixes, the places themselves, arrivals and departures, or lost mode. The kid's notice names the caregiver. At most 6 checks an hour per caregiver and phone. | off |

**Never**, for any caregiver: anything that loosens (resume, more time, approving or allowing
apps, answering requests, lifting a lock, the web filter), the app list, screen time, calls,
network activity, location history and places, lost mode, the activity log, settings, stages,
the agreement, the parent page, MCP, other caregivers (a caregiver never learns who else has
access), and the server's health.

### Deny by default, structurally

- **Separate accounts, sessions and cookie.** Caregivers are in their own table, with their own
  sessions table (`caregiver_sessions`) and cookie (`belay_care`, `__Host-` with https). Every
  parent page, form and upload reads only the parent's cookie and looks it up only in `sessions`
  joined to `parents` (`auth/parents.ts`'s `loadSession`), so a caregiver's session is no session
  there, whichever cookie it's sent in. The OAuth sign-in and consent screens check only parents'
  passwords and sessions, MCP takes only access tokens a parent's grant made, personal access
  tokens are made only on the parent's Settings page, and the device API takes only phone tokens.
- **One gate on the caregiver side.** The caregiver pages are their own small app under `/care`,
  mounted before the parent pages, with their own body limit, same-origin check and CSRF tokens.
  Its one middleware loads the caregiver's session and ends it if their access has ended; every
  route goes through one function, `careAccess(caregiver, phone, capability, now)`, which checks
  that access is current (not ended, before its end time), that the phone is one of theirs, and
  that the capability is on.
- **A test walks every route.** Every route the server registers (pages, forms, `/mcp`, OAuth,
  personal access tokens, the APK upload, the device API) is called with a caregiver's session
  (in the caregiver's cookie, in the parent's cookie, and as a Bearer token) and without
  anything, and must answer exactly the same: a caregiver's credentials get nothing a stranger
  doesn't.

### Ending access

- **At its end time,** by itself: every caregiver request, every notice sent and the policy check
  the end time, so nothing works a second after it; the kid's phone stops listing them then, by
  its own clock. The hourly clean-up then marks the caregiver ended, deletes their sessions,
  browsers (push subscriptions) and unused link, logs it, and gives each phone a new policy
  without them.
- **A parent's "End access now":** the same, at once.
- **A pause a caregiver set** stays until its own end (it only tightened); a parent can resume it.

### The activity log

Every caregiver action goes through `audit()` with a new actor, `caregiver`, and the caregiver's
name (kept in the entry, so it outlives the account): joining, signing in, each pause, lock and
check, turning notifications on or off, and each refusal past the hourly limits (once an hour).
A parent's actions on caregivers are there too (added, changed, renewed, ended, removed, a new
link), and the server's (access ended at its time). The parents' Activity page shows them as
"Grandma (caregiver)". What a caregiver looks at isn't logged, as for a parent.

### On the kid's phone

Built from the policy's new `caregivers` list (below) in `:core` (`kid/Caregivers.kt`); what each
caregiver can see and do is in `DataCategory.kt` (`DataCategories.caregiver`, beside the words for
what the parents see, tested on the JVM), and the other lines are in `strings.xml`:

- **What your parent can see** gets a card, "Caregivers your parent added", listing each one
  with what they can see and do and until when, and what they can't: "Grandma, until Sunday at
  6:00 PM" (a date further than 6 days ahead: "Dec 5, 6:00 PM") · "Can see whether this phone is
  online and when it last connected, its battery, and whether it's paused or on a schedule" · "Can
  pause this phone, or pause it and lock the screen, for up to 4 hours at a time. Only your parent
  can end a pause early." · "Gets your "I need help" requests, with what you write, and where this
  phone is if you share it" · "Can check where this phone is right now. You get a notification
  every time." · "Can't see your apps, your screen time, your calls, the websites apps look up, or
  where this phone has been" · "Can't give you more time or let an app through. Only your parent
  can."
- **Home** gets one line per caregiver, "Your parent gave Grandma some access to this phone until
  Sunday at 6:00 PM.", and a button to that card.
- **Help** says who else gets it: "Grandma gets your help requests too, with what you write, and
  where this phone is if you share it."
- **A caregiver's pause** reads "Paused by Grandma until 5:30 PM" on Home and on the pause notice,
  "Grandma paused this phone" on the pause banner (with "Only your parent can end it early."), and
  "Grandma paused this phone until 5:30 PM." in the words for paused apps (Today).
- **A caregiver's check** reads "Grandma checked where this phone is (8:15 PM)." in the notice
  and in "What Belay told your parent".

The phone lists a caregiver only until their `until`, by its own clock (automatic and locked,
Phase 2), even before it gets a new policy, from the next time a screen is drawn. Each name is the
parent's words: shown as plain text, on one line, capped at 40 characters, without characters that
hide or reorder text (the phone cleans it again). `locate` shows only as sent, and only while the
policy's location takes checks.

### On the parent page

- **Caregivers** (in the menu): the add form, with plain words about what each choice shows,
  each caregiver's phones, what they may do, until when, whether they've joined and when they
  last signed in, and Change, Renew, End access now, a new link, and Remove.
- **A phone's Pause section** says when a caregiver set the pause in force.
- **Activity** shows each caregiver's actions under their name.
- The guide ([guide.md](../guide.md)) gets a short section, "Someone else looking after the kid".

### The caregiver's pages

`/care/login`, `/care/join/<token>`, and `/care`: for each of their phones, what their choices
let them see and do, with "Pause" and "Pause and lock now", "Check where it is now", and the help
requests; their access's end, in the family's time zone; and turning notifications on in this
browser (the parent page's script and service worker, with the caregiver's own forms). A plain
layout with no parent menu, which says whose family it is and that a parent chose what's here.

## Protocol

All additive. The server always sends `caregivers`, and `caregiver` only when a caregiver did
something; a phone that doesn't know them ignores them, and one that does defaults them to
nothing.

### Policy additions

| Field | Type | |
|---|---|---|
| `caregivers` | `[{name, until, can}]` | The caregivers with access to this phone (not ended), soonest end first, then by name; at most 20. `name`: the parent's words, one line, at most 40 characters. `until`: when access ends (epoch ms). `can`: what they may do now, in this order, from `status`, `pause`, `help`, `locate` (`locate` only while the phone's location takes checks: `on_demand` or `periodic`). The phone lists one only until `until`, by its own clock. |
| `pause.caregiver` | string? | The caregiver who set the pause in force (their name), only when one did: absent when a parent, an AI app or the server's CLI did, so their pause reads as before. |
| `commands[].caregiver` | string? | The caregiver who sent this `lock_now` or `locate_now` (their name), only when one did; absent otherwise. Never with `via`. |

Example:

```json
"pause": {"until": 1795306200000, "note": null, "caregiver": "Grandma"},
"commands": [{"id": "c0ffee00-…", "kind": "locate_now", "issued_at": 1795300000000,
  "expires_at": 1795300120000, "via": null, "caregiver": "Grandma"}],
"caregivers": [{"name": "Grandma", "until": 1795370400000, "can": ["status", "pause", "help"]}]
```

Nothing new goes from the phone to the server.

## Privacy and transparency

- **No new collection.** Caregivers see a small part of what the server already keeps, live:
  device status (online, battery, pause, the schedule now), help requests, and, if a parent
  allows it, one fix per check. They see none of the rest, and never another caregiver.
- **Who sees what** (privacy.md): a caregiver, on their own pages, while access lasts, only for
  the phones and capabilities a parent chose. A help notice to a caregiver's browser carries what
  a parent's does (the phone's name and the kid's words), encrypted end to end.
- **The kid sees it** (principle 4): every caregiver with access to their phone, what each can see
  and do, and until when; who gets their help requests; and the caregiver's name on each pause
  and check. There's no hidden caregiver: the policy lists every one with access to that phone.
- **The caregiver sees it too:** the join page and their own page say exactly what they can see
  and do, and until when.
- **Kept:** a caregiver's account until a parent removes it (ended ones stay so access can be given
  again); sessions until they expire (7 days) or access ends; the activity log's entries as long as
  the family keeps the log.

## Threat model changes

| Who | Risk | What Belay does |
|---|---|---|
| Someone with a caregiver's password or session (a stolen account, a shared tablet) | Watching the kid, pausing the phone, reading help requests. | Only the phones and capabilities a parent chose, until the end (30 days at most): no app list, screen time, calls, websites, location history or places. Passwords of at least 15 characters (argon2id), sign-in limited per address and per username, sessions of 7 days. Pauses and locks only tighten, at most 6 an hour; each check posts a notice on the kid's phone naming the caregiver, at most 6 an hour. Every sign-in and action is in the activity log; a parent ends access at once. |
| A caregiver trying to reach parent data | The app list, settings, the activity log, MCP. | A separate account, session table and cookie that no parent route reads; one gate on every caregiver route; no MCP, OAuth or tokens; a test that walks every route with a caregiver's session. |
| An ended caregiver with an open session, or a browser still subscribed | Acting or hearing after access ended. | Every request and every notice checks the end time; ending deletes sessions and browsers at once (a parent) or within the hour (the clean-up), and nothing works in between. |
| A caregiver persuaded by the kid | Loosening a rule. | Nothing a caregiver can do loosens: no resume, more time, apps, requests or locks. |
| A parent who wants to watch the kid through a "caregiver" in secret | Hidden access. | Not possible: the policy lists every caregiver with access to the phone, and the kid's screen shows them. |
| The one-time link, intercepted | Someone else joining. | It works once, for 7 days at most and never after access ends; the join page shows what it gives; a parent sees whether and when the caregiver joined, and a new link stops the old one. |
| A caregiver's name | Text the kid sees, written to mislead. | A parent writes it; at most 40 characters, one line, cleaned like the kid's own text, shown as plain text. |

## Test plan

- **Server:** each capability on and off; every refusal (another phone, a capability off, an
  ended or expired caregiver, a not-yet-joined link, a CSRF or cross-site form); the route walk;
  access ending exactly at its end time and the hourly clean-up's ending; a parent ending access
  (sessions and browsers go); the activity log's entries with the caregiver's name; push only to
  caregivers with `help`, current access and that phone; the policy's `caregivers`,
  `pause.caregiver` and `commands[].caregiver`; migration 14 keeping every activity entry.
- **Core (JVM):** the kid's lines from the policy (an expired one dropped, names cleaned and
  capped, at most 20, sorted, `locate` only as sent); Home's line for a caregiver's pause; a
  caregiver's check named in "What Belay told your parent".
- **Emulator (CI):** the command line's `caregiver-add` gives a made-up caregiver status, pause
  and help, and the phone's debug state lists them with exactly that and their end, by its own
  clock; the caregiver joins with the one-time link and pauses the phone from their page over HTTP
  (curl with their cookie, the form's CSRF token and a browser's Origin; one from another site is
  refused); the phone has the pause as theirs and holds the fixture app for it; `caregiver-end`
  takes them off the phone's list and signs them out, their pause stays, and a parent resumes it
  (`ci-emulator-test.sh`).
- **On the Pixel:** the kid's screens with a caregiver, at the largest font; a caregiver's pause,
  lock and check from another phone's browser, and what the kid sees; a help request's push to a
  caregiver on Android Chrome and on an iPhone (Home Screen).

## Decisions the family must make

1. **Who gets access, to which phones, and for how long.** Recommended: only for the time they
   look after the kid, at most 30 days, renewed by a parent (the form suggests three days).
2. **What each caregiver may do.** Recommended: status, pause and lock, and help requests on;
   checking where the phone is off (turn it on for a trip, while location is on).
3. **What a caregiver sees of a help request.** Recommended: the kid's words, where the phone was
   if the kid shared it, and "Call" with the kid's number if a parent set one: the kid shares it to
   get help, and their Help screen says who gets it.
4. **More time from a caregiver.** Not built: giving time loosens, and principle 2 says loosening
   waits for a parent. A family that wants it would change principle 2 first.
5. **A caregiver's note on the pause screen.** Not built: the kid sees Belay's words with the
   caregiver's name, never a caregiver's message.

## Open questions

- Should a caregiver be able to mark a help request seen, so the kid's phone says "Grandma saw
  this"? It would need a second "seen" beside the parents', which stays theirs.
- Access that starts later ("Friday 5 PM to Sunday 6 PM")? For now a parent adds it when it
  starts.
- Should a help notice wait until the phone has applied rules that list the caregiver, so the
  kid's Help screen named them first? A phone online gets new rules within seconds, so it rarely
  matters.
- Should Android's managed notice name current caregivers too?
- Phase 9 (more families): caregivers belong to one family, like everything else.
