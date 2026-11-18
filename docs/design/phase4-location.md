# Phase 4: location

**Status: design.** Nothing here is built. Android facts cite
[platform-notes-drafts.md](platform-notes-drafts.md) by id.

## Goals

1. **On demand:** a parent asks "where is the phone?" and gets a fresh fix in about a minute.
2. **Periodic,** if the family chooses: a fix every 15 to 120 minutes, optionally only within set
   hours.
3. **Places:** "arrived at school", "left school", for places the parents name.
4. **Lost phone:** find it, lock it, and show a message on the lock screen.
5. **The kid always knows:** what mode is on, which places exist, and every time a parent checked.
6. **AI access off by default.**

Not goals: a movement history or "trail" by default; reverse geocoding (the server never calls a
third-party API); location of anyone but this phone.

## What Android 17 allows

| Need | What Android 17 offers | Notes |
|---|---|---|
| Permission | An adb-provisioned device owner may grant itself fine, coarse and background location by policy (L1) | The kid can't revoke it in Settings. Android tells the kid: "Belay has location access" / "Your organization allows Belay to access your location" (L1). |
| Keep location on | `setLocationEnabled` and `DISALLOW_CONFIG_LOCATION` (L2) | The kid can't turn location off; Belay still can. |
| Providers | `LocationManager` with `"gps"`, `"network"`, `"fused"` (L3) | Platform API only, no Play services code. But on a Pixel, "network" and "fused" are (expected to be) served by Google Play services, under Google's location settings. `"gps"` is the phone's own satellite receiver. |
| One fix now | `getCurrentLocation(provider, LocationRequest, …)` | A fix no older than 30 s, or a fresh one (L3). |
| Geofences | `addProximityAlert` | Uses the fused provider (L4). Belay computes places itself instead. |
| Background | Background location by policy, plus Belay's existing `systemExempted` service | No `location` foreground service needed, and no background throttling (L5). |
| What the kid sees | Status bar location icon for GPS-level requests (L6) | Plus Android's permission notice (L1) and Belay's own notices below. |

## Design

### Modes

| Mode | What the phone does |
|---|---|
| `off` (default) | Nothing. Location permissions are denied by policy, so Settings shows Belay without location access. |
| `on_demand` | A fix only when a parent asks (a `locate_now` command), or in lost mode. |
| `periodic` | On demand, plus a fix every `every_minutes` (15 to 120) within `hours`, plus place events. |

Places need fixes, so they only work in `periodic`. The kid sees the mode, the interval, the
hours and the place names.

### On the phone

- **Permissions by policy, not by manifest.** Today `DeviceOwnerSetup.ensure` grants every runtime
  permission Belay declares except CAMERA (L1). Phase 4 declares `ACCESS_FINE_LOCATION`,
  `ACCESS_COARSE_LOCATION` and `ACCESS_BACKGROUND_LOCATION`, and changes the rule: a permission
  tied to a data category is granted only while the policy turns that category on, and denied by
  policy otherwise. The same rule covers Phase 5's call and text permissions. When location turns
  off, Belay denies it by policy at once.
- **`LocationCollector`** takes single fixes, never a continuous stream: `getCurrentLocation` with
  the policy's provider and a 60-second timeout. `provider: "gps"` (default) uses only the
  satellite receiver: private, slower indoors, more battery per fix. `provider: "fused"` uses
  Android's combined provider (Google's on a Pixel): faster and works indoors, but Google's
  service handles the request. If a GPS fix times out, Belay reports "no fix" with the reason; it
  falls back to "fused" only if the family allowed it (`fallback_fused`).
- **Periodic:** an exact alarm at each interval (S6), within `hours`. For places, the next fix
  comes sooner near a place's edge: the interval is the distance to the nearest edge at an
  assumed 30 m/s, between 5 minutes and `every_minutes`.
- **`Places.evaluate` (`:core`, pure):** arrival when a fix is inside `radius − accuracy` on two
  fixes in a row; departure when a fix is outside `radius + accuracy` on two fixes in a row;
  fixes with an accuracy worse than the radius decide nothing. Hysteresis stops a phone at the
  edge of school from flapping.
- **Mock locations:** a fix with `isMock()` is reported as such and never counts toward places.
  Mock providers need developer options, which Phase 2 locks.
