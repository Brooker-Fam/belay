# Device API (v1)

The contract between the agent on the phone and the family's server. The agent's types are
in `android/core/src/main/kotlin/family/brooker/belay/core/Protocol.kt`, the server's Zod
schemas in `server/src/device/schemas.ts`. Change all three together.

## Conventions

- `https://<server>/api/v1/...`, JSON both ways (`Content-Type: application/json`).
- Every request except `enroll` carries the device token: `Authorization: Bearer <token>`.
- Times are integers: milliseconds since the epoch, UTC.
- The server **rejects unknown fields** in requests (so a typo is an error, not silence).
  Responses may gain fields; the agent ignores what it doesn't know.
- Optional fields may be omitted or `null`.
- Every call is idempotent: `inventory` by `snapshot_id`, `events` by each event's `id`.
  The agent can always send again.
- **Order:** the agent delivers events and inventories in the order it made them. It never
  sends an inventory while events found before it are still unsent, and it takes the snapshot
  after flushing them. The server applies both in the order they arrive.
- No CORS: these endpoints are for the agent, not for browsers.

| Endpoint | Body limit |
|---|---|
| `POST /api/v1/enroll` | 16 KB |
| `POST /api/v1/checkin` | 64 KB (32 KB before Phase 3) |
| `POST /api/v1/inventory` | 4 MB, at most 5000 packages |
| `POST /api/v1/events` | 512 KB, at most 1000 events |
| `GET /api/v1/policy` | (no body) |
| `POST /api/v1/requests` | 128 KB, at most 100 requests |
| `GET /api/v1/agent/<sha256>.apk` | (no body; the answer is at most 100 MB) |
| `POST /api/v1/usage` | 256 KB, at most 31 days (Phase 3) |
| `POST /api/v1/locations` | 64 KB, at most 200 fixes and 200 place events (Phase 4) |
| `POST /api/v1/calls` | 128 KB, at most 500 records (Phase 5) |
| `POST /api/v1/network` | 512 KB, at most 31 days of at most 5000 entries (Phase 3, network logging) |

Errors: `{"error": "<code>", "error_description": "<words>"}` with

| Status | `error` | Agent does |
|---|---|---|
| 400 | `invalid_request` | drops the request (a bug: it would fail again) and logs it |
| 400 | `invalid_code` | (enroll) tells the person the code is wrong, used or expired |
| 401 | `invalid_token` | stops syncing: the parent revoked this phone; shows "disconnected" |
| 404 | `not_found` | drops the request (a bug) and logs it |
| 413 | `too_large` | splits or drops, logs it |
| 429 | `rate_limited` | waits for `Retry-After` seconds |
| 5xx | | retries with backoff |

## Enrollment link

The "Add a phone" page shows a QR code and a short code. The QR code holds

```
belay://enroll?server=https%3A%2F%2Fbelay.example.org&code=7KQ2M9XA
```

- `server`: the server's public HTTPS origin.
- `code`: 8 characters of Crockford base32 (`0-9 A-Z` without `I L O U`). People may
  type it in lower case, with spaces or a hyphen; `I`/`L` read as `1`, `O` as `0`.
  It works once and expires 30 minutes after it was made.

`provision.sh --server <url> --code <code>` hands the same two values to the agent
over adb.

## `POST /api/v1/enroll`

```json
{ "code": "7KQ2M9XA", "device": { …Device… } }
```
→ `200`
```json
{ "device_id": "5f0c…", "device_name": "Alex's phone", "token": "<43 characters>", "server_time": 1794867161711 }
```

The token is 256 random bits (base64url, no padding). The server keeps only its SHA-256.
Enrollment attempts are rate-limited per client address.

## `POST /api/v1/checkin`

Every 2 hours, and when the agent starts.

```json
{ "status": { …Device… } }
```
→ `200`
```json
{ "server_time": 1794867161711, "policy": { "version": 0 } }
```

From Phase 2 the answer carries the whole current [Policy](#policy) (Phase 1 servers sent
`{"version": 0}`, which enforces nothing). The phone also reports what it enforces in
`status.enforcement`.

Size: a busy phone's check-in, with screen time (100 never-blocked packages, 12 limits, a
few problems, commands and self-serve takes), is about 7.5 KB; with every list at its cap
and long names, about 29 KB. The phone keeps it under 30 KB (core's `Checkins.fit`) by
trimming, least important first, the tail of `never_blocked`, long words in the commands'
results, half the problems, older self-serve takes, then the rest of `never_blocked`.

## `POST /api/v1/inventory`

Every 24 hours, after each boot, and right after enrollment.

```json
{
  "snapshot_id": "0b9e…",
  "taken_at": 1794867161711,
  "boot_count": 12,
  "device": { …Device… },
  "packages": [ { …Package… } ]
}
```
→ `200`
```json
{ "server_time": 1794867161711, "duplicate": false, "backfilled": 1 }
```

The first snapshot after enrollment is the baseline: it records no changes. After that the
server diffs each snapshot against what it knows and records any change no event reported
("found by snapshot"): `installed` (new, or back after a removal), `reinstalled` (a new
first-install time), `updated` (a new version code or last-update time) and `removed`.
A phone event that arrives later for the same change (same package and kind, same
`happened_at`; for a removal, the latest thing recorded for the package) takes the
backfill's place, so each change is listed once.

What the server keeps, whatever a phone sends: at most 5,000 new app changes an hour per phone,
its events and the changes found in its snapshots together. Past that, a snapshot still updates
what the server knows of the apps, but its changes aren't kept (`backfilled` counts the kept
ones); and an event is counted in `accepted` but neither kept nor applied, so the phone stops
sending it: never `429`, since events share the outbox's first lane with requests. The next
snapshot records what it changed. So is an event that would make more than 5,000 apps on the
phone (a snapshot's own limit). It keeps at most 20,000 app changes per phone (past that, the
ones that arrived first go), 2,000 apps that aren't on the phone any more, besides every one a
parent decided on or reviewed (the ones removed longest ago go), and the newest 1,000
snapshots' records.

## `POST /api/v1/events`

Sent as soon as a change is found, from the agent's outbox.

```json
{ "events": [ { …Event… } ] }
```
→ `200`
```json
{ "server_time": 1794867161711, "accepted": 1, "duplicates": 0 }
```

## `GET /api/v1/policy?have=<version>&wait=<seconds>`

Phase 2. How a parent's change reaches the phone in seconds. Belay's foreground service
holds this request open in a loop.

- `have`: the policy version the phone has (`-1` or left out: none).
- `wait`: how long the server may hold the request, 0 to 55 seconds (default 0).

The server answers `200 {"server_time", "policy": {…Policy…}}` at once when its version
differs from `have`; otherwise it waits up to `wait` seconds for a change and answers
`204` with no body if none came. The phone asks again right away after a `200` or `204`,
and backs off after errors like any other call. The check-in answer carries the same
policy, as the fallback.

## `POST /api/v1/requests`

Phase 2. Something the kid asks a parent for, from Belay's screen.

