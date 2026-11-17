# Roadmap

Each phase stops with a short report: what works, what was verified on which Android
version, and what's still unproven. Verified platform facts live in
[docs/platform-notes.md](docs/platform-notes.md).

## Phase 0: prove the real-phone path

Built: the device-owner agent (adb provisioning, the managed notice, the installed-app
inventory and change detection, kept on the phone), `provision.sh` / `unprovision.sh`,
the platform notes, and CI that provisions it on the Android 17 emulator. Verified on the
Android 17 emulator (two images).

**Still open:** [docs/phase0-checklist.md](docs/phase0-checklist.md) on the Pixel 8. If an
adb-provisioned device owner is blocked on the real phone, the plan changes.

## Phase 1: foundation and monitoring, no blocking (built)

Built as described below, and checked end to end on the Android 17 emulator against a
real server in CI. **Still open:** [docs/phase1-checklist.md](docs/phase1-checklist.md) on
the Pixel 8, over cellular, with Claude.

The plumbing and the AI interface. **Not safe to hand to a kid:** they could still reset
the phone from Settings, install anything, or browse anything.

**Agent**
- Inventory per package: label, versions, install and update times, source, system or
  user app, enabled, launcher icon, targetSdk, category, and the sensitive permissions it
  holds (camera, microphone, location, contacts, SMS, call log, photos and media, nearby
  devices, notification access, accessibility, device admin).
- Device facts: model, Android version, security patch, agent version; still device
  owner, uninstall blocked, battery exemption, usage access; battery, storage, last boot,
  boot count, timezone, clock skew against the server. No location, no content.
- Change detection as in Phase 0, with the events written to an outbox (Room) and sent
  right away; the last snapshot in Room; settings in DataStore.
- Sync with OkHttp and kotlinx.serialization: retries and backoff from the service,
  WorkManager as the backstop; check-in every 2 hours, full inventory daily; every call
  idempotent.
- Enrollment: scan the server's QR code (ZXing), type it, or receive it from
  `provision.sh --server --code` (through a receiver only the adb shell can reach, the
  pattern kidctl uses).
- The device token encrypted with an AES key in Android Keystore.
- Instrumented test: a tiny fixture APK installed, updated and removed gives those three events.

**Server** (`/server`): Node 24, TypeScript (strict), Hono, SQLite (WAL) with versioned
migrations, Zod on every input, Vitest; server-rendered Hono JSX pages, no SPA or external
CDNs. One Docker image, non-root, all state in `/data`; `docker-compose.yml` with a Caddy
example. One family per server.
- Device API (`/api/v1`): `enroll`, `checkin`, `inventory` (diffed against the previous
  snapshot to backfill missed events), `events`; size limits, unknown fields rejected, no CORS.
- Parent login (argon2id, sessions, CSRF, rate limits, sign out everywhere); pages for
  devices, a device's apps, the timeline, adding a phone, settings, and the activity log.
- MCP at `/mcp` (Streamable HTTP, official SDK) behind OAuth 2.1: RFC 9728 and 8414
  metadata, PKCE S256, Client ID Metadata Documents with DCR as the fallback, allowlisted
  redirects, resource-bound tokens; personal access tokens for Claude Code. Tools:
  `list_devices`, `get_device_status`, `get_installed_apps`, `get_app_changes`,
  `list_unreviewed_apps`, `mark_apps_reviewed` (the only write). Prompts: `weekly_review`,
  `review_app`. AI data scopes per category.

**Docs:** server, MCP, privacy, threat model; emulator and Pixel docs updated.

## Phase 2: safe to hand over

- **Apps:** each new app is suspended the moment it installs ("Waiting for your parent"),
  and the kid can say why they want it. The parent is notified (Web Push or ntfy), can ask
  the AI for a review, and approves on the parent page. Every request gets an answer the
  kid sees (approved, declined, or "let's talk") with the parent's note. Hard blocks use
  `setApplicationHidden`. There is no pre-install hook, so a short window right after an
  install remains (threat model).
- **Play:** stays signed in with the parent-owned account; `DISALLOW_MODIFY_ACCOUNTS` and
  Play's `allowed_accounts`; Play's own parental controls behind a PIN, and
  authentication for every purchase.
