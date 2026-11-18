# Phase 13: mobile data

**Status: designed, not built yet.** The Android facts are in
[platform-notes.md](../platform-notes.md) as Q1 to Q9, read in AOSP `android-17.0.0_r1` and on
developer.android.com on 2026-11-18; none of them ran on a device yet.

A kid's first phone is usually on a family plan with a data cap. This phase has two parts, both
off until a parent turns them on: **Wi-Fi-only apps** (enforcement: a parent marks apps that may
not use mobile data, and the phone enforces it as device owner) and **mobile data use** (a new
data category: how much mobile data each app used each day).

## Goals

1. **Wi-Fi only:** a parent marks apps (video and game apps, say) that may not use mobile data.
   The phone enforces it by itself, offline too, through Android's own per-app metered-data
   restriction. Adding an app tightens: an AI app may do it when the parent asks. Removing one
   loosens: an AI app can only propose it.
2. **Never the phone's lifelines:** Belay never restricts itself, the phone and texting apps (RCS
   needs data), the keyboard, the home screen, Android's own parts, or anything else the phone
   never blocks. 911 and 988 always work.
3. **Mobile data use, off by default:** per app per day, how many bytes each app used on mobile
   data, and the day's total on Wi-Fi, from Android's own accounting. Never which websites, which
   Wi-Fi networks, or anything inside the traffic.
