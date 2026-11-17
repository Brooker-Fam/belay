# Phase 3: screen time, schedules and stages

**Status: built**, network logging included, on the server and the phone, and run end to end in
CI on the Android 17 emulator (README, "What exists"; [protocol.md](../protocol.md)); where the
build differs from this design, the protocol and the code are right. **Still open:**
[phase3-checklist.md](../phase3-checklist.md) on the Pixel. Android facts cite the drafts in
[platform-notes-drafts.md](platform-notes-drafts.md) by id (U1, S2…); the ones Belay relies on
moved to [platform-notes.md](../platform-notes.md), network logging's as W1 and W6 to W9. Network
logging was built with these decisions:

- Registrable domains without the Public Suffix List (the open question below): a name keeps its
  last two labels, or three under a country's second level (`bbc.co.uk`), so a name under a
  shared suffix says less, not more (core's network/Domains.kt).
- Never kept, besides the never-blocked apps: lookups Android can't tie to one app (a shared user
  id, "name:uid"), 988's websites (on the phone and the server), IP addresses, reverse lookups
  and the home network's own names.
- A day is the phone's own zone's, and `POST /network` replaces a stored day whatever its
  `as_of` (the outbox keeps one unsent report per day, in order). `paused` comes from the other
  users and profiles the phone counts, and from Android refusing a batch.
- The switch is on the phone's page under Web; the Network tab shows while it's on (the kept days
  stay readable on it after, until they age out or a parent stops collecting).

## Goals

1. **Know how the phone is used,** per app and per local day, measured on the phone with public
   APIs only.
2. **Daily limits and schedules** (school, bedtime, custom) that the phone enforces by itself,
   offline too, with "lock now".
3. **"Ask for more time":** the kid asks on the phone, a parent answers on the parent page.
4. **Report usage access plainly** when it's off, and keep the rules meaningful anyway.
5. **Stages and a family agreement:** named levels bundle the rules, so loosening is a visible
   step the kid works toward; the phone shows what unlocks next; an MCP prompt,
   `family_check_in`, helps parent and kid go over it each month.
6. **AI summaries** of screen time, from the parent's own MCP client.
7. **Opt-in network logging:** which domains apps look up. Off by default, and off for AI by
   default.

Not goals: reading what's on the screen; per-website time; blocking by content category (the
DNS filter from Phase 2 does that); background audio counted as screen time.

## What Android 17 allows

| Need | What Android 17 offers | Notes |
|---|---|---|
| Foreground time | `UsageStatsManager.queryEvents(UsageEventsQuery)` (API 35), with usage access | Events visible at once; about 10 days kept; empty, not an error, without access (U1). The older `queryEvents(long, long)` is flagged for deprecation in AOSP 17. |
| Daily totals | `queryUsageStats(INTERVAL_DAILY)` | Not usable: buckets roll over every 24 h from an arbitrary start, not at local midnight (U2). |
| Limit callbacks | `registerAppUsageObserver`, `registerAppUsageLimitObserver` | Not for Belay: `@SystemApi`, or the system-only supervision role (U3, V3). Belay counts by itself. |
| Usage access | Granted over adb at provisioning (R1) | The kid can turn it off, and on again, in Settings; Belay can only notice (U4). |
| Enforce | `setPackagesSuspended` | The app's screens close and it loses audio focus; its process isn't killed (S2). The kid sees one generic "Can't open this app" screen (S1). Default dialer, launcher, device admins and a few system packages can't be suspended. |
| Coexist | Digital Wellbeing's own timers | Separate suspensions; they add up, never cancel Belay's (S4). Android's own Parental Controls share Belay's suspension entry and can lift it (S4, V1): Phase 10. |
| Lock now | `DevicePolicyManager.lockNow` | Needs `<force-lock/>` unless a flag is on; with the kid's own PIN it's only a nudge (S5). |
| On time | Exact alarms | Doze-allowlisted apps are exempt from the exact-alarm permission; `USE_EXACT_ALARM` as a backup (S6). |
| Clock | `DISALLOW_CONFIG_DATE_TIME` (Phase 2) | Covers the time zone too (H2). |
| Network logging | `setNetworkLoggingEnabled`, `retrieveNetworkLogs`, `onNetworkLogsAvailable` | DNS lookups and TCP connects per app, in batches of 1200 events or 90 min; UDP and apps' own DNS aren't logged; Android shows its own "may monitor network traffic" notice; paused while any unaffiliated user or profile exists (W1, V2). |