```json
{ "requests": [ { …Request… } ] }
```
→ `200`
```json
{ "server_time": 1794867161711, "accepted": 1 }
```

Idempotent by `id`: sending a request again updates its `reason` while it's still
pending. When a new app is suspended, Belay makes its request at once (without a reason),
so the parent sees it even if the kid never opens Belay. The answers come back in the
policy's `requests`, which Belay shows the kid.

A new request (a new `id`) for an app that has one waiting takes its place, as when the app
is installed again: the old one leaves the policy's `requests`, and the kid's earlier reason
stays with the new one until they write another. At most 200 apps can have a request
waiting per phone; past that, new ones are answered `429`.

What the server keeps, whatever a phone sends: at most 300 new requests an hour per phone,
ones that arrive already withdrawn included (help requests aside: other requests never hold
one back); past that, the call is answered `429` with `Retry-After`, nothing past the limit is
kept, and the phone sends those again. Of the requests that wait for no one any more
(answered, withdrawn, asked again, the kid's "I agree"), it keeps the newest 1,000 per phone,
help requests aside: past that, the oldest go, the ones the phone settled itself before the
ones a parent answered; and it deletes them a year after they last changed. Help requests are
kept until the phone is deleted.

Phase 3 makes Request a union on `kind`: `app`, `more_time` (more minutes for a limit
today) and `agreement` (the kid's answer to the family agreement). Only a parent answers;
an approved `more_time` answer carries the `minutes` given, and the policy's
`screen_time.extra` gets them. What the server does with them:

- A new `more_time` request for a limit that has one waiting takes its place, like an app's,
  with the kid's earlier reason until they write another; a new `agreement` answer takes the
  place of any that's waiting. At most 60 `more_time` requests can wait per phone; past that,
  new ones are answered `429`.
- `agree` waits for no one: it's answered `approved` as it arrives, and the policy's
  `agreement.kid_agreed_at` becomes its `asked_at` (the newest answer to a version decides).
  `talk` waits for a parent like any request.
- A parent gives 15, 30 or 60 minutes (1 to 240 from the server's command line), which may
  not be what was asked. Approving adds an `extra` entry for the request's limit (all its
  apps) on the phone's current day, in `screen_time.zone` from `day_starts`, with the
  request's id in `request_id`; answering again replaces it. The policy's `extra` holds
  yesterday's and today's entries.

## `POST /api/v1/usage`

Phase 3. What the phone counted, one local day per entry, sent only while the policy's
`screen_time.measure` is on: every 15 minutes or so while the phone is used, and once
when a day is complete.

```json
{ "days": [ { …UsageDay… } ] }
```
→ `200`
```json
{ "server_time": 1794867161711, "accepted": 1 }
```

Idempotent by `(day, zone)`: a day sent again replaces the stored one when its `as_of`
is the same or newer. `as_of` is the time the day was counted up to, so a later report
always replaces an earlier one even when no new event came; a complete day's `as_of` is the
day's end, and the phone sends yesterday and today again after its clock moved (Android moves
its usage history with the clock), which must replace what was stored. Apps the phone never
blocks (the dialer, the SMS app…) are left out of `apps`, so a call or text to 988 never
shows; their time still counts in `screen_minutes`.

The phone sends only what it counted since the policy's `measure` turned on (the part of
that first day before is a gap), and drops days it hasn't sent yet when `measure` goes off.
Usage days wait in their own lane of the outbox, so a server without this endpoint (`404`,
retried later) holds back nothing else.

The server keeps a day only while the phone's rules measure: a day sent while `measure` is
off is answered `200`, counted in `accepted`, and dropped, as is one whose `day` isn't a
real date. It leaves out of `apps` every app it never blocks (the phone's `never_blocked`,
and the well-known dialers, texting apps and emergency apps), even if a phone sends one.
`accepted` counts the days the phone can stop sending, kept or not. Days are deleted after
the family's retention (13 months by default). Also accepted and dropped: a day the phone
can't have counted yet (after tomorrow in its `zone`, or, in a zone that isn't a real one,
after the day after tomorrow in UTC), one older than the retention, and a date in a fourth
`zone` (a date is kept in at most 3).

## `GET /api/v1/agent/<sha256>.apk`

Phase 6. The version of Belay a parent approved for this phone (the policy's
`agent_update`), named by the APK's SHA-256. `200` with `Content-Type:
application/vnd.android.package-archive`, `Content-Length` and `Accept-Ranges: bytes`;
`Range: bytes=<from>-` answers `206` with the rest, so a download over cellular can resume.
`404 not_found` unless that file is the one the policy offers this phone right now.

The phone checks everything before it installs (see the rules below): the server stores
the file and the version a parent gives it, and doesn't parse it.

## The recovery key

Phase 6. If the family's server is ever lost, the recovery key opens repair access, offline,
for 24 hours: the `debugging` and `factory_reset` locks are both lifted, so adb and Settings'
reset work. (Maintenance mode, from the server, lifts only `debugging`.)

- The server makes it when a parent first turns on `debugging` or `factory_reset`, or
  asks for a new one: 26 random characters of Crockford's base32 alphabet
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 130 bits), shown once, in groups
  (`7KD2M-8Q4ZX-1HNP3-RT6VW-B9CF0G`). The server keeps only its check.
- The policy's `recovery` is that check: `hash` = SHA-256 of the 16 bytes of `salt`
  followed by the UTF-8 of the normalized key, lowercase hex. Normalized: upper case,
  without spaces or dashes, with O read as 0 and I and L as 1. A random 130-bit key
  makes a slow hash unnecessary. (`RecoveryKey.kt` and `server/src/family/recovery.ts`
  share a test vector.)
- Belay's screen takes the key under "About Belay", with no server. Three wrong tries,
  then a wait of a minute that doubles with each further wrong try, kept across restarts.
- A key's `version` works once on the phone: after it's used, the phone refuses it
  even if the policy still has it. The phone reports the use in `enforcement.recovery`
  when it can. The server takes a report only for the key the policy carries now (the
  phone's newest), and once: it then drops that check from the policy and tells the parents
  the phone reports the key was used, asking for a new one. A report about an earlier key,
  or one already taken, changes nothing.

## `POST /api/v1/locations`

Phase 4. Fixes and place events, only while the policy's `location` allows them (or in lost
mode, or a help request's shared fix, which goes in the request instead).

```json
{ "fixes": [ { …Fix… } ], "place_events": [ { …PlaceEvent… } ] }
```
→ `200`
```json
{ "server_time": 1794867161711, "accepted": 2 }
```

Idempotent by each item's `id`. A `locate_now` command waits on the server up to 60 seconds
for the fix that names it in `command_id`; a fix that fails is reported in
`enforcement.commands` with its problem.

What the server keeps (it rounds coordinates to 5 decimal places): a `periodic` or `place`
fix only while the policy's mode is `periodic`, and only within `hours` (in the phone's zone
from its last check-in, give or take 5 minutes); an `on_demand` fix only while the mode is
`on_demand` or `periodic`, and only when `command_id` names one of this phone's `locate_now`
commands (a newer check that replaced it counts as answered by it too); a place event only
in `periodic` mode, for one of the phone's places as the policy has them now; a `lost` or
`help` fix always. Everything else is dropped and counted (the phone's Location page says
how many). `accepted` counts every item in the call, kept, already kept or dropped: none of
them needs sending again. A fix marked `mock` is kept, and shown as made up. The server shows
and orders fixes (and picks the latest) and place events by their `at`, but never later than 5
minutes after it got them: a phone whose clock is ahead can't keep a fix or an arrival on top.
Both times are kept.

The server keeps at most 600 new fixes and place events an hour per phone, of any reason
(lost-mode and help fixes too): past that, the call is answered `429` with `Retry-After`, and
the phone sends the ones not kept again. It keeps at most 10,000 fixes per phone (the fix a kid
shared with a help request aside: that one is kept with the request) and 2,000 place events:
past that, the oldest go, by when they arrived.

## `POST /api/v1/calls`

Phase 5. Call records, only while the policy's `calls.log` is on.

```json
{ "calls": [ { …CallRecord… } ] }
```
→ `200 {"server_time", "accepted"}`. Idempotent by each record's `id`.

What the server keeps: a record only while the policy's `calls` is set with `log` on; otherwise
it's answered `200`, counted in `accepted`, dropped, and counted for the parent page. A record
never names an emergency number, 988 or one of the phone's `private_numbers`: the server drops
any record of one before it checks the body (so a record with `911`, which isn't E.164, costs the
others in the call nothing), counts it for no one, and logs only that it happened, without the
number or the phone; it treats 988's full number (`+18002738255`) as 988 too. Nor does it keep
a record about a contact who has a private number (a call with them may have been with it),
counted for no one. `number` is kept only when `contact_id` is null. At most 1000 records are kept a day per phone; past that they're
dropped and counted. `accepted` counts every record in the call, kept, already kept or dropped.
The endpoint is rate limited per phone apart from the phone's other calls (30 a minute).

## `POST /api/v1/network`

Phase 3, network logging. How many times each app looked up each domain, one local day per
entry, only while the policy's `network_log` is on (a parent's choice alone, off by default).
Its `private_domains` are the family's private websites, a parent's alone too (never an AI
client's, not even as a proposal, and never shown to one): the server keeps what a parent types
as the registrable domain the phone keeps, so `www.example.org/help` is `example.org`.

```json
{ "days": [ { "day": "2026-11-17", "zone": "America/Los_Angeles", "as_of": 1794867161711,
              "entries": [ { "package": "com.example.chat", "domain": "example.com", "lookups": 42 } ],
              "dropped": 0 } ] }
