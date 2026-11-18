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

## Phase 2: safe to hand over (built)

Built, and on `main`. CI runs it end to end on the Android 17 emulator against a real server
(both images): a new app is suspended on install, approved from the server and unsuspended
within seconds, then blocked. **Still open:** [docs/phase2-checklist.md](docs/phase2-checklist.md)
on the Pixel 8: Private DNS, Chrome's settings, the hardening locks and reset protection only
work on the real phone with a release build.

The contract is in [docs/protocol.md](docs/protocol.md) (Policy, long-poll, requests,
enforcement rules); the Pixel checklist is [docs/phase2-checklist.md](docs/phase2-checklist.md).
Factory reset, debugging and reset-protection locks are built off by default: only a parent
turns them on, on the parent page, and debug builds never apply them. Parents hear about
requests through end-to-end encrypted Web Push.

- **Apps:** each new app is suspended the moment it installs ("Waiting for your parent"),
  and the kid can say why they want it. The parent is notified (Web Push), can ask
  the AI for a review, and approves on the parent page. Every request gets an answer the
  kid sees (approved, declined, or "let's talk") with the parent's note. Hard blocks use
  `setApplicationHidden`. There is no pre-install hook, so a short window right after an
  install remains (threat model).
- **Play:** stays signed in with the parent-owned account, and `DISALLOW_MODIFY_ACCOUNTS` keeps
  the kid from adding their own; Play's own parental controls behind a PIN, and authentication for
  every purchase. With the parent-owned accounts listed on the phone's page (hardening), Play's
  `allowed_accounts` managed configuration (platform notes A4) keeps Play to them even if another
  account is on the phone; the hand-over clears it. Built; the Phase 2 checklist tries it on the
  Pixel.
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

## Later phases

Designed, not built: each has a design in [docs/design/](docs/design/README.md) with what
Android 17 allows (checked against AOSP and the docs), the protocol, privacy, threat model
changes, tests and the family's decisions. Build order: Phase 2; then Phase 10's detection
and Phase 6's self-update and recovery key; then Phase 3 with Phase 7's core; Phase 4;
Phase 5 (calls, then texts); Phases 8, 9 and 11 when they're needed.

**Built since Phase 2** (on `main`, run end to end in CI on two Android 17 emulator images; none
of it yet on a real Pixel). The contracts are in [docs/protocol.md](docs/protocol.md), and each
phase's Pixel checklist is in `docs/`.

- **Phase 3:** screen time (limits, schedules, lock now, measuring, more time, stages and the
  agreement), and opt-in network logging.
- **Phase 4:** location, off by default.
- **Phase 5:** calls, with Belay as the phone app when a parent turns calls on: approved
  contacts, who rings, call records. 911, emergency numbers and 988 are always allowed, in code.
- **Phase 6:** self-update, the recovery key, encrypted backups and health checks. CI restores an
  encrypted backup onto a new machine, and builds and runs the server's image on amd64 and arm64.
- **Phase 7:** the kid's side: Home, "I need help", the emergency card, "talk to my parent".
- **Phase 8:** the setup kit. One provisioning plan runs in `provision.sh` and in the kit, and CI
  provisions the emulator with the kit's runner.
- **Phase 10:** another user or profile is reported, and removed when a parent asks.
- **Phase 11:** off belay: the last stage, stopping collection with deletion, the hand-over.
- **Across phases:**
  - three security reviews, with their fixes in (the third's fixes to call handling on the phone are
    still being made);
  - an audit of how a kid could get around Belay on Android 17: a proxy and wireless debugging
    are reported, Chrome ignores proxies, and the time zone stays automatic;
  - limits on what an AI app can do to the kid's phone (checks, pauses, locks, and schedules
    that lock);
  - Play's `allowed_accounts`;
  - the parent page reworked for phones and screen readers;
  - [docs/guide.md](docs/guide.md), one guide for parents.