## Design

### On the phone

**Measuring (`:core` does the arithmetic, `:app` reads).**

- `UsageReader` (`:app`) calls `queryEvents(UsageEventsQuery)` for these event types only:
  `ACTIVITY_RESUMED`, `ACTIVITY_PAUSED`, `ACTIVITY_STOPPED`, `SCREEN_INTERACTIVE`,
  `SCREEN_NON_INTERACTIVE`, `KEYGUARD_SHOWN`, `KEYGUARD_HIDDEN`, `DEVICE_SHUTDOWN`,
  `DEVICE_STARTUP`. It keeps a cursor (last event time, boot count) in Room and stores the raw
  events of the last 3 days, so a day can always be recomputed.
- `ScreenTime` (`:core`, pure, JVM-tested) turns events into intervals: an app counts from
  `ACTIVITY_RESUMED` until `ACTIVITY_STOPPED` (so a visible picture-in-picture window counts, and
  two apps in split screen each count), clipped by screen off and keyguard shown. Screen time for
  the day is the union of all intervals, so split screen isn't counted twice. Intervals are split
  at the day boundary in the policy's zone (`zone`, `day_starts`); a day that crosses a DST change
  has 23 or 25 hours.
- A gap with no events and no way to tell (usage access off, the phone off) is recorded as a gap,
  not as zero.
- Polling: every 60 s while the screen is on (Belay's foreground service already runs), once at
  screen off, and at every agent step. Nothing while the screen is off.

**Deciding (`:core`).** `Rules.evaluate(policy, now, usage) → Decision` is a pure function: which
packages must be suspended right now and why (`limit`, `schedule`, `pause`, `unmeasured`), what
to tell the kid, and when to evaluate next. Inputs that decide nothing are ignored, never
guessed. Rules:

- Never-blocked packages (Phase 2) and `exempt` packages are never suspended or counted.
- A limit covers its packages; `["*"]` covers every app that isn't exempt (a daily total).
  Several limits can cover one app; the first one used up suspends it.
- An app is open again when the day turns, when a parent's extra time is added, or when the kid
  takes self-serve minutes.
- A schedule suspends every launchable app except never-blocked, exempt and the schedule's
  `allow` list, from `start` to `end` on its `days`, except `skip` dates. `end` earlier than `start`
  means it ends the next morning.
- If Belay can't measure (`usage_access` off), `if_unmeasured` decides: `pause_limited` suspends
  every app that has a limit (default), `keep_open` keeps them open. Schedules don't need
  measuring and keep working either way.

**Enforcing (`:app`).** The agent diffs the decision against what Belay holds, suspends and
unsuspends through `DevicePolicyManager`, and records each package's reason in Room. It re-reads
`isPackageSuspended` for everything it holds at each step and on `ACTION_PACKAGES_UNSUSPENDED`,
and puts it back if something else lifted it (S4). Steps run on `Agent.handle`'s thread, as
today, and are idempotent.

- **When:** at the next boundary from the last decision (a schedule start or end, the predicted
  minute a limit runs out while that app is in front, midnight in the zone), with
  `setExactAndAllowWhileIdle` (S6); and at screen on, user present, time or zone change, policy
  change, boot, and every poll.
- **Warnings:** a notification 5 minutes before a limit runs out or a schedule starts
  (`warn_before`), and at 1 minute.
- **Time's up:** suspension closes the app (S2); Belay's notification says which limit and when it
  comes back, with "Ask for more time".
- **Lock now:** the server sets Phase 2's `pause` with `until`, and adds a `lock_now` command; the
  phone suspends as for any pause and calls `lockNow` once per command id. A bedtime schedule with
  `lock: true` does the same at its start.
- **Usage access lost:** `AppOpsManager.startWatchingMode` notices at once; health reports
  `usage_access: false` (Phase 1 already does) and `enforcement.screen_time.measured: false`;
  the kid's screen explains and offers "Turn usage access back on" (it opens the system's usage
  access settings).