- **Hardening:**
  - `DISALLOW_FACTORY_RESET`, plus a factory-reset-protection policy with the parent's
    Google ID (`people/me`), then the `FRP_CONFIG_CHANGED` broadcast to Play services.
    New accounts can take 72 hours. Test a recovery-mode reset.
  - `DISALLOW_SAFE_BOOT`, `DISALLOW_ADD_USER`, `DISALLOW_USER_SWITCH`.
  - `DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY`, and from 37.2
    `DISALLOW_INSTALL_UNKNOWN_SOURCES_INCLUDING_REGISTERED_APP_STORES` (that's its exact
    name; gate on `SDK_INT_FULL >= 3700002`, since 37.0 rejects the key). From 37.2 the
    older restrictions don't cover registered app stores.
  - `DISALLOW_DEBUGGING_FEATURES` (also keeps OEM unlocking off, which FRP needs).
  - `DISALLOW_CONFIG_DATE_TIME` and `setAutoTimePolicy`.
  - `DISALLOW_CONFIG_VPN`, `DISALLOW_CONFIG_PRIVATE_DNS`, `DISALLOW_CONFIG_DEFAULT_APPS`,
    `DISALLOW_SIM_GLOBALLY`. Private Space is already blocked on device-owner phones.
  - A parent-only maintenance mode lifts the debugging restriction for a set time, so adb
    works for repairs.
- **Web:** Private DNS with `setGlobalPrivateDnsModeSpecifiedHost`, off the main thread
  (default CleanBrowsing Family, `family-filter-dns.cleanbrowsing.org`; AdGuard Family,
  NextDNS or our own resolver as options). Chrome managed configuration through
  `setApplicationRestrictions`: `IncognitoModeAvailability=1`, `ForceGoogleSafeSearch`,
  `ForceYouTubeRestrict`, `DnsOverHttpsMode=off`, `BrowserSignin`,
  `SafeSitesFilterBehavior`, `DownloadRestrictions`, an optional allowlist-only mode. Or no
  browser at all.
- **Commands in seconds:** a long-poll from the service (a process with a foreground
  service keeps network access in Doze), with the policy version in every check-in as the
  fallback. **Offline:** the phone keeps enforcing its last policy.
- **MCP writes:** `block_app` and `pause_phone` act directly; `propose_change` only creates
  a proposal for the parent page. Every write is logged with the client's name.

## Phase 3: screen time and schedules

- Per-app usage (usage access was granted at provisioning; report it if revoked: a device
  owner can't pin it).
- Daily limits, school and bedtime schedules (suspend), lock now, "ask for more time".
- AI summaries.
- **Stages and a family agreement:** named levels bundle the rules, so loosening is a
  visible step the kid can work toward, and the phone shows what unlocks next. An MCP
  prompt, `family_check_in`, helps parent and kid go over the agreement each month.
- Opt-in network logging (`setNetworkLoggingEnabled`); the kid sees Android's notice; AI
  can't read it unless allowed.

## Phase 4: location

- The device owner grants itself location (adb-provisioned device owners can grant sensor
  permissions); `setLocationEnabled` and `DISALLOW_CONFIG_LOCATION`.
- On demand and periodic, with places (arrived at school, left school). The kid sees
  Android's notice. AI access off by default.

## Phase 5: calls and texts

- **Calls:** Belay as the default dialer (`setDefaultDialerApplication`, API 34), so only
  approved contacts ring through; withheld numbers handled by the dialer, since call
  screening never sees them.
- **Texts, decided after testing:** keep Google Messages (RCS, on-device sensitive-content
  warnings) and monitor with `READ_SMS` (adb installs allowlist that hard-restricted
  permission), or make Belay the default SMS app with a contact allowlist (SMS/MMS only).
  Either way: alerts, not transcripts, filtered in tiers: on the phone first, flagged
  snippets to the server, the parent's AI only if allowed.
- 911 and 988 always work.

## Later

- Provisioning from the parent page in desktop Chrome over WebUSB (an adb implementation
  such as Tango/ya-webadb), so other families don't need the Android SDK.
- Agent self-update from the server (PackageInstaller, pinned signature, parent-approved).
  Note: updates a device owner installs go through developer verification, and the
  exemption for device-owner phones is reported to end in September 2027. Register first.
- Developer Console registration before 2027 (the free limited-distribution account only
  registers package names never seen on Android: see docs/signing.md).
- **Other families:** each needs its own application id and release key (the key never
  leaves a family, and a limited-distribution account covers 20 to 50 phones). The build
  would need a configurable application id for them; `family.brooker.belay` itself never
  changes.
- Check how Android 17's built-in parental controls, and its new supervision role, coexist
  with a device owner.
- Hosting for more than one family.