```
→ `200 {"server_time", "accepted"}`.

Idempotent by `day`: a day sent again replaces the stored one, entries and all, so the phone
always sends the whole day as it has it. `domain` is a lowercase hostname in Punycode, at most
253 characters, checked like one (labels of letters, digits and hyphens, at least two, a last
label with a letter: never an IP address); the app's developer chose it, so it's untrusted.
`lookups` is 1 to 1,000,000; `dropped` (0 to 1,000,000) counts the entries the phone cut to stay
under 5000 a day (and 400 KB), the least looked up.

What the phone does (Android 17's network logging, `DevicePolicyManager.setNetworkLoggingEnabled`,
device owner only; docs/platform-notes.md W1, W6 to W9):

- Android's logging is on exactly while the policy's `network_log` is. Android finishes a batch
  at 1200 events or after 90 minutes and tells Belay (`onNetworkLogsAvailable`); Belay takes it at
  once, and any batch it missed (Android keeps the last 5).
- It reads only the DNS lookups (never the connect events: an address and a port), and reduces
  each to its app and the registrable part of the name (`chat-7.cdn.example.com` →
  `example.com`; three labels under a country's second level, like `bbc.co.uk`), per local day in
  the phone's zone. The raw events never reach storage, the outbox or the log.
- Never kept: lookups by the apps it never blocks (its `never_blocked`: Belay, the dialer, the
  texting app, the keyboard, the home screen, Android's own packages), by uids Android names
  `name:uid` (a shared user id: Android's own processes, Play services, the shell), and of 988's
  websites (`988lifeline.org`, `988lineadevida.org`, `suicidepreventionlifeline.org`, `988.ca`,
  `veteranscrisisline.net`, and any name under them), and of the family's private websites (the
  policy's `network_log.private_domains`, and any name under them), checked against the whole
  name before it's reduced; IP addresses, reverse lookups (`in-addr.arpa`,
  `ip6.arpa`, and the `null` Android logs for one that found nothing) and names that never leave
  the phone or the home network (`local`, `localhost`, `internal`, `invalid`, `arpa`). Belay's own
  log says only how many lookups it didn't keep, for every reason together, never why or which;
  nothing it sends counts them (a day's `dropped` doesn't).
- It keeps today and the two days before (at most 10,000 entries a day), sends each day that a
  batch changed (it waits in an outbox lane of its own, a newer report of a day replacing an
  unsent one), and deletes all of it when `network_log` goes off. When `private_domains` changes,
  it deletes what it counted of the private ones from the days it keeps, and sends each day that
  changed again, in place of an unsent report; one sent before that, from the policy it has,
  goes without them.

What the server keeps: a day only while the phone's `network_log` is on; otherwise it's answered
`200`, counted in `accepted`, dropped, and counted for the parent page. It never keeps the
entries of an app it never blocks (the phone's `never_blocked`, and the well-known dialers,
texting apps and emergency apps), and never an entry naming one of 988's websites or one of the
phone's private websites, or a name under one: it takes those out before it checks the body (so
one written some other way costs the rest of its day nothing) and counts them for no one. For
988's it logs only that it happened, without the name or the phone (a phone that sends one has a
bug); a private one it drops without a word, since a Belay from before private websites sends
them as a matter of course, and a log line's time would say when one was used. Making a website
private deletes what the server kept of it, and of the names under it.
Also accepted and dropped: a day that isn't a real date, one the phone can't have counted yet
(after tomorrow in its `zone`), and one older than the family keeps (30 days by default).
`accepted` counts every day in the call. The endpoint is rate limited per phone apart from the
phone's other calls (30 a minute).

## Calls rules (Phase 5, both sides)

- **Off until a parent turns it on.** With `calls` null, Belay isn't the dialer and nothing
  about calls changes. With `calls` set, Belay makes itself the default dialer
  (`setDefaultDialerApplication`) and runs its own dial pad, contacts, recent calls,
  incoming-call and in-call screens; it places every call with `TelecomManager.placeCall`.
- **Always allowed, in code** (`:core`, never the policy): the kid can always call 911, every
  number Android reports as an emergency number (`isEmergencyNumber`) and 988 (988's full
  number, 1-800-273-8255, too), also with the caller-id codes that hide or show the caller's
  number dialed before them (`*67`, `*82`, `#31#`, `*31#`, one or more; no other code, and
  never one that reads as another code, like `*67#`), in every mode, stage, pause and
  schedule. A call from 911 or an emergency number always rings, unless its caller id failed
  the network's check; contacts with `parent` always ring too. Telecom sends emergency calls to
  the preloaded dialer, which is never hidden, suspended or disabled.
