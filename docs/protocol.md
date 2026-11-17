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
| `POST /api/v1/checkin` | 32 KB |
| `POST /api/v1/inventory` | 4 MB, at most 5000 packages |
| `POST /api/v1/events` | 512 KB, at most 1000 events |
| `GET /api/v1/policy` | (no body) |
| `POST /api/v1/requests` | 128 KB, at most 100 requests |

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
  phone as `allowed`, so nothing the kid already has stops working by surprise.
- **Blocked** apps are hidden and suspended (`setApplicationHidden`: suspended apps that
  have run before can keep working in the background). System apps can be blocked too.
- **Paused**: every launchable app but the never-blocked ones is suspended until
  `pause.until` or until a parent resumes it.
- **`factory_reset` and `debugging`** can lock a phone for good. The server only sets them
  when a parent turns them on, with a warning, on the parent page; AI clients can't.
  Debug builds of Belay never apply them. `maintenance_until` lifts `debugging` so adb
  works for repairs.
- **Offline**, the phone keeps enforcing the last policy it got. Belay stores it.
- **Tightening vs. loosening:** an AI client may tighten directly (block an app, pause
  the phone). Anything that loosens (approve, unblock, resume, lift a restriction) is
  only a proposal until a parent approves it on the parent page.

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
| `permissions` | string[] | sensitive permissions it holds, from: `camera` `microphone` `location` `contacts` `sms` `call_log` `photos_media` `nearby_devices` `notification_access` `accessibility` `device_admin` |

**Policy** (server → phone; every field has a default that enforces nothing)

| Field | Type | |
|---|---|---|
| `version` | int | increases with every change, per phone |
| `issued_at` | int | |
| `apps` | `{new_apps: "allow"\|"ask", decisions: [{package, state: "allowed"\|"blocked"}]}` | |
| `pause` | `{until?, note?}`? | null: not paused; `until` null: until a parent resumes |
| `restrictions` | `{safe_boot, add_user, unknown_sources, config_vpn, config_private_dns, config_date_time, config_default_apps, modify_accounts, sim, factory_reset, debugging}`, all bool | true: the kid can't (see the rules above for the last two) |
| `web` | `{private_dns?, chrome?, hide_browsers}` | `private_dns`: a host like `family-filter-dns.cleanbrowsing.org`; `chrome`: `{incognito, safe_search, youtube_restrict: "off"\|"moderate"\|"strict", safe_sites, allow_downloads, url_allowlist?, url_blocklist}` |
| `maintenance_until` | int? | adb works until then |
| `frp_accounts` | string[] | Google account ids for factory reset protection |
| `support_message` | string? | the parent's words for blocked-app screens |
| `requests` | `[{id, status: "pending"\|"approved"\|"declined"\|"talk", note?, answered_at?, answered_by?}]` | the kid's requests of the last 30 days |

**Request** (phone → server)

| Field | Type | |
|---|---|---|
| `id` | string | UUID made on the phone |
| `kind` | `app` | |
| `package` | string | |
| `label` | string | untrusted |
| `reason` | string? | the kid's own words, at most 500 characters: untrusted |
| `asked_at` | int | |

**Enforcement** (in Device, from Phase 2)

| Field | Type | |
|---|---|---|
| `policy_version` | int | the version applied |
| `applied_at` | int? | |
| `suspended_count` | int | apps held suspended or hidden now |
| `problems` | string[] | Belay's own words for what it couldn't do, at most 20 of 200 characters |

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

**Health**

| Field | Type |
|---|---|
| `device_owner`, `battery_exempt`, `usage_access`, `notifications_shown`, `background_restricted`, `service_running`, `test_only` | bool |
| `uninstall_blocked` | bool? (null when not device owner) |
| `standby_bucket` | int (5 = exempted) |
| `permissions` | `[{name, granted, fixed_by_policy}]`, Belay's own runtime permissions |