**Next:**
- the Pixel checklists, starting with [Phase 0's](docs/phase0-checklist.md);
- Phase 5's texts, after the Pixel test of Google Messages' archival hook;
- Phase 9, when another family needs it.

### Phase 3: screen time, schedules and stages ([design](docs/design/phase3-screen-time.md)) (built)

Built and run end to end in CI, opt-in network logging included. **Still open:**
[docs/phase3-checklist.md](docs/phase3-checklist.md) on the Pixel (after updating, the phone
needs one restart before lock now works: platform notes, S5; network logging's step 7 is
Pixel-only: Android's own notice, and a real browser's lookups).


- Per-app time counted on the phone from usage events (the system's usage-limit observers are
  closed to Belay); daily limits and school, bedtime and custom schedules as a pure function in
  `:core`, enforced by suspension; "lock now"; the kid asks for more time.
- If usage access is turned off, apps with a limit pause, and the parent page says why.
- **Stages and a family agreement:** named levels bundle the rules, the phone shows what the next
  stage changes, and an MCP prompt, `family_check_in`, supports a monthly talk.
- Opt-in network logging, reduced on the phone to domains per app per day; AI can't read it
  unless allowed. Never 988's websites, nor the private websites a parent lists (a helpline's, a
  counselor's), which no AI app sees. Open family decision: a built-in list of child-safety
  helplines' websites too ([threat model](docs/threat-model.md#the-kid-and-network-logging-phase-3)).

### Phase 4: location ([design](docs/design/phase4-location.md)) (built)

Built and run end to end in CI (an emulator GPS fix answers "locate now"; turning location off
takes the permission away). **Still open:** [docs/phase4-checklist.md](docs/phase4-checklist.md)
on the Pixel, including the battery cost per mode.


- Off by default; on demand, or periodic with places (arrived at school, left school) computed on
  the phone, and a lost-phone mode. Belay grants itself location only while the family has it on.
- The kid sees every check, from the phone's own record. AI access is off by default; the server
  never calls a map or geocoding service.

### Phase 5: calls and texts ([design](docs/design/phase5-calls-texts.md)) (calls built)

Calls are built and run end to end in CI (a contact's call rings Belay's screen, a stranger's
is refused and recorded, Belay becomes and stops being the phone app). **Still open:**
[docs/phase5-checklist.md](docs/phase5-checklist.md) on the Pixel, and texts, after the Pixel
test of Google Messages' archival hook (T8).


- **Calls:** Belay as the default dialer, so the family decides who rings, including withheld
  numbers. 911 always goes to the phone's own dialer; 988 is allowed in Belay's code; neither is
  ever recorded.
- **Texts:** keep Google Messages and use its RCS archival hook for fully managed phones (to be
  tested on the Pixel), so Belay reads SMS, MMS and RCS on the phone and sends alerts, not
  transcripts, in tiers the family picks. Being the default SMS app (SMS/MMS only) remains the
  option for approved-contacts-only texting.

### Phase 6: reliability and operations ([design](docs/design/phase6-reliability.md)) (built)

Built, and run end to end in CI: a parent offers a newer Belay with `agent-add` and `agent-offer`,
and the phone downloads, checks and installs it by itself; the recovery key opens repair access
with no server; daily backups, encryption, `verify-backup`, `restore` and a restore drill; server
health problems, `/healthz?strict=1` and an opt-in daily summary. **Still open:**
[docs/phase6-checklist.md](docs/phase6-checklist.md) on the Pixel, with a release build (CI's
self-update uses a non-test-only debug build: platform notes, I5).


- Self-update from the family's server: the parent uploads an APK signed on their own computer and
  approves it; the phone checks the hash, version and its own signing certificate before a silent
  install. (Developer verification in 2027 may still apply: register first.)
- A recovery key kept offline lifts the debugging and factory-reset locks for 24 hours if the
  server is ever lost.
- Daily backups with a verify command and restore drills; health monitoring of phones and server.

### Phase 7: the kid's side ([design](docs/design/phase7-kid-side.md)) (built)

Built and run end to end in CI (a help request with a shared fix, even with location off; a
parent's "seen" reaching the phone). **Still open:** [docs/phase7-checklist.md](docs/phase7-checklist.md)
on the Pixel, including the emergency card while paused.


- Belay as the kid's own app: requests and answers, their stage and agreement, what the parents
  can see and what Belay told them, an "I need help" button and an emergency card that work even
  while the phone is paused, and "talk to my parent".

### Phase 8: setup without the Android SDK ([design](docs/design/phase8-setup-without-sdk.md)) (built)

Built ([docs/setup-kit.md](docs/setup-kit.md)): `provision.sh`'s steps are a plan,
`android/scripts/provision-plan.json`, run by lib.sh and by the kit, both held to the same
fixtures; the kit's container, page and command-line runner; CI's informational emulator job with
the kit's runner. **Still open:** a factory-fresh Pixel 8 with desktop Chrome on Linux, macOS and
Windows (and Windows' USB driver).

- A setup kit on the parent's computer that makes the key, builds and signs the APK, and provisions
  the phone from a local page in desktop Chrome over WebUSB (Tango, MIT). One provisioning plan
  drives both the page and `provision.sh`. The key never touches the family's server.

### Phase 9: more families ([design](docs/design/phase9-more-families.md))

- A configurable application id per family, each signed by its own family's key and registered by
  its own developer account; `family.brooker.belay` itself never changes. Later, an optional
  server for a few families who trust its operator, every query scoped to one family.

### Phase 10: living with Android's own parental controls ([design](docs/design/phase10-android-parental-controls.md)) (built)

Built: Belay reports other users and restrictions it didn't set, puts lifted suspensions back,
and a parent can remove another user or profile from the phone's page (`remove_other_users`).
**Still open:** setting up Android's own Parental Controls on the real Pixel.


- Android 17's built-in Parental Controls create a hidden supervising profile even when adding
  users is blocked; while it exists, Belay can't change Private DNS or read network logs, and its
  app rules can lift Belay's suspensions. Belay detects other users, re-applies its rules, and lets
  a parent remove the profile.

### Phase 11: off belay ([design](docs/design/phase11-off-belay.md)) (built)

Built and run end to end in CI (the hand-over reaches the phone, which lifts its locks and shows
the kid what comes next). **Still open:** [docs/phase11-checklist.md](docs/phase11-checklist.md)
with a release build, ending in a reset from Settings.


- The last stage, visible from the start: blocking stops, then collection stops, then the parent
  hands the phone over: restrictions and reset protection lifted, data backed up to the kid's own
  account, a reset from Settings, and the server's data deleted.