- **After an emergency contact:** for 2 hours after a call to an emergency number or 988 (from
  any dialer, the lock screen's before the first unlock after a restart included), or a tap on
  one of Belay's buttons to text 911 or 988, every incoming call rings, so a dispatcher or the
  988 line can call back from any number. So does a call Telecom marks as part of an emergency
  (emergency callback mode, or an emergency call the network identified).
- **Incoming:** a caller id that failed the network's check (STIR/SHAKEN) is a stranger's,
  whatever number it shows: never a contact, a parent or 911. `mode: open` lets everyone ring.
  `mode: contacts` lets contacts with `calls` ring; other callers follow `unknown`, callers with
  no caller id follow `withheld` (`reject`, `voicemail` or `ring`). A caller id showing 988 or
  its full number is decided like any other: 988 doesn't call people, and a counselor's own
  number rings after an emergency contact. With `quiet`, only parents and calls from 911 or an
  emergency number ring during a bedtime or school schedule (Phase 3). A refused call never
  rings, and a call the phone takes longer than 2 seconds to decide rings anyway.
- **Outgoing:** `outgoing: contacts` allows only contacts with `calls`, parents and the
  always-allowed numbers; `any` allows any number. A caller-id code never makes a number a
  contact's.
- **If Belay breaks,** Telecom falls back to the preloaded dialer with no filtering, on
  purpose: a phone that can't take calls is worse. Belay reports "Calls are going through the
  phone's own app" (`enforcement.calls.problem`).
- **Records** (`log`): when, direction, duration, outcome, and the contact, or the number for
  a caller who isn't one. Calls with emergency numbers, 988 or the family's private numbers
  (dialed with a caller-id code too) are never recorded or sent, and neither is a call that rang
  only because of an emergency (the 2 hours after an emergency contact, or Telecom's mark; the
  rules would have refused it): its record would tell. A caller whose caller id failed the
  network's check is recorded like any stranger, without the number when it showed one of
  those. An outgoing call is recorded with its contact or its number (the number it reached,
  in E.164); one to a number the phone can't write in E.164 (211, a number dialed without its
  area code) without the number, once the phone knows it isn't an emergency number, 988 or a
  private one (dialed without its area code, the end of a private number counts as it). The
  kid can remove a call from Belay's own recent calls on the phone; its record, sent or
  waiting to be, still goes.
- **Contacts** live in the policy and in Belay's own storage; Belay never writes them into
  Android's Contacts. A `contact` request is the kid asking for one; a parent approves it.
- Only a parent turns calls on or off or changes who may call; an AI client may only
  propose (it would loosen or change who reaches the kid), and reads records only with the
  `calls` scope on (off by default).

What the server does with them:

- **`calls`** is null until a parent turns calls on, and null again once they turn them off (the
  rules are kept for next time). **`contacts`**, **`private_numbers`** and **`blocked_numbers`**
  are always sent, calls on or not, sorted (contacts by name, numbers as strings).