**Network logging (opt-in).** When `network_log.enabled`, Belay calls `setNetworkLoggingEnabled`.
`AdminReceiver.onNetworkLogsAvailable` retrieves the batch at once (it's discarded 5 minutes after
retrieval, W1) and hands it to `NetworkDigest` (`:core`), which keeps only DNS events and reduces
each hostname to its registrable domain (`chat-7.cdn.example.com` → `example.com`). Raw events never
reach Room or the outbox: only per-day, per-app, per-domain counts do. Connect events (IP and
port) are dropped. If retrieval throws (an unaffiliated user exists, V2), the phone reports
`network_log.paused` and the parent page says why.

**Uploads.** Usage goes out through the outbox like events: a day's totals every 15 minutes while
the phone is used, and once more when the day is complete. Each upload replaces the day on the
server, so it's idempotent. The check-in carries "today so far" in `enforcement.screen_time`.

### On the server

- **Tables** (one new migration): `usage_days` (device, day, zone, as_of, complete, screen
  minutes, unlocks, by-hour JSON, gaps JSON) and `usage_apps` (device, day, package, minutes,
  opens); `stages` (family-wide named templates); `phone_stages` (which stage a phone is on, since
  when); `agreements` (versioned sections, who agreed when); `network_days` (device, day,
  package, domain, lookups).
- **Policy build:** the phone's `screen_time` is the stage's template with the phone's own
  overrides on top, plus today's extra time. Changing a stage template changes every phone on it,
  so it goes through the same checks below.