- **Kid notices (Belay's own):** each on-demand fix posts "Your parent checked where this phone is
  (8:15 pm)". Periodic mode shows in the managed notice's text ("Shares location every 30 minutes,
  7 am to 9 pm"). A place event shows nothing extra but is listed on Belay's screen.
- **Keep location on:** with `keep_on`, Belay calls `setLocationEnabled(true)` and sets
  `DISALLOW_CONFIG_LOCATION` (L2); without it, the kid may turn location off and the parent page
  says so.
- **Lost mode:** `lost: {since, message}` sets the lock screen text (`setDeviceOwnerLockScreenInfo`,
  the parent's message: "This phone is lost. Please call 555-0100"), keeps location on, takes a
  fix every 5 minutes, and locks the screen once. It works in any mode, `off` included: Belay grants
  itself location for it and denies it again when lost mode ends, which restores everything else
  too.
- **Battery:** single fixes, no stream, nothing while the mode is `off`. The cost per GPS fix on a
  Pixel 8 is unmeasured; the Pixel checklist records the battery over a day in each mode.

### On the server

- **Tables:** `locations` (device, id, at, lat, lng, accuracy, provider, reason, mock),
  `places` (per phone), `place_events`.
- **Kept:** periodic fixes 7 days, on-demand fixes 30 days, place events 90 days, then deleted
  (settings). Lost-mode fixes until lost mode ends plus 7 days.
- **`locate_now`:** the server adds a command; the phone's long-poll (Phase 2) delivers it in
  seconds; the request waits up to 60 s for the fix. A check's answer is its own, or that of a
  check that took its place in its 2 minutes (the phone runs only the newest), never a later
  one's: the eighth security review's K6 found a parent's old check shown another's failure.
- **Describing a fix** without any third-party service: relative to the family's places ("At
  School, within 40 m"; "1.2 km from Home"), computed on the server. An "Open in a map" link puts
  the coordinates in a URL for a map site the family picks (OpenStreetMap or Google Maps); only
  the parent's browser follows it, when the parent clicks.
- **Notifications:** place events can notify parents (Phase 2's push), per place and direction.

### MCP

| Tool | What it does |
|---|---|
| `get_location(device)` | The latest fix: when, accuracy, which place it's in or nearest to, and coordinates. Scope `location`, **off by default**. |
| `locate_now(device)` | Asks the phone for a fresh fix and waits up to 60 s. Only in `on_demand` or `periodic` mode, and only with the `location` scope on. The kid gets the same notice as for a parent's check, naming the AI app ("Your parent checked, using Claude"). |
| `get_place_events(device, from?, to?)` | Arrivals and departures. Scope `location`. |

No tool changes the mode, the places, `keep_on` or lost mode: those are collection decisions, made
by a parent on the parent page (Phase 3's rule).

### On the parent page

- A phone's **Location** tab: the mode, interval and hours; `keep_on`; the provider, with what each
  means; the last fix described by places, with its age and accuracy; "Check now"; the list of
  checks (the same list the kid sees).
- **Places:** name, center and radius (50 to 1000 m). The center comes from pasted coordinates or
  "Use where the phone is now". No address search, since that would need a third-party service.
- **Lost mode:** "This phone is lost", with the lock-screen message and a phone number to show.

### On the kid's phone

- **Location** card: the mode in plain words, the interval and hours, the names of the places,
  whether location is locked on.
- **Checks:** every time a parent or their AI app checked, for the last 30 days, with the time.
  This list comes from the phone's own record of the commands it ran, so it can't leave a check
  out.
- "What your parent can see" gains the location entry while location is on.

## Protocol

### Policy additions

| Field | Type | |
|---|---|---|
| `location` | Location? | null or `mode: "off"`: no location at all |

**Location**

| Field | Type | |
|---|---|---|
| `mode` | `"off"` \| `"on_demand"` \| `"periodic"` | |
| `every_minutes` | int? | periodic: 15 to 120 |
| `hours` | `{start: "HH:MM", end: "HH:MM"}`? | periodic fixes only within these hours |
| `provider` | `"gps"` \| `"fused"` | default `"gps"` |
| `fallback_fused` | bool | use `"fused"` when GPS times out |
| `places` | Place[] | at most 20 |
| `keep_on` | bool | the kid can't turn location off |
| `lost` | `{since, message}`? | lost mode; `message` at most 120 characters, shown on the lock screen |

**Place**: `{id, name, lat, lng, radius_m, notify: ("arrive" | "leave")[]}`; `name` is the
family's words, at most 40 characters, shown to the kid.

**Command** gains `kind: "locate_now"`.

### Enforcement additions

`location: {permission: bool, location_on: bool, last_fix_at?, problem?}`: whether Belay holds
the permission, whether location is on, and Belay's own words for what failed ("No GPS fix in 60
seconds").

### `POST /api/v1/locations`

64 KB, at most 200 fixes and 200 events.

```json
{ "fixes": [ { …Fix… } ], "place_events": [ { …PlaceEvent… } ] }
```
→ `200 {"server_time", "accepted"}`. Idempotent by each item's `id`.

**Fix**

| Field | Type | |
|---|---|---|
| `id` | string | UUID made on the phone |
| `at` | int | the fix's own time |
| `lat`, `lng` | number | 5 decimal places (about 1 m) |
| `accuracy_m` | int | |
| `provider` | `"gps"` \| `"fused"` | the provider that answered |
| `reason` | `"on_demand"` \| `"periodic"` \| `"place"` \| `"lost"` | |
| `command_id` | string? | the `locate_now` it answers |
| `mock` | bool | from `Location.isMock()` |

**PlaceEvent**: `{id, place_id, kind: "arrived" | "left", at, fix_id}`.

A failed `locate_now` is reported in `enforcement.commands` with its problem.

## Privacy and transparency

**`DataCategory`**

| id | Title | Details (depend on the mode) |
|---|---|---|
| `location` | Where this phone is | "When your parent checks where the phone is. You get a notification every time." · "Every %1$d minutes, between %2$s and %3$s." · "When you arrive at or leave: %1$s." (the place names) |

**AI scope** `location`: **off by default**. While off, AI clients see that a phone has location on,
never a fix or a place event.

**Kid-facing words** (drafts):

- "Your parent checked where this phone is (%1$s)." · "…using %2$s." for an AI app
- "Belay shares where this phone is every %1$d minutes, between %2$s and %3$s."
- "Your parent named these places: %1$s. Belay tells your parent when you arrive or leave."
- "Location is locked on. Your parent decides this."
- "When Android says \"your organization allows Belay to access your location\", it means your
  parent, through Belay."
- Lost mode: "This phone is in lost mode. Your parent can see where it is every 5 minutes until
  they turn lost mode off."

**privacy.md** gains the location entry, the retention times, and that coordinates are never sent
anywhere but the family's server.

## Threat model changes

| Who, what | With Phase 4 |
|---|---|
| The kid turns location off | Blocked with `keep_on`; otherwise reported. |
| The kid fakes the location | Mock locations need developer options (locked by Phase 2), and mock fixes are marked and never count for places. |
| Airplane mode, or the phone off | No fixes; silence is reported as in every phase. |
| The kid leaves the phone somewhere | Out of scope: Belay locates the phone, not the kid. The kid-facing words say "where this phone is". |
| Someone with a parent's account tracks the kid | Every check is in the activity log and on the kid's phone. |
| The AI provider | Sees nothing while the scope is off (default). |
| A stalker installs Belay on someone's phone | Belay needs adb setup and a factory-fresh phone, always shows its notice, and declares itself a monitoring tool (M1); its screen and Android's notices say location is shared. |
| A family member's Google settings | With `provider: "fused"`, Google's own location service sees the requests; with `"gps"` (default), only the satellite receiver is used. |

## Test plan

**JVM (`:core`)**
- `Places.evaluate`: arrival and departure with hysteresis, jitter at the edge, poor accuracy
  deciding nothing, mock fixes ignored, overlapping places, two fixes needed.
- The adaptive interval: distance to the nearest edge, clamped to 5 minutes and `every_minutes`.
- The permission rule: location granted only while the mode isn't `off`, for every mode change.
- Protocol round trips.

**Server (Vitest)**
- `POST /locations` idempotency, limits, rounding; retention deletes on time.
- `locate_now` waits for the matching fix, times out cleanly; scope off hides everything.
- Place descriptions: inside, nearest, distances.

**Instrumented (emulator)**
- Policy on: the grant state of the three permissions is GRANTED and fixed; off: DENIED.
- `getCurrentLocation("gps")` returns the point set with `adb emu geo fix`.
- `keep_on`: `setLocationEnabled` holds and the restriction is set.

**CI end to end**
- The server's CLI sets `periodic` with a place around a test point; `adb emu geo fix` moves the
  emulator in and out; the server records "arrived" then "left".
- `locate_now` from the CLI: the server gets a fix answering that command within 60 s, and the
  phone's check list has it.

## Decisions the family must make

1. The mode: off, on demand, or periodic, and the interval and hours.
2. The places, and which arrivals and departures notify a parent.
3. Whether location is locked on.
4. GPS only (private, slower indoors) or Android's combined provider (Google's on a Pixel).
5. How long to keep fixes and place events.
6. Whether AI clients may read location (off by default), and whether they may ask for a fresh fix.
7. Lost mode's message and the number it shows.

## Open questions

- Which packages serve "network" and "fused" on the Pixel's Android 17 (`dumpsys location`), and
  does a "gps" request there use any network assistance that reaches Google?
- Battery per GPS fix on the Pixel 8, indoors and outdoors; how often a GPS fix times out indoors.
- Does the status bar icon appear for Belay's GPS requests on the Pixel (L6)?
- Is two-fix hysteresis enough at a school with a 100 m radius, or does it need a dwell time?
- Should the kid be able to share a location themselves, even when the mode is off (the "I need
  help" button, Phase 7)? Proposed: yes, only when the kid taps it.
