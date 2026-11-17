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
- No CORS: these endpoints are for the agent, not for browsers.

| Endpoint | Body limit |
|---|---|
| `POST /api/v1/enroll` | 16 KB |
| `POST /api/v1/checkin` | 32 KB |
| `POST /api/v1/inventory` | 4 MB, at most 5000 packages |
| `POST /api/v1/events` | 512 KB, at most 1000 events |

Errors: `{"error": "<code>", "error_description": "<words>"}` with

| Status | `error` | Agent does |
|---|---|---|
| 400 | `invalid_request` | drops the request (a bug: it would fail again) and logs it |
| 400 | `invalid_code` | (enroll) tells the person the code is wrong, used or expired |
| 401 | `invalid_token` | stops syncing: the parent revoked this phone; shows "disconnected" |
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

`policy` is empty in Phase 1; Phase 2 uses the same call.

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

The server diffs the snapshot against what it knows and records any change no event
reported ("found by snapshot"). A change the phone reports later is matched to it, not
recorded twice.

## `POST /api/v1/events`

Sent as soon as a change is found, from the agent's outbox.

```json
{ "events": [ { …Event… } ] }
```
→ `200`
```json
{ "server_time": 1794867161711, "accepted": 1, "duplicates": 0 }
```

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

**Package**

| Field | Type | |
|---|---|---|
| `package` | string | |
| `label` | string | untrusted, at most 200 characters |
| `version_name` | string? | untrusted |
| `version_code` | int | |
| `first_install_time`, `last_update_time` | int | |
| `system`, `updated_system`, `enabled`, `launchable` | bool | |
| `target_sdk`, `category` | int | `category` is `ApplicationInfo.category` (-1: none) |
| `source` | `play_store` `other_store` `other_app` `sideloaded` `adb` `preinstalled` `unknown` | |
| `installer` | `{installing?, initiating?, originating?, update_owner?, package_source?}` | raw `InstallSourceInfo` |
| `permissions` | string[] | sensitive permissions it holds, from: `camera` `microphone` `location` `contacts` `sms` `call_log` `photos_media` `nearby_devices` `notification_access` `accessibility` `device_admin` |

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

**Health**

| Field | Type |
|---|---|
| `device_owner`, `battery_exempt`, `usage_access`, `notifications_shown`, `background_restricted`, `service_running`, `test_only` | bool |
| `uninstall_blocked` | bool? (null when not device owner) |
| `standby_bucket` | int (5 = exempted) |
| `permissions` | `[{name, granted, fixed_by_policy}]`, Belay's own runtime permissions |