- **Tighten or loosen:** one function, `classifyScreenTimeChange(before, after)`, with tests:
  lowering a limit, adding a limit, starting a schedule earlier or ending it later, adding days to
  a schedule, removing an app from `allow` or `exempt`, setting `if_unmeasured: pause_limited`,
  lowering self-serve, and moving down a stage tighten. Everything else loosens. AI clients may
  apply a change that only tightens; anything that loosens becomes a proposal for the parent page
  (Phase 2's rule). Moving a phone to another stage, either way, is a parent's action on the
  parent page: AI clients can only propose it.
- **Collection is a parent decision.** Turning `measure` or `network_log` on or off is never an AI
  action, in either direction. More collection is a privacy choice, not a safety tightening.
- **Kept:** usage 13 months (trends), network digests 30 days, then deleted by the maintenance
  job. Both are settings.
- **Requests:** a `more_time` request notifies the parents (Phase 2's push), with buttons for
  15, 30 and 60 minutes, "No" and "Let's talk". Approving adds an `extra` entry for today.
- Every change and every read goes through `audit()`.

### MCP

New tools (`READ` unless noted; text from the kid or app developers stays under `untrusted`):

| Tool | What it does |
|---|---|
| `get_screen_time(device, from?, to?)` | Per day: screen minutes, unlocks, the hours the phone was used, top apps with minutes and opens, gaps and why. Default the last 7 days. Scope `screen_time`. |
| `get_rules(device)` | The stage, limits, schedules, exempt apps, self-serve, today's state ("Games: 20 min left"), pending requests. Always available (rules aren't the kid's data), but app names are `untrusted`. |
| `change_screen_time(device, change)` | **Write.** A change to limits, schedules, `exempt`, `allow` or self-serve. The server classifies it: if it only tightens, it applies; otherwise it becomes a proposal and the tool says a parent must approve it on the parent page. |
| `lock_phone(device, minutes, note?)` | **Write, tightens.** Pauses the phone now for 5 to 240 minutes and locks the screen; calls, texts, Belay, 911 and 988 still work. |
| `get_network_activity(device, from?, to?)` | Domains per app per day. Scope `network`, off by default. |

No tool answers the kid's requests. A parent answers on the parent page: the answer is a message
from a person to their kid, and approving more time loosens. An AI client can summarize pending
requests and suggest an answer.

Prompts:

- **`family_check_in(device)`**, for a monthly talk with the kid in the room: read `get_rules`,
  30 days of `get_screen_time`, the month's requests and answers, and the agreement; say what went
  well first (limits kept, requests made politely, agreement followed); then what was hard,
  without judging; show what the next stage would change, in the stage's own sentences; ask three
  open questions for the kid; end with changes the family might make, only as suggestions. It
  never diagnoses, never guesses at the reasons behind the kid's use, and never applies a change
  unless the parent asks, and then only through `change_screen_time`.
- **`weekly_review`** gains a short screen-time section: totals against the limits, changes from
  last week, anything Belay couldn't measure.

Server instructions gain: "Screen time is a number, not a verdict about the kid. Report it plainly,
don't guess why, and don't moralize."

### On the parent page

- A phone's **Screen time** tab: today and the last 7 days as simple server-rendered bars (no
  JavaScript chart library), per app, with gaps shown as gaps.
- **Rules:** limits and schedules with a weekday picker; exempt apps; self-serve; the "can't
  count" rule; a preview: "With these rules, a school day allows…".
- **Stages:** create and edit named stages (templates), pick a phone's stage, and write "how to
  get to the next stage" in the family's words. The page shows what the next stage changes, as the
  kid will see it.
- **Agreement:** sections the family writes together; a new version asks the kid again.
- **Requests:** the inbox from Phase 2, with "more time" buttons.
- **Network** (only when on): domains per app per day, with the retention stated.

### On the kid's phone

- **Today:** for each limit, the time left ("20 minutes left for Games"); the schedule now
  ("School time until 3:00 pm"); "Ask for more time"; self-serve if allowed.
- **Time's up** notification and screen (generic system screen when tapping the app, S1; Belay's
  own notification says which limit and when it comes back).
- **Bedtime** notification, with what still works.
- **Your stage:** its name, what the next stage changes, how to get there, in the family's words.
- **Your family agreement:** read it, then "I agree" or "I want to talk about it".
- **What your parent can see** gains "How long you use apps", and the network entry when it's on,
  built from the collectors that are on (see Privacy).

## Protocol

Additive to [docs/protocol.md](../protocol.md); every new policy field has a default that
enforces and collects nothing. `core/Protocol.kt` and `server/src/device/schemas.ts` change with
it.

### Policy additions

| Field | Type | |
|---|---|---|
| `screen_time` | ScreenTime? | null: no measuring, no limits, no schedules |
| `stage` | Stage? | for the kid's screen |
| `agreement` | Agreement? | for the kid's screen |
| `network_log` | `{enabled: bool}` | default `{enabled: false}` |
| `commands` | Command[] | one-shot actions, shared with later phases |

**ScreenTime**

| Field | Type | |
|---|---|---|
| `measure` | bool | count app time and send it with `POST /usage` |
| `zone` | string | an IANA zone, or `"phone"`: the phone's own zone (locked by Phase 2's `config_date_time`) |
| `day_starts` | `"HH:MM"` | when a day's limits reset; default `"00:00"` |
| `limits` | Limit[] | at most 50 |
| `schedules` | Schedule[] | at most 20 |
| `exempt` | string[] | packages never counted or paused, beyond the never-blocked set |
| `if_unmeasured` | `"pause_limited"` \| `"keep_open"` | when usage access is off; default `"pause_limited"` |
| `extra` | Extra[] | extra time a parent gave, for one day |
| `self_serve` | `{minutes, times}`? | extra time the kid may take without asking, per day (a rule a parent set) |
| `warn_before` | int | minutes; default 5 |