4. **Transparent to the kid:** the kid sees which apps are Wi-Fi only and why ("Wi-Fi only: your
   parent chose this"), and "What your parent can see" lists mobile data use the moment a parent
   turns it on.
5. **A plain picture for the parent:** a phone's Mobile data tab with the Wi-Fi-only list, and the
   days as bars with a table of the same numbers; an MCP tool and a part of the weekly review.

Not goals: a hard data cap (Android's own data warning and limit are the phone's Settings'),
which websites or services use the data (Phase 3's network logging is that, and it's separate),
which Wi-Fi network the phone is on, blocking an app on Wi-Fi (block the app instead), and
throttling.

## What Android 17 allows

| Need | What Android 17 offers | Notes |
|---|---|---|
| Keep an app off mobile data | `DevicePolicyManager.setMeteredDataDisabledPackages(admin, packages)`, API 28 (Q1) | Device owner or profile owner only. Returns the packages it couldn't restrict: an active device admin (Belay itself), a financed-device role holder, or a package that isn't installed and visible (a hidden app isn't). It keeps only the rest, so an app installed later needs another call. |
| Read it back | `getMeteredDataDisabledPackages(admin)` (Q1) | Belay's own list, as Android kept it. `dumpsys device_policy` prints it as `meteredDisabledPackages=[…]`. |
| How it's enforced | NetworkPolicyManagerService: `BLOCKED_METERED_REASON_ADMIN_DISABLED` per uid (Q2) | On every metered network. Neither the app being in front, Data Saver's "Unrestricted data" nor the app's "Background data" switch lifts it; the app's SDK sandbox gets the same rule. Applied to app uids with `INTERNET` only, never Android's own uids. Android resolves packages to uids when Belay calls, and again at each boot. |
| Which networks | Any network without `NET_CAPABILITY_NOT_METERED` (Q3) | Mobile data; Wi-Fi marked metered in Settings; Wi-Fi whose DHCP says `ANDROID_METERED`, as every Android phone's hotspot does; a "chargeable public" hotspot. A Wi-Fi network the user marks "Treat as unmetered" isn't metered, whatever its DHCP says. |
| What the app sees | No network (Q4) | `getActiveNetwork()` returns null for it on a metered default network, and its traffic there is dropped: it acts offline. Android shows no notice. |
| What the kid can change | Nothing that lifts it (Q4, Q5) | Settings' "Mobile data & Wi-Fi" page shows the app's two switches as "Disabled by admin". Resetting app preferences or network settings keeps it. Data Saver and the app's own switch only add restrictions. |
| Per-app mobile data | `NetworkStatsManager.querySummary(TYPE_MOBILE, null, start, end)` (Q6) | A device owner has device-wide access, with or without usage access. Per uid; `null` covers every mobile subscription, metered ones only. |
| The Wi-Fi total | `querySummaryForDevice(TYPE_WIFI, null, start, end)` (Q6) | One number, all Wi-Fi; no network names (asking per network needs location). |
| Granularity and delay | 2-hour buckets for apps, kept 90 days (Q7) | A query that starts or ends inside a bucket gets a share of it by time. Android polls every 30 minutes; a query polls first unless another app polled in the last 15 s. |
| Special uids | `UID_REMOVED`, `UID_TETHERING`, Android's own uids (Q8) | A removed app's history moves to "removed apps". The phone's own hotspot is "tethering". Uids under 10000 are Android's; a shared uid is several packages at once. |
| Other paths | The download manager, Play (Q9) | A download an app hands to Android's download manager is made by the download manager's own job, so it may use mobile data. App updates come through Play's own uid. |

## Design

### On the phone

**Wi-Fi only (`:core` decides, `:app` applies).** `core/mobiledata/WifiOnly.kt` is a pure
function, JVM-tested:

- **Which packages:** the policy's `mobile_data.wifi_only`, each one installed and not hidden by
  Belay (a blocked app is blocked anyway, and Android won't take a hidden one, Q1), minus every
  package Belay never restricts.
- **Never restricted:** the never-blocked set (core's `NeverBlocked.of`: Belay, Android's fixed
  packages, the dialers, emergency apps, the texting app, the home screens, Settings, the keyboard
  in use, and every system package without a launcher icon, which covers Carrier Services, Play
  services and the other parts calls and RCS need), and any package that shares its uid with
  another: Android restricts by uid, so it would cut off the others too (Q8). Each one the policy
  names is reported as a problem, in the parent's words ("… can't be Wi-Fi only: it's the texting
  app, and texting 988 always works.").
- **When to call Android:** when the wanted list differs from what Android has
  (`getMeteredDataDisabledPackages`), or when an app on it was installed again under a new uid
  since the last call (Android resolved its uid then, Q2). Belay keeps each restricted package's
  uid to tell. A package Android refused is remembered and not asked for again until something
  changes, so a refusal doesn't become a call at every step.
- **When:** at every agent step (installs and removals, boots, policy changes and the hourly
  check all run one). Idempotent: a second step with nothing new calls nothing.
- **The report:** `enforcement.mobile_data.wifi_only`, the packages Android restricts for Belay
  now; null while the policy lists none and Android has none.

**Mobile data use (only while `measure` is on).** `mobiledata/DataUseReader.kt` (`:app`) asks
`NetworkStatsManager` for each local day it needs: `querySummary(TYPE_MOBILE)` for the apps (rx
plus tx bytes, all states and tags), and `querySummaryForDevice(TYPE_WIFI)` for the Wi-Fi total.
It names each uid: one package, several (a shared uid), Android's own (uids under 10000, and other
users'), removed apps, the phone's hotspot; an SDK sandbox uid counts as its app. `core`'s
`DataUse.fold` turns that into a day:

- Each app with its bytes, most first, at most 500. Never the never-blocked apps (the phone app,
  texting, the keyboard…) one by one: their bytes go with Android's own and shared uids into one
  line, "Android, calls and texting", so the total stays right and a call or text to 988 never
  shows. Removed apps and the hotspot are lines of their own.
- `mobile_bytes` is the sum of all of it; anything past the 500 apps is the difference.
- A day runs in the phone's own zone, midnight to midnight. It counts only from when measuring
  turned on (the first day says from when): Android keeps 90 days of history, and none of it from
  before the kid was told is sent.

`core`'s `DataUseUploads` decides what to read and send: today every hour or so (Android's numbers
move every 30 minutes anyway), each past day once more when it's complete (2.5 hours after its
end, once Android's last 2-hour bucket for it has closed and been polled), at most 7 days back.
Each day waits in an outbox lane of its own (`mobile_data`), a newer report of a day replacing an
unsent one, and goes to `POST /api/v1/mobile-data`. With `measure` off, Belay deletes its record
and its unsent days. Reading the stats is a few queries an hour: no new wakeups, no permission.

**Room, schema 8:** one new table, `mobile_data` (one row: core's `MobileDataState` as JSON: the
Wi-Fi-only list as applied, with uids and refusals, the report, and the uploads' state). Room
migrates 7 to 8 by itself (a new table only), and an instrumented test opens a version 7 database
made from the exported schema with Room at version 8.

### On the server

- **Tables** (migration 015): `mobile_data_settings` (measuring, a parent's alone, with what was
  dropped while off), `wifi_only_apps` (device, package, who added it, and when),
  `mobile_data_days` and `mobile_data_apps` (what the phone sent). `proposals` gains the kind
  `mobile_data`.
- **Policy build:** `mobile_data: {wifi_only, measure}`, always sent.
- **Tighten or loosen:** one tested function, `classifyWifiOnlyChange(before, after)`: adding an
  app tightens, removing one loosens; a mix is a proposal, as for screen time. An AI app may add
  an app the phone has reported (installed now or before); a parent may add any package. The
  server refuses, for everyone, the packages it never blocks (`NEVER_BLOCKED` and the phone's own
  `never_blocked`), at most 100 a phone.
- **Collection is a parent decision:** turning `measure` on or off is never an AI action, in
  either direction, nor a proposal.
- **Kept:** a day only while measuring is on (otherwise dropped and counted); never a
  never-blocked app's line (folded into "Android, calls and texting" if a phone sends one); 90
  days by default (`mobileDataDays`, 1 to 400), deleted by the hourly clean-up. "Stop collecting"
  (Phase 11) gains the category.
- Every change and every AI read goes through `audit()`.

### MCP

| Tool | What it does |
|---|---|
| `get_mobile_data(device, from?, to?)` | Per day in the phone's days: the mobile total, the Wi-Fi total, the top apps on mobile data, "Android, calls and texting", removed apps and the hotspot, and totals for the period; the Wi-Fi-only apps, with any that still used mobile data after they were added. Days not sent are unknown, not zero. Scope `mobile_data`; the apps' names need the Apps scope. |
| `change_wifi_only(device, change: {add?, remove?}, reason)` | **Write.** Adding apps only tightens, so it applies at once; anything that removes one becomes a proposal for the parent page. Refuses the apps the phone never blocks, and apps the phone never reported. |

`get_policy` says how many apps are Wi-Fi only (and which, with the Apps scope). `weekly_review`
gains a short part about mobile data only while the `mobile_data` scope is on: the week's total,
the top apps, the change from the week before, and Wi-Fi only as a suggestion. `family_check_in`
gains one line, only while it's on: what's Wi-Fi only, and whether something could come off it
(rules are built to loosen).

### On the parent page

A phone's **Mobile data** tab, always there (Wi-Fi only works without measuring):

- **Wi-Fi only:** the apps on it, each with what the phone says (on the phone; not installed, so
  it applies when it is; waiting for the phone), who added it and when, and "Let it use mobile
  data again"; an Add form with the phone's apps that can be. What it covers and what it doesn't,
  in a line: downloads through Android's download manager and app updates through Play.
- **Measuring:** the switch (a parent's alone), how long it's kept, and whether AI apps may read it.
- **The days:** the last 30 as bars (server-rendered, no JavaScript), with a table of the same
  numbers beside them: mobile data, Wi-Fi, and the top app. A chosen day's apps, as bars with
  their table, each app with "Make it Wi-Fi only". A Wi-Fi-only app that used mobile data on a
  day that started after it was added is flagged.

### On the kid's phone

- **This phone's rules** gains "Some apps work only on Wi-Fi", listing them, with what it means.
- A **Wi-Fi only** card on the rules screen: each app with "Wi-Fi only: your parent chose this".
  Only what Android restricts for Belay now: a package on the policy that isn't installed, or that
  Belay can't restrict, isn't listed.
- **What your parent can see** gains "How much mobile data apps use" while measuring is on.
- Off belay's "Belay blocks nothing now" waits until no app is Wi-Fi only.

## Protocol

Additive to [docs/protocol.md](../protocol.md); `core/Protocol.kt` (with `core/mobiledata/
MobileDataProtocol.kt`) and `server/src/device/schemas.ts` change with it.

### Policy addition

| Field | Type | |
|---|---|---|
| `mobile_data` | `{wifi_only: string[], measure: bool}` | always sent; default `{wifi_only: [], measure: false}`. `wifi_only`: at most 100 package names, sorted; `measure`: send `POST /mobile-data` |

### Enforcement addition (in Device)

| Field | Type | |
|---|---|---|
| `mobile_data` | `{wifi_only: string[]}`? | the packages Android keeps off mobile data for Belay now (at most 100); null while the policy lists none and Android has none |

### `POST /api/v1/mobile-data`

256 KB, at most 31 days.

```json
{ "days": [ { "day": "2026-11-17", "zone": "America/Los_Angeles", "from": 1794808800000,
              "as_of": 1794867161711, "complete": false,
              "mobile_bytes": 412000000, "wifi_bytes": 2100000000,
              "apps": [ { "package": "com.example.video", "bytes": 350000000 } ],
              "android_bytes": 52000000, "removed_bytes": 0, "hotspot_bytes": 0 } ] }
```
→ `200 {"server_time", "accepted"}`.

**MobileDataDay**

| Field | Type | |
|---|---|---|
| `day` | `"YYYY-MM-DD"` | in `zone` |
| `zone` | string | IANA: the phone's own |
| `from` | int | counted from: the day's start, or when measuring turned on that day |
| `as_of` | int | counted up to: when the phone read it, or the day's end once complete |
| `complete` | bool | the day is over, and Android's last bucket of it closed |
| `mobile_bytes` | int | everything on mobile data that day (every line below, and what's past 500 apps) |
| `wifi_bytes` | int | everything on Wi-Fi that day, one number |
| `apps` | `[{package, bytes}]` | at most 500, most first; never the never-blocked apps |
| `android_bytes` | int | Android's own parts, shared uids and the never-blocked apps, together |
| `removed_bytes` | int | apps removed since (Android keeps their use as removed apps) |
| `hotspot_bytes` | int | what devices used through this phone's hotspot |

Bytes are 0 to 10^14. Idempotent by `day`: a day sent again replaces the stored one, apps and all.
The server keeps a day only while the phone's `measure` is on (otherwise it's answered `200`,
counted in `accepted`, dropped and counted for the parent page), never a never-blocked app's own
line (it adds the bytes to `android_bytes`), and not a day that isn't a real date, is after
tomorrow in its zone, or is older than the family keeps.

## Privacy and transparency

**New `DataCategory`:**

| id | Title (kid-facing) | Details |
|---|---|---|
| `mobile_data` | How much mobile data apps use | "How much mobile data each app uses each day, like 120 MB"; "How much the phone uses on Wi-Fi each day, all apps together"; "The phone app, your texting app and Android's own parts together, not one by one, and what devices use through this phone's hotspot"; "Not which websites, which Wi-Fi networks, or anything you send or get" |

**AI scope** `mobile_data`, **on by default**, like `screen_time`: it's the same kind of data (how
much each app is used, no content) with less in it than screen time (no hours of the day, no
opens or unlocks), and far less than `network` (which names the services the kid uses, so it starts
off). Its point is the AI's own job here: finding the apps that use the cap and suggesting Wi-Fi
only, which it can then apply. A family that turned any category off gets it off (settings.ts),
and measuring itself starts off for every phone. **privacy.md** gains its line and the retention.

**Wi-Fi only** collects nothing; it's a rule, so it's on the kid's rules screen, not under "What
your parent can see". The report says which apps Android restricts, which the parent set anyway.

**Kid-facing words** (`strings.xml`):

- "Some apps work only on Wi-Fi" · "Your parent chose apps that can't use mobile data: %1$s. On
  Wi-Fi they work as usual, but on some Wi-Fi, like another phone's hotspot, they may not work
  either. Calls and texts always work, and so do 911 and 988."
- "Wi-Fi only" · "These apps can't use mobile data. When the phone is on mobile data, they act like
  there's no internet." · "Wi-Fi only: your parent chose this"

## Threat model changes

| What the kid could do | With Phase 13 |
|---|---|
| Turn the app's switches on in Settings | "Background data" and "Unrestricted data usage" show "Disabled by admin"; neither would lift it (Q4, Q5). |
| Reset app preferences, or network settings | Neither touches the admin's restriction (Q5). |
| Mark a Wi-Fi network "Treat as unmetered" | The kid can, for any Wi-Fi, a parent's hotspot included: Wi-Fi-only apps then use it, and the hotspot's data. Belay can't see it (it would need the network's name, which needs location). The parent's own phone shows its hotspot's use; `DISALLOW_CONFIG_WIFI` would stop it, but also stop joining any new Wi-Fi, so it isn't used. |
| Use a hotspot Android doesn't know is metered | An iPhone's hotspot may not say so (Q3): Wi-Fi-only apps then work on it. For the Pixel checklist. |
| Share the phone's own mobile data through its hotspot | Not stopped (no tethering lock is set); the report shows the hotspot's bytes on their own line. |
| Download through Android's download manager | A Wi-Fi-only app's download handed to the download manager may still use mobile data (Q9); the report shows it under the app, and the parent page flags it. |
| Get updates over mobile data | Updates come through Play, not the app: Wi-Fi only doesn't cover them. Make Play Wi-Fi only too, or use Play's own download setting. |
| Watch videos inside another app | Counts as that app's traffic: that app's rule applies. |
| A VPN | Locked by Phase 2's `config_vpn`. |
| Ask the parent's AI to lift it | AI apps can only propose it; a parent approves on the parent page. |
| Name an app to steer the AI | App labels and package names stay `untrusted`. |

Other people: the AI provider sees mobile data use only while the `mobile_data` scope is on and a
parent measures.

## Test plan

**JVM (`:core`)**
- `WifiOnly`: which packages are restricted (installed, not hidden, not never-blocked, no shared
  uid); every never-blocked kind refused with its words; when to call Android (a change, Android's
  list differing, a new uid after a reinstall) and when not (nothing new, a refusal remembered);
  the report.
- `DataUse.fold`: apps sorted and capped at 500, never-blocked apps and shared uids into
  "Android, calls and texting", removed apps and the hotspot apart, the total; `DataUseUploads`:
  only since measuring turned on, today hourly, a day once more when complete (and not before
  2.5 hours after its end), at most 7 days back, nothing while off.
- The kid's words: `KidRules` lists Wi-Fi only only while Android restricts an app; the data
  category only while measuring; Off belay waits for an empty list; protocol round trips, and an
  older policy without `mobile_data` still parsing.

**Server (Vitest)**
- `POST /mobile-data`: the schema (strict fields, limits), replace by day, kept only while
  measuring, never-blocked lines folded, retention, too-new days.
- `classifyWifiOnlyChange` both ways and mixed; `change_wifi_only` applies a tightening and turns
  a removal into a proposal; approving it applies it, and an out-of-date one changes nothing.
- The AI scope off hides `get_mobile_data`; the prompts mention mobile data only while it's on.
- Retention in the hourly clean-up; Stop collecting deletes the days; the pages render (a table
  for each chart); the CLI.
- Migration 015 keeps every proposal, and the `proposals` check takes every kind the code has.

**Instrumented (emulator)**
- Room 7 to 8: a version 7 database made from the exported schema, with a row in it, opens with
  Room at version 8; the row is still there and the new table works.

**CI end to end** (`ci-emulator-test.sh`, with the server)
- `wifi-only <phone> <fixture>`: the phone reports the fixture in `enforcement.mobile_data`, its
  debug state shows Android's list, and `dumpsys device_policy` prints it under Belay's admin.
- `wifi-only --remove`: all three are empty again.
- `mobile-data --measure on`: the server gets a day (bytes may be 0 on an emulator); `--measure
  off`: the phone keeps nothing unsent.
- Only the Pixel can show an app actually losing mobile data, a hotspot, Wi-Fi marked metered,
  and real byte counts: [phase13-checklist.md](../phase13-checklist.md).

## Decisions the family must make

1. **Which apps are Wi-Fi only.** Recommended: measure for a week or two, then make the top few
   video, game and social apps Wi-Fi only. Don't add Maps (a kid who's lost needs it).
2. **The browser.** 988's chat on the web needs data; calling and texting 988 always work.
   Recommended: leave the browser off the list.
3. **Play.** Recommended: make Play (`com.android.vending`) Wi-Fi only too if updates eat the cap,
   or set Play's own "App download preference" to Wi-Fi only.
4. **Measuring.** Off by default. Recommended: on for the first weeks, to see where the data goes.
5. **What AI apps may read.** Recommended: on (the default), as for screen time.
6. **How long to keep it.** Recommended: 90 days (the default): three billing cycles.
7. **The phone's own hotspot.** Not locked by Belay; recommended: talk about it, and watch the
   hotspot line.

## Open questions

- Does an iPhone's hotspot say it's metered (DHCP's `ANDROID_METERED`)? If not, Wi-Fi-only apps
  use it. On the Pixel.
- Does a Wi-Fi-only app's download through the download manager really use mobile data (Q9)? On
  the Pixel, with a test app.
- Should the kid be able to ask for mobile data for one app (a request kind), and should Belay post
  a notice when a Wi-Fi-only app is opened on mobile data? Not built: "Talk to my parent" covers
  the first for now.
- Totals per billing cycle (a plan day the family sets) instead of the last 7 and 30 days.
- 5G networks a carrier marks temporarily unmetered still count as metered to Android's rules, so
  Wi-Fi-only apps stay off them; is that what families want?
- A tethering lock (`DISALLOW_CONFIG_TETHERING`) as one of the locked settings.