- **Numbers** are E.164, cleaned of spaces, dashes, dots and parentheses as people type them. A
  number is one contact's; contact names are 1 to 60 characters, one per phone. The server
  refuses to put 911, any emergency number it knows (112, 999, 000…, with or without a country
  code) or 988 (988's full number included) in `blocked_numbers`, saying why, and refuses a
  contact's number there, one on the emergency card (`parent_numbers`), or a private one (an AI
  client is told the same about the last two, which it can't see). A number a contact
  gains that was blocked is unblocked. Making a number private deletes the records kept of it,
  and of the contact who has it.
- **Who may change what:** turning calls on or off, `log` and `private_numbers` are a parent's
  alone (the parent page or the server's CLI), never an AI client's, not even as a proposal. An
  AI client may apply a change whose every part tightens (`mode: contacts`, a stricter `unknown`
  or `withheld`, `outgoing: contacts`, `quiet` on, fewer contacts allowed to call, a number
  taken off a contact, blocking a number); anything else, and anything that takes from a
  `parent` contact, is a proposal a parent approves, checked again then. A contact's `texts` is
  kept for Phase 5's texts and the phone ignores it today, so an AI client's change to it is
  refused rather than applied.
- **A `contact` request:** a new one for a number that has one waiting takes its place, with the
  kid's earlier reason; at most 60 can wait per phone, past that `429`. Approving it adds the
  contact (the parent may change the name, and chooses `calls` and `texts`, on by default); a
  number that's a contact already adds no one. Declining or "let's talk" adds no one.
- **`enforcement.calls`:** with calls on, `dialer: false` is shown to the parents as "Calls are
  going through the phone's own app" (and in the daily summary); `problem` is shown as Belay's
  own words.

## Off belay (Phase 11, both sides)

The last stage, and the hand-over. Every step loosens or deletes, so each is a parent's action on
the parent page, or the server's CLI acting as one (never an AI client's, not even as a
proposal), and the phone shows each step before it happens.

- **Off belay** is a stage (Phase 3) every family has, always the last one: no limits or
  schedules, its own name, and it can't be deleted. The policy's **`off_belay`** carries the
  family's words for when it comes (`how`, null until they write some) and where it is for this
  phone: `on` (the phone is on it), `next` (it's the phone's next stage, so `stage.next` is it) or
  `later` (further on, or the phone is on no stage). The kid's "My stage" shows it at the end from
  the first day: on a stage, or on none once the family wrote its words.
- **Stop collecting** is the server's: a parent stops one data category of a phone, and after a
  confirmation that lists exactly what goes, the server deletes what it keeps of it. Where the
  phone has a switch, it turns off with ordinary fields (screen time's `measure`; `location` off,
  with lost mode and `keep_on`; recording calls, `calls.log`). The app list and the kid's requests
  have none: the phone keeps
  sending its apps while Belay is on it, and the kid can always ask ("I need help" always reaches a
  parent). A request the phone still lists (60 days) keeps a bare record, without anyone's words,
  so the policy's `requests` still carries its answer.
- **`handover`** (`{at, by}`: when, and the parent's name, or null from the CLI): the server also
  lifts `factory_reset`, `debugging` and `modify_accounts`, empties `frp_accounts` and
  `play_accounts` (all ordinary fields), and refuses to lock or set any of them again while the
  hand-over lasts. So Play may use the kid's own account: emptying `play_accounts` takes Play's
  `allowed_accounts` back, and lifting `modify_accounts` lets the kid add the account. While the
  policy has `handover`, the phone holds none of those three locks, no reset protection policy and
  no allowed accounts for Play, whatever the restrictions and `play_accounts` say. A release build
  clears the policy once per hand-over (`setFactoryResetProtectionPolicy(null)`, then
  `FRP_CONFIG_CHANGED` to Play services),
  even without a record of setting one, and again at the next step if that failed; a debug build,
  which never sets one, leaves it alone and records that it did. The phone shows the kid what
  happens next: back up to their own account, remove the parent's account, then Settings > System
  > Reset options > Erase all data. Release builds still contain nothing that switches Belay off:
  the reset does. Taking it back (`handover` null) stops the phone showing it; the locks stay
  lifted until a parent locks them again.
- **Afterwards** a parent disconnects the phone and deletes everything recorded about it.

## Location rules (Phase 4, both sides)

- **Off by default.** With `location` null or `mode: off`, Belay holds no location
  permission: a location permission is granted by policy only while the family has location
  on (or lost mode, or for the one fix a kid shares with a help request), and denied by
  policy again at once when it ends. The same rule covers every permission tied to a data
  category.
- **Single fixes,** never a stream: `getCurrentLocation` with the policy's `provider` and a
  60-second timeout. `gps` (the default) uses only the satellite receiver; `fused` uses
  Android's combined provider, which on a Pixel is Google's service. A GPS timeout falls
  back to `fused` only with `fallback_fused`.
- **Modes:** `on_demand` takes a fix only for `locate_now` or lost mode; `periodic` also
  takes one every `every_minutes` (15 to 120) within `hours`, and computes place events.
- **Places** (`periodic` only): arrival when two fixes in a row are inside
  `radius_m − accuracy`, departure when two are outside `radius_m + accuracy`; a fix less
  accurate than the radius decides nothing; a mock fix (`isMock()`) never counts. A place
  event's `at` is the first of the two fixes (when the phone was first seen on that side) and
  its `fix_id` the second, which decided; the phone sends that fix first. The first decision
  for a new or moved place is made quietly, with no event: a phone already at school when the
  place is added didn't just arrive.
- **Location off:** the phone drops the fixes and place events it hasn't sent yet.
- **The kid sees every check:** each `locate_now` and lost-mode fix posts Belay's own
  notice, and Belay's screen lists them from the phone's own record.
- **`keep_on`:** Belay keeps location on and sets `DISALLOW_CONFIG_LOCATION`.
- **Lost mode** (`lost`, any mode): the parent's message on the lock screen, location kept
  on, a fix every 5 minutes, and one screen lock (during a call, once the call ends);
  everything goes back when it ends.
- **Only a parent** turns location on or off, changes places, `keep_on` or lost mode.
  An AI client may read fixes only with the `location` scope on (off by default), and may
  ask for `locate_now` only in `on_demand` or `periodic` mode; the kid's notice names it.
- **What the server sends:** `location` is null until a parent first sets anything about
  location on that phone, and then always an object (`mode: off` once turned off).
  `every_minutes` and `hours` are null, and `places` empty, except in `periodic` mode, the
  only one that uses them; `keep_on` is false while the mode is `off` (lost mode keeps
  location on by itself). `lost.message` is the parent's words with the number to show
  after them, at most 120 characters. A `locate_now` expires 2 minutes after it's issued,
  and a new one replaces one still waiting, so the phone runs at most one.

## The kid's side (Phase 7, both sides)

- **`help`:** one tap sends it, no reason needed; parents get an urgent push, and it stays
  at the top of the parent page until a parent marks it seen (`help_seen`, which the kid's
  phone shows). The kid may add words and may share where the phone is, once
  (`location`, a Fix with `reason: help`), even if location is off. Belay's screen always
  says to call 911 in danger, with buttons for 911 and 988. The phone sends the request at
  once, then again (the same `id`) with the words or the fix when the kid adds them, so the
  server takes a `location` on a pending help request sent again, as it takes a new `reason`.
- **`talk`:** the kid's words ("I'd like to talk about…"); it changes no rule.
- **Withdrawing:** a pending request sent again with `withdrawn_at` is withdrawn; it leaves
  the policy's `requests`. An answered one can't be withdrawn.
- **The emergency card** (Belay's screen, also while paused): 911 and 988, call or text, the
  `parent_numbers`, and Android's own emergency information.
- **`ai_reads`** lists the data categories the parents' AI app may read, so the kid's
  "What your parent can see" says so for each.
- No AI tool answers a request; parents answer on the parent page.

What the server does with them:

- **Help** is never answered: a parent marks it seen. Seeing a pending one answers it at the
  same time, so the policy's `requests` entry becomes `approved`, with `answered_at` and
  `answered_by` the same as its `help_seen` entry, and the parent's optional note; show it as
  seen, not as approved. A help request the kid withdrew before a parent saw it stays at the
  top of the parent page until one does, and still gets a `help_seen` entry. Each help
  request is its own (none takes another's place); sending a pending one again takes the kid's
  new words and a newer shared fix, which takes the place of the one before (it isn't kept),
  as `reason` does, and the parents hear again; one sent again without either keeps what it
  has. At most 100 help requests no parent has seen (one that arrives already withdrawn
  counts: it stays at the top until a parent sees it), and 60 waiting `talk` requests, per
  phone; past that, new ones are answered `429`.
- **A check the server never issued** (the phone's own test `locate_now`, say): its result in
  `enforcement.commands` is ignored, and a fix naming it is dropped and counted, answered `200`
  like any other.
- **Withdrawing:** a request with `withdrawn_at` is withdrawn only while it's `pending`; the
  phone gets a new policy version without it. One that arrives already withdrawn (made and
  withdrawn offline) is kept as withdrawn, takes no other request's place, and isn't
  announced, except help, which the parents still hear about.
- **`parent_numbers`** are the family's (from Settings), or the phone's own list when a
  parent gave it one; changing the family's gives each phone using them a new version.
  **`ai_reads`** uses the server's AI scope ids, which are the phone's data category ids:
  `apps`, `device_status`, `requests`, `screen_time`, `agreement` (the stage and agreement,
  which no phone collector makes), `location` and (Phase 5) `calls`. A phone ignores one it has
  no category for.
  Changing them gives every phone a new version.

## Screen time rules (Phase 3, both sides)

The phone counts app time itself from Android's usage events (`queryEvents`, with the
usage access granted at provisioning) and enforces `screen_time` by suspending apps, like
a pause. The rules are one pure function in `:core` (`core/screentime/Rules.kt`); the
server decides whether a change tightens or loosens.

- **Days** run in `zone` (an IANA zone, or `"phone"`) from `day_starts`.
- **Limits:** the apps in a limit share its minutes each day (`by_day` overrides some
  days; 0 means not that day). `["*"]` is a daily total for every app that isn't exempt.
  Used up: its apps are suspended until the next day starts, or until extra time.
- **Schedules:** from `start` to `end` on `days` (an `end` at or before `start` ends the
  next day), every app is suspended except the never-blocked ones, the `exempt` ones and
  the schedule's `allow`; `lock` also locks the screen when it starts (during a call, once
  the call ends, if the schedule is still on); `skip` names days it doesn't start.
- **Always open:** the never-blocked apps and `exempt`. Schedules and daily totals also
  leave the clock and the keyboard alone, as a pause does; a limit that names the clock
  itself still applies.
- **Extra time:** `extra` gives minutes for one day, to a limit, to every limit (`"*"`),
  or to one app (`package`). `self_serve` lets the kid take `minutes`, `times` a day,
  without asking; each take is reported in `enforcement.screen_time.self_serve`.
- **Warnings** `warn_before` minutes before a limit runs out or a schedule starts.
- **Usage access off:** with `if_unmeasured: pause_limited` (the default) every app with
  a limit is suspended until Belay can count again, and the kid and the parent page say
  why; with `keep_open` they stay open, but a limit already used up stays used up.
- **`measure: false`:** the phone still counts, to enforce limits, but sends no minutes:
  no `POST /usage`, and no `used_minutes`, `used` or `left` in the report.
- **`lock_now`** (a command): locks the screen once, unless it arrives after `expires_at`.
  The phone runs it after applying the rest of the policy, so a pause sent with it suspends
  the apps first. While a call is on (the phone's, or one in an app, a call to 988 included),
  the lock waits and the command stays unrun: it's `done` once the call ends, or `expired` if
  the call outlasts it. A phone updated to a Belay that can lock reads that permission at its next
  restart (platform notes S5): until then the result is `failed`, "Android lets Belay lock the
  screen only after the phone restarts once with this version of Belay." The server sends it
  with `expires_at` 10 minutes on, and with a pause of 5 to 240 minutes when a parent or an AI
  client locks the phone (the command line's `lock-now` sends the lock alone, expiring after
  its `--minutes`); a new one replaces one still waiting. The parent sees a failed one's
  `problem` word for word.
- **The report:** `enforcement.screen_time` changes every minute the phone is used, but the
  phone checks in early only when something other than the minutes changed (a limit used up,
  a schedule starting, usage access, a self-serve take); the 2-hourly check-in carries the
  minutes. Its `self_serve[].limit_id` is always a limit's own id, never `"*"`.

## Enforcement rules (both sides)

- **Never blocked, whatever the policy says:** Belay itself, the phone app and anything
  that places calls (the default dialer, `com.android.phone`, telecom), emergency apps,
  the default SMS app (texting 988), the home screen, System UI, Settings, and Android's
  own system packages. 911 and 988 always work. A policy that names one of them is
  ignored for it, and Belay reports the problem.
- **New apps** (`new_apps: ask`): a user app (not a system app) without a decision is
  suspended the moment Belay sees it install, and stays suspended until the policy says
  `allowed`. There's no pre-install hook, so an app can run for a moment before that.
  When a parent first turns `ask` on, the server records every user app already on the
  phone as `allowed`, so nothing the kid already has stops working by surprise. Only the
  first time: turning `ask` on again after `allow`, the parent chooses which apps without a
  decision are allowed (by default, the ones installed while new apps were allowed), and the
  ones that were waiting before wait again unless the parent allows them.
- **Blocked** apps are hidden and suspended (`setApplicationHidden`: suspended apps that
  have run before can keep working in the background). System apps can be blocked too.
- **Paused**: every launchable app but the never-blocked ones is suspended until
  `pause.until` or until a parent resumes it. The phone's clock and the keyboard in use stay
  out of a pause too: a suspended app can't ring an alarm, and texting 988 needs a keyboard.
  The keyboard that came with the phone is never blocked.
- **`factory_reset` and `debugging`** can lock a phone for good. The server only sets them
  when a parent turns them on, with a warning, on the parent page; AI clients can't.
  Debug builds of Belay never apply them. `maintenance_until` lifts `debugging` so adb
  works for repairs.
- **Offline**, the phone keeps enforcing the last policy it got. Belay stores it.
- **The family's words** in the policy (the names of limits, schedules, stages and places, a
  pause's note, the support message, a parent's answers and name, Off belay's words and the
  hand-over's parent): the server sends them
  without control characters (new lines aside in notes) or the characters that hide or reorder
  text, and a name on one line. An AI app writes none of them: Belay names a limit or schedule
  it adds or renames, and its pause or lock has no note.
- **Versions:** the phone applies any version that differs from the one it has, lower ones
  too (a server restored from a backup), and checks in within seconds of applying one. A
  policy can be larger than other answers: the phone accepts up to 1 MB, and the server never
  makes one larger than 256 KB (it refuses the change that would).
- **`web.private_dns: null`** leaves the phone's setting alone, except that if the phone
  still has the host Belay set, Belay puts it back to Android's default (Automatic).
- **`play_accounts`**: the phone sets Play's managed configuration `allowed_accounts` (for
  `com.android.vending`) to them, as one string, comma-separated, keeping any other key Play's
  configuration has (platform notes A4). Empty, it sets nothing, and takes back what it set by
  removing the key: it never sends an empty string, which would keep every account out of Play.
  An entry that isn't an email address is left out and reported. Debug builds set them too: they
  can't lock anyone out of the phone. Only a parent sets them, on the phone's page.
- **Withdrawing a request** (Phase 7) is the kid's choice, from Belay's screen: an app
  removed while it waits leaves its request pending until a parent answers it, or the kid
  withdraws it.
- **Tightening vs. loosening:** an AI client may tighten directly (block an app, pause
  the phone). Anything that loosens (approve, unblock, resume, lift a restriction) is
  only a proposal until a parent approves it on the parent page.
- **The phone reports what it never blocks** (`enforcement.never_blocked`), as it resolves
  the roles on that phone. The server refuses to block those packages, for parents and AI
  clients alike, and also refuses well-known ones on any phone, before its first report too:
  Belay, `android`, the telephony and telecom services, the common dialers, texting apps,
  keyboards and home screens (Google's, AOSP's and Samsung's), emergency, safety and
  emergency-alert apps, System UI and Settings (`NEVER_BLOCKED` in
  `server/src/family/policy.ts`).
- **Updates** (Phase 6, `agent_update`): before installing, the phone checks that the
  download's SHA-256 and size match, and that the APK (`getPackageArchiveInfo` with
  signing certificates) is Belay's own package, has exactly the offered version code,
  higher than the one running, and is signed with exactly the certificate Belay runs with.
  Anything else is refused and reported. A device owner's `PackageInstaller` session
  installs silently; if Android refuses, Belay reports Android's message word for word.
  An update is a parent's action only, from the parent page or the server's CLI, never an
  AI client's.
- **Commands** (`commands`): each runs once per `id`, even if the policy still lists it;
  the result goes in `enforcement.commands`, and the server drops a command from the
  policy once it's reported. One that reaches the phone after its `expires_at` is
  reported `expired` and not run. A `kind` this Belay doesn't know is reported as
  `failed`, not run. `remove_other_users` (Phase 10) removes every user or profile `getSecondaryUsers`
  lists, such as the one Android's own Parental Controls make; only a parent issues it.

## Objects

**Event**

| Field | Type | |
|---|---|---|
| `id` | string | UUID made on the phone |
| `kind` | `installed` `updated` `removed` `reinstalled` | |
| `package` | string | |
| `label` | string | from the app's developer: untrusted |
| `from`, `to` | `{name?, code}` | versions; `from` for updated/removed/reinstalled, `to` for installed/updated/reinstalled |
| `happened_at` | int? | the package's own first-install or last-update time; null for removals |
| `detected_at` | int | when the phone noticed |
| `detection` | `broadcast` `changed_packages` `snapshot` | which layer noticed |
| `app` | Package? | the app as it is after the change, for installed, updated and reinstalled, so its source and permissions arrive at once; omitted for removed |

**Package**

| Field | Type | |
|---|---|---|
| `package` | string | letters, digits, `_` and `.` only (`com.example.app`) |
| `label` | string | untrusted, at most 200 characters |
| `version_name` | string? | untrusted |
| `version_code` | int | |
| `first_install_time`, `last_update_time` | int | |
| `system`, `updated_system`, `enabled`, `launchable` | bool | |
| `target_sdk`, `category` | int | `category` is `ApplicationInfo.category` (-1: none) |
| `source` | `play_store` `other_store` `other_app` `sideloaded` `adb` `preinstalled` `unknown` | |
| `installer` | `{installing?, initiating?, originating?, update_owner?, package_source?}` | raw `InstallSourceInfo` |
| `permissions` | string[] | sensitive permissions it holds, from: `camera` `microphone` `location` `contacts` `sms` `call_log` `photos_media` `nearby_devices` `notification_access` `accessibility` `device_admin` `secure_settings` (`WRITE_SECURE_SETTINGS`: Android's own apps hold it; any other app only because adb granted it, and it keeps it after the debugging lock, platform notes T21). A server that doesn't know a name refuses the app, so the server is updated first (it offers Belay's updates). |

**Policy** (server → phone; every field has a default that enforces nothing)

| Field | Type | |
|---|---|---|
| `version` | int | increases with every change, per phone |
| `issued_at` | int | |
| `apps` | `{new_apps: "allow"\|"ask", decisions: [{package, state: "allowed"\|"blocked"}]}` | |
| `pause` | `{until?, note?}`? | null: not paused; `until` null: until a parent resumes; `note` is a parent's words (an AI app's pause has none) |
| `restrictions` | `{safe_boot, add_user, unknown_sources, config_vpn, config_private_dns, config_date_time, config_default_apps, modify_accounts, sim, factory_reset, debugging}`, all bool | true: the kid can't (see the rules above for the last two) |
| `web` | `{private_dns?, chrome?, hide_browsers}` | `private_dns`: a host like `family-filter-dns.cleanbrowsing.org`; `chrome`: `{incognito, safe_search, youtube_restrict: "off"\|"moderate"\|"strict", safe_sites, allow_downloads, url_allowlist?, url_blocklist}` |
| `maintenance_until` | int? | adb works until then |
| `frp_accounts` | string[] | Google account ids for factory reset protection |
| `play_accounts` | string[] | Play's allowed accounts: the email addresses (lowercase, at most 5) of the parent-owned Google accounts Google Play may use; empty: the phone leaves Play's configuration alone (see the rules above) |
| `support_message` | string? | the parent's words for blocked-app screens |
| `requests` | `[{id, status: "pending"\|"approved"\|"declined"\|"talk", note?, answered_at?, answered_by?}]` | the kid's requests of the last 30 days |
| `agent_update` | `{version_code, version_name?, sha256, size}`? | Phase 6: the version of Belay a parent approved for this phone |
| `recovery` | `{version, salt, hash}`? | Phase 6: the recovery key's check (above); `salt` is 16 bytes, hex |
| `commands` | `[{id, kind: "remove_other_users"\|"lock_now", issued_at, expires_at?, via?}]` | one-shot commands not yet reported; after `expires_at` the phone doesn't run one; `via` names the AI app a parent used to ask, for the kid's notice (the server always sends it: null when a person asked, for any kind) |
| `screen_time` | ScreenTime? | Phase 3; null measures nothing and limits nothing |
| `stage` | `{name, number, since, next?: {name, unlocks: string[], how?, screen_time?}}`? | Phase 3, for the kid's screen; `unlocks` and `how` are the family's words |
| `agreement` | `{version, sections: [{title, text}], kid_agreed_at?, parents_agreed_at?}`? | Phase 3; at most 20 sections of 2000 characters |
| `network_log` | `{enabled, private_domains}` | Phase 3: whether the phone logs which domains its apps look up (`POST /network`); off unless a parent turns it on, never an AI app. `private_domains`: the family's private websites, at most 100 registrable domains (lowercase hostnames, checked like a `network` entry's `domain`) the phone never keeps a lookup of, or of a name under one, like 988's websites; a parent's alone, sent whether logging is on or off. A phone that doesn't know it reads `{enabled}` as before |
| `location` | Location? | Phase 4; null or `mode: off`: no location at all |
| `ai_reads` | string[] | Phase 7: the data categories the AI app may read |
| `help_seen` | `[{request_id, at, by?}]` | Phase 7: the last 30 days |
| `parent_numbers` | `[{name, number}]` | Phase 7: at most 4; `number` in E.164, `name` at most 40 characters |
| `calls` | `{mode: "open"\|"contacts", unknown, withheld: "reject"\|"voicemail"\|"ring", outgoing: "contacts"\|"any", quiet, log}`? | Phase 5; null: Belay isn't the dialer |
| `contacts` | `[{id, name, numbers: [E.164], calls, texts, parent}]` | Phase 5: at most 500; `name` at most 60 characters, at most 5 numbers |
| `private_numbers` | string[] | Phase 5: E.164 numbers Belay never records or reads, beyond 988 and emergency numbers; at most 50 |
| `blocked_numbers` | string[] | Phase 5: E.164 numbers a parent blocked; Belay, as the dialer, puts them on Android's block list (which blocks their texts too); at most 500 |
| `handover` | `{at, by}`? | Phase 11: a parent is handing the phone over (see "Off belay"); `by` is the parent's name, null from the server's CLI |
| `off_belay` | `{how, position: "on"\|"next"\|"later"}`? | Phase 11: the family's last stage, for the kid's "My stage": the family's words for when it comes (at most 1000 characters, or null), and where it is for this phone |

The `commands` kinds gain `locate_now` (Phase 4).

**Location** (Phase 4; the rules are above)

| Field | Type | |
|---|---|---|
| `mode` | `"off"` \| `"on_demand"` \| `"periodic"` | |
| `every_minutes` | int? | periodic: 15 to 120 |
| `hours` | `{start: "HH:MM", end: "HH:MM"}`? | periodic fixes only within these hours, in the phone's zone |
| `provider` | `"gps"` \| `"fused"` | default `"gps"` |
| `fallback_fused` | bool | |
| `places` | `[{id, name, lat, lng, radius_m, notify: ("arrive"\|"leave")[]}]` | at most 20; `name` at most 40 characters; `radius_m` 50 to 1000 |
| `keep_on` | bool | |
| `lost` | `{since, message}`? | `message` at most 120 characters |

The answers in `requests` gain `minutes?` (Phase 3: an approved `more_time`).

**ScreenTime** (Phase 3; the rules are above)

| Field | Type | |
|---|---|---|
| `measure` | bool | count app time and send it with `POST /usage` |
| `zone` | string | an IANA zone, or `"phone"` |
| `day_starts` | `"HH:MM"` | when a day's limits reset |
| `limits` | `[{id, name, packages, minutes, by_day?: {mon…sun}}]` | at most 50; `name` is the family's words, or Belay's for one an AI app added (60, one line); `packages: ["*"]` is a daily total; `minutes` 0 to 1440 |
| `schedules` | `[{id, kind: "school"\|"bedtime"\|"custom", name, days: ["mon"…], start, end, allow, lock, skip: ["YYYY-MM-DD"]}]` | at most 20 |
| `exempt` | string[] | never counted or paused |
| `if_unmeasured` | `"pause_limited"` \| `"keep_open"` | |
| `extra` | `[{id, limit_id, minutes, day, request_id?, package?}]` | `limit_id: "*"` gives every limit the minutes; `package` keeps them for one app |
| `self_serve` | `{minutes, times}`? | |
| `warn_before` | int | minutes; 0: no warnings |

**Request** (phone → server)

| Field | Type | |
|---|---|---|
| `id` | string | UUID made on the phone |
| `kind` | `app`, Phase 3: `more_time` `agreement`, Phase 7: `help` `talk` (`talk` needs `reason`), Phase 5: `contact` | |
| `package` | string (app), string? (more_time: the app the kid was in) | |
| `label` | string (app only) | untrusted |
| `limit_id`, `minutes` | string, int (more_time only: 5 to 240) | |
| `version`, `answer` | int, `agree`\|`talk` (agreement only) | |
| `location` | Fix? (help only) | Phase 7: only when the kid chose to share it |
| `contact_name`, `contact_number` | string, E.164 (contact only) | Phase 5: the kid's words: untrusted |
| `withdrawn_at` | int? | Phase 7: withdraws a pending request |
| `reason` | string? | the kid's own words, at most 500 characters: untrusted |
| `asked_at` | int | |

**Enforcement** (in Device, from Phase 2)

| Field | Type | |
|---|---|---|
| `policy_version` | int | the version applied |
| `applied_at` | int? | |
| `suspended_count` | int | apps held suspended or hidden now |
| `problems` | string[] | Belay's own words for what it couldn't do, and for what can get around the rules that it noticed (another user or profile, a proxy on the network while there's a web filter, wireless debugging), at most 20 of 200 characters; the server shows the second kind first |
| `agent_update` | `{version_code, state: "downloading"\|"checking"\|"installing"\|"failed"\|"done", problem?, at}`? | Phase 6: the offered update; `done` once Belay runs that version or a newer one |
| `recovery` | `{version, used_at, until}`? | Phase 6: the last use of the recovery key; repair access is open until `until` |
| `commands` | `[{id, result: "done"\|"failed"\|"expired", at, problem?}]` | the last 20 commands' results, newest first |
| `never_blocked` | string[] | the packages this phone never blocks, at most 100 |
| `screen_time` | `{day, measured, used_minutes?, limits: [{id, used?, left?, state: "open"\|"used_up"\|"extra"}], schedule?: {id, until}, self_serve: [{limit_id, package?, minutes, at}]}`? | Phase 3: the phone's view now; minutes left out when `measure` is off (`used` rounds down, `left` up) |
| `network_log` | `{enabled, paused}`? | Phase 3: null while the policy's `network_log` is off and Android's logging is too; `enabled`: Android logs for Belay; `paused`: Android paused it, while another user or profile is on the phone |
| `location` | `{permission, location_on, last_fix_at?, problem?}`? | Phase 4: null while location is off |
| `calls` | `{dialer, problem?}`? | Phase 5: whether Belay is the default dialer |

**CallRecord** (phone → server, Phase 5): `{id, at, direction: "in"|"out", contact_id?, number?,
duration_s, outcome: "answered"|"missed"|"rejected"|"voicemail"|"not_placed", reason?:
"unknown"|"withheld"|"quiet"|"not_allowed"}`; `number` (E.164) only when `contact_id` is null.

**Fix** (phone → server, Phase 4)

| Field | Type | |
|---|---|---|
| `id` | string | UUID made on the phone |
| `at` | int | the fix's own time |
| `lat`, `lng` | number | 5 decimal places |
| `accuracy_m` | int | |
| `provider` | `"gps"` \| `"fused"` | the one that answered |
| `reason` | `"on_demand"` \| `"periodic"` \| `"place"` \| `"lost"` \| `"help"` | |
| `command_id` | string? | the `locate_now` it answers |
| `mock` | bool | |

**PlaceEvent**: `{id, place_id, kind: "arrived"|"left", at, fix_id}`.

**UsageDay** (phone → server, Phase 3)

| Field | Type | |
|---|---|---|
| `day` | `"YYYY-MM-DD"` | in `zone` |
| `zone` | string | IANA |
| `as_of` | int | counted up to this time |
| `complete` | bool | the day is over |
| `screen_minutes` | int | screen on and unlocked (a day with a clock change can have 25 hours) |
| `unlocks` | int | |
| `by_hour` | int[24] | screen minutes per local hour; the day clocks go back, both 1 a.m. hours add up |
| `apps` | `[{package, minutes, opens}]` | at most 500, most used first; under a minute and never-blocked apps left out |
| `gaps` | `[{from, to, reason: "no_usage_access"\|"phone_off"\|"unknown"}]` | times Belay couldn't count |

**NetworkDay** (phone → server, Phase 3)

| Field | Type | |
|---|---|---|
| `day` | `"YYYY-MM-DD"` | in `zone` |
| `zone` | string | IANA: the phone's own |
| `as_of` | int | the newest lookup counted |
| `entries` | `[{package, domain, lookups}]` | at most 5000, most looked up first; `domain` a lowercase Punycode hostname (untrusted) |
| `dropped` | int | entries cut to stay under 5000 (and 400 KB) |

**Device** (facts and the agent's own health; nothing about the kid's content)

| Field | Type |
|---|---|
| `manufacturer`, `model`, `android_release`, `sdk_full`, `security_patch` | string |
| `sdk` | int |
| `agent_version_name` | string |
| `agent_version_code` | int |
| `boot_count` | int? |
| `last_boot_at`, `device_time` | int (`device_time`: the phone's clock, for skew) |
| `timezone` | string (IANA) |
| `battery_percent` | int? |
| `charging` | bool? |
| `storage_free_bytes`, `storage_total_bytes` | int? |
| `health` | Health |
| `enforcement` | Enforcement? (Phase 2) |
| `agent_signing_sha256` | string? (Phase 6: SHA-256 of Belay's signing certificate, hex; the server pins the first it sees) |

**Health**

| Field | Type |
|---|---|
| `device_owner`, `battery_exempt`, `usage_access`, `notifications_shown`, `background_restricted`, `service_running`, `test_only` | bool |
| `uninstall_blocked` | bool? (null when not device owner) |
| `standby_bucket` | int (5 = exempted) |
| `permissions` | `[{name, granted, fixed_by_policy}]`, Belay's own runtime permissions |
| `other_users` | int? (Phase 10: users or profiles other than the kid's own; null when not device owner) |
| `foreign_restrictions` | string[] (Phase 10: user restrictions in force that Belay didn't set, at most 20) |