**Limit**

| Field | Type | |
|---|---|---|
| `id` | string | |
| `name` | string | the family's words ("Games"), at most 60 characters; untrusted for AI |
| `packages` | string[] | apps sharing the limit; `["*"]`: every app that isn't exempt |
| `minutes` | int | per day, 0 to 1440 |
| `by_day` | `{mon…sun: int}`? | overrides `minutes` on those days |

**Schedule**

| Field | Type | |
|---|---|---|
| `id` | string | |
| `kind` | `school` \| `bedtime` \| `custom` | |
| `name` | string | untrusted |
| `days` | (`mon` … `sun`)[] | |
| `start`, `end` | `"HH:MM"` | `end` before `start`: ends the next day |
| `allow` | string[] | apps that stay open, beyond never-blocked and exempt |
| `lock` | bool | lock the screen when it starts |
| `skip` | `"YYYY-MM-DD"`[] | days it doesn't apply |

**Extra**: `{id, limit_id, minutes, day: "YYYY-MM-DD", request_id?}`.

**Command** (shared): `{id, kind, issued_at, expires_at}`. Phase 3 defines `kind: "lock_now"`.
The phone runs each id once, ignores it after `expires_at`, and reports it in
`enforcement.commands`.

**Stage**: `{name, number, since, next?: {name, unlocks: string[], how?: string}}`. `unlocks` are
sentences the server writes from the difference between the two stages ("Daily screen time goes
from 1 h 30 min to 2 h"); `how` is the parents' words. All untrusted for AI.

**Agreement**: `{version, sections: [{title, text}], kid_agreed_at?, parents_agreed_at?}`; at most
20 sections of 2000 characters, the family's words.

### Enforcement additions (in Device)

| Field | Type | |
|---|---|---|
| `screen_time` | `{day, measured, used_minutes, limits: [{id, used, left, state: "open" \| "used_up" \| "extra"}], schedule?: {id, until}}`? | the phone's view right now |
| `commands` | `[{id, result: "done" \| "failed" \| "expired", at, problem?}]` | the last 20 |
| `network_log` | `{enabled, paused}`? | `paused`: Android paused logging (V2) |

### `POST /api/v1/usage`

256 KB, at most 31 days.

```json
{ "days": [ { …UsageDay… } ] }
```
→ `200`
```json
{ "server_time": 1794867161711, "accepted": 1 }
```

Idempotent by `(day, zone)`: a day sent again replaces the stored one if its `as_of` is newer.

**UsageDay**

| Field | Type | |
|---|---|---|
| `day` | `"YYYY-MM-DD"` | in `zone` |
| `zone` | string | IANA |
| `as_of` | int | the newest event counted |
| `complete` | bool | the day is over |
| `screen_minutes` | int | screen on and unlocked |
| `unlocks` | int | |
| `by_hour` | int[24] | screen minutes in each local hour |
| `apps` | `[{package, minutes, opens}]` | at most 500; apps under a minute are left out |
| `gaps` | `[{from, to, reason: "no_usage_access" \| "phone_off" \| "unknown"}]` | times Belay couldn't count |

### `POST /api/v1/requests`: new kinds

`Request` becomes a union on `kind` (Phase 2's `app` is unchanged; `package` and `label` are
required only for `app`):

| `kind` | Extra fields | |
|---|---|---|
| `more_time` | `limit_id`, `minutes` (5 to 240), `package?` (the app the kid was in), `reason?` | an answer `approved` carries `minutes` |
| `agreement` | `version`, `answer: "agree" \| "talk"`, `reason?` | |

The policy's `requests` answers gain `minutes?`.

### `POST /api/v1/network`

512 KB, at most 31 days.

```json
{ "days": [ { "day": "2026-11-17", "zone": "America/Los_Angeles", "as_of": 1794867161711,
              "entries": [ { "package": "com.example.chat", "domain": "example.com", "lookups": 42 } ],
              "dropped": 0 } ] }
```

Idempotent by day: replaces. `domain` is a lowercase hostname (Punycode), at most 253 characters,
validated like a hostname; it's developer-controlled text, so untrusted. `dropped` counts entries
cut to stay under 5000 per day.

## Privacy and transparency

**Collectors decide the list.** Phase 1's `Collectors.categories` is a fixed list. From Phase 3 it
becomes the categories of the collectors that are *on* under the current policy, so the kid's
"What your parent can see" changes the moment the family turns something on. The rule is the
same: the list is built from the code that collects.

**New `DataCategory` entries**

| id | Title (kid-facing) | Details |
|---|---|---|
| `screen_time` | How long you use apps | "How many minutes each app is on your screen each day, and how many times you open it"; "How long the screen is on in each hour, and how many times you unlock the phone"; "When Belay couldn't count, like when usage access was off" |
| `network` | Which websites and services apps connect to | "The names of the websites and online services each app looks up, like example.com, and how many times a day. Not the pages, messages, searches or anything you type." |

Requests (Phase 2) already cover "Things you ask your parent for, with your reasons"; the
agreement is the family's own document, shown in full on the phone.

**AI scopes** (`server/src/settings.ts`): `screen_time` (default on: AI summaries are the point of
this phase; a parent can turn it off), `network` (default off), `agreement` (stage, agreement and
the kid's request reasons; default on). **privacy.md** gains a line for each, and the retention
times.

**Kid-facing words** (`strings.xml`, drafts):

- "%1$s left today for %2$s"
- "Time's up for %1$s today. It comes back %2$s." ("tomorrow at 12:00 am")
- "Ask for more time" · "Sent to your parent. You'll see the answer here."
- "Take %1$d more minutes. You can do this %2$d more times today."
- "Bedtime until %1$s. Apps are paused. You can still call and text your parents, 911 and 988."
- "Your parent paused this phone until %1$s."
- "Belay can't count screen time right now, because usage access is turned off. Apps with a time
  limit are paused until it's back on." · "Turn usage access back on"
- "Your stage: %1$s" · "What changes at the next stage" · "How to get there"
- "Your family agreement" · "I agree" · "I want to talk about it"
- Network logging: "Belay also notes which websites and online services apps connect to, by name,
  like example.com. Not pages, messages or what you type."
- "When Android says \"your organization\", it means your parent, through Belay." (Android's own
  network-logging notice says "Your organization… may monitor network traffic", W1, and Belay
  can't change Android's words, L1.)

## Threat model changes

| What the kid could do | With Phase 3 |
|---|---|
| Turn off usage access | Noticed at once and reported ("Usage access for Belay is turned off"); apps with a limit pause by default (`if_unmeasured`); schedules keep working. |
| Change the clock or time zone | Locked by Phase 2 (`config_date_time` covers the zone, H2). |
| Keep watching in picture-in-picture or split screen | Counted: an app counts from resumed until stopped. |
| Keep audio playing after time's up | Suspension takes audio focus (S2); an app that ignores it could keep playing. A hard block hides the app, which stops it. |
| Use another app's built-in browser | Counts as time in that app; Phase 2's DNS filter applies; WebView policies can filter it (W4). |
| Reboot, airplane mode | Suspensions persist and the rules run offline; uploads wait in the outbox. |
| Set up Android's own Parental Controls with their own PIN | Their limits only add to Belay's, but their app policies can lift a Belay suspension (S4), and the profile pauses network logging (V2). Belay re-applies and reports it: Phase 10. |
| Ask the parent's AI for more time | AI clients can't approve time or move stages; only a parent on the parent page. |
| Name an app to steer the AI | Labels, limit names, stage text and request reasons stay `untrusted` (principle 3). |
| Avoid network logging | Apps with their own DNS-over-HTTPS or a fixed IP aren't logged as DNS, and UDP isn't logged (W1); VPN apps are blocked by Phase 2. Network logging is a record, not a guard. |

Other people: the AI provider sees screen-time summaries only while `screen_time` is on, and never
network data unless a parent turns `network` on.

## Test plan

**JVM (`:core`)**
- `ScreenTime`: fixtures of event streams for resumed-paused-stopped, picture-in-picture, split
  screen (no double counting), screen off and keyguard mid-session, a day boundary, a DST change,
  a reboot with no stop event, a usage-access gap; every fixture gives exact minutes.
- `Rules.evaluate`: a limit used up, several limits on one app, `["*"]` totals, a schedule crossing
  midnight, weekday and `skip`, extra time, self-serve, `if_unmeasured` both ways, never-blocked
  and exempt never suspended, the next-evaluation time.
- `NetworkDigest`: hostnames to registrable domains, counts, the 5000 cap.
- Protocol round trips for every new type, and a Phase 1 policy still parsing.

**Server (Vitest)**
- `classifyScreenTimeChange` for every field, both ways; a mixed change is a proposal.
- `POST /usage` and `/network`: replace by `as_of`, unknown fields rejected, limits.
- MCP: `change_screen_time` applies a tightening and turns a loosening into a proposal;
  `lock_phone` bounds; scopes off hide data; everything audited.
- Stage templates: policy build, the `unlocks` sentences.

**Instrumented (emulator)**
- Usage access off and on (`appops set` from the test) is noticed within a second, and
  `measured` follows.
- A suspended fixture app's task closes (S2), and `isPackageSuspended` reads back.
- An exact alarm at a schedule boundary fires within a minute with the screen off.

**CI end to end** (`ci-emulator-test.sh`, with the server)
- The server's CLI sets a 1-minute limit on the fixture app; the test opens it with `am start`;
  within 2 minutes the fixture is suspended, the server has a usage day with its minutes, and
  `enforcement.screen_time` says `used_up`.
- A `more_time` request approved with the CLI unsuspends it.
- `appops set … GET_USAGE_STATS ignore`: the server shows the usage-access problem and the limited
  fixture is paused; `allow` restores it.

## Decisions the family must make

1. Limits and schedules for each phone, and the weekday and holiday exceptions.
2. Which clock schedules follow: the family's zone, or the phone's (travel).
3. What happens when Belay can't count: pause apps with a limit (recommended) or keep them open.
4. Self-serve minutes: none, or how many and how often.
5. The stages: names, what each allows, and how the kid moves up, in the family's words.
6. The agreement, and how often to check in.
7. Network logging: off (recommended to start) or on; what AI clients may read.
8. How long to keep usage (13 months suggested) and network digests (30 days).

## Open questions

- On the Pixel: does suspension close a picture-in-picture window, does the launcher grey out
  suspended apps, and does a suspended app's background music stop?
- Flag states on the Pixel's Android 17: `lock_now_coexistence`, `deprecate_old_query_events_api`,
  `policy_transparency_refactor_enabled`, `enable_supervision_package_usage_apis`.
- Does Digital Wellbeing's dashboard work on a device-owner phone, and should Belay link to it
  for the kid?
- Registrable domains need the Public Suffix List (publicsuffix.org: MPL-2.0, about 340 KB on
  2026-11-17). Bundle it (an MPL file kept unmodified, credited in NOTICE), or keep the last two
  labels and accept errors like `co.uk`?
- Should screen time count calls in the dialer (never limited, Phase 2 never-blocked) toward the
  day's screen minutes? Proposed: count them in `screen_minutes` but never limit them.
