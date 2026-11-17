# Phase 6: reliability and operations

**Status: design.** A new phase. Android facts cite
[platform-notes-drafts.md](platform-notes-drafts.md) by id. Build its first two parts (self-update
and the recovery key) right after Phase 2, before Phase 3 ([README](README.md)).

## Goals

1. **Update Belay without adb:** from the family's server, with a pinned signing certificate and a
   parent's approval. After Phase 2 locks debugging, every update otherwise needs maintenance mode
   and a computer.
2. **Never lock the family out:** a phone whose server is gone, or whose parent forgot everything,
   can still be repaired without a factory reset that FRP then blocks.
3. **Backups that are proven to restore.**
4. **Health monitoring:** the parents hear about a problem before the kid notices it, and the
   server checks itself.

## What Android 17 allows

| Need | What Android 17 offers | Notes |
|---|---|---|
| Install silently | A device owner's `PackageInstaller` session needs no user action (I2) | The kid sees Android's "Updated by your admin" notice. Downgrades are refused for release builds (I2). |
| Same key | Android only updates an app with an APK signed by the same key (docs/signing.md) | APK Signature Scheme v3 rotation needs the old key. |
| Developer verification | No device-owner bypass in AOSP 17; Google exempts "organization store" installs on managed devices, but whether that covers Belay isn't stated (I3, D1) | Register the package anyway; keep the adb path. |
| Restricted permissions | A self-update's session allowlists new restricted permissions by default (I4) | Check on the emulator before Phase 5 relies on it. |
| Factory reset | The only exit for a release device owner (P4); Phase 2 blocks it and sets FRP | So a lost server and a lost parent account could strand the phone. |

## Design

### Self-update

1. **Build** on the family's computer, as today: `scripts/build-release.sh`. The key never leaves
   that computer (docs/signing.md).
2. **Upload** to the server: a new CLI command (`node dist/cli.js agent-add belay-0.4.0.apk`,
   docs/server.md) or the parent page. The server
   stores the file under its SHA-256 and the version the parent typed; it doesn't parse the APK
   (parsing binary manifests needs a library, and the phone checks everything anyway).
3. **Approve** on the parent page: an update changes the enforcer, so it's a parent's action,
   never an AI client's, and it's audited. The parent picks the phones.
4. **Offer:** the policy gains `agent_update` with the file's SHA-256, size and version.
5. **Check on the phone** before installing: the download's SHA-256 matches; the APK
   (`getPackageArchiveInfo` with `GET_SIGNING_CERTIFICATES`) has Belay's package name, a higher
   version code, and exactly the signing certificate Belay itself runs with (the pin). Any
   mismatch: refuse and report.
6. **Install** with a `PackageInstaller` session (silent, I2) on a worker thread; report each state
   in `enforcement.agent_update`. Belay restarts through `MY_PACKAGE_REPLACED`, as today.
7. **If Android refuses** (developer verification, I3, or anything else), report Android's status
   message word for word; the parent page offers "Update over adb in maintenance mode".

No rollback: Android refuses downgrades, so a bad release is fixed by a newer one. The CI emulator
test runs every release before it's uploaded, and the server warns when a phone goes silent within
an hour of an update.

### The recovery key

At the moment Phase 2 first turns on `debugging` or `factory_reset`, the server makes a
**recovery key** (128 random bits, shown once as 26 letters and numbers, to print or keep in a
password manager) and puts only its salted hash in the policy. On the phone, Belay's screen has
"Recovery" (under "About Belay"): entering the key lifts `debugging` and `factory_reset` for 24
hours, offline, with no server. Wrong tries wait: 1 minute after 3, then doubling. The phone
reports the use when it can; the server then makes a new key.

This doesn't switch Belay off (release builds still contain nothing that can, CLAUDE.md); it opens
the same door as maintenance mode, without the server. With 128 random bits, guessing is
hopeless. If someone sees the key typed in, the server replaces it after one use.

### Backups

- A daily job in the server writes `VACUUM INTO /data/backups/belay-YYYY-MM-DD.db`, a consistent
  copy while the server runs, keeps 14, and records the result.
- `cli.js backup --encrypt` (and the daily job, if the family sets a passphrase) writes an
  AES-256-GCM file with a key from the passphrase (Node's built-in `crypto`, scrypt): no new
  dependency, and a backup copied off the machine is safe on its own.
- `cli.js verify-backup <file>` opens a copy read-only, runs `PRAGMA integrity_check`, checks
  the schema version, and counts phones and apps. The parent page shows "Last backup: today;
  last verified: 12 days ago" and asks for a restore drill every 3 months
  ([server.md](../server.md) gains the drill: restore into a scratch container, sign in, see the
  phones).
- Off-site copies stay the family's job: the docs name Litestream and plain copies.

### Health monitoring

- **Phones:** the existing problems (silent, not device owner, permissions…), plus each phase's
  `enforcement` problems, a phone that went silent after an update, and an agent version behind
  the server's latest approved one.
- **Server:** disk free under 10%, the database growing fast, the last backup older than 2 days or
  failing, the clock off (compared with the phones' clocks: many phones' skew in the same direction
  means the server's clock is wrong), and a migration that failed.
- **Telling the parents:** Phase 2's push for urgent problems; a daily digest for the rest; the
  same in `list_devices` and on the parent page.
- **`GET /healthz`:** "ok" or a short reason, no family data, no login: for the family's own uptime
  monitor.

## Protocol

### Device additions

| Field | Type | |
|---|---|---|
| `agent_signing_sha256` | string | the SHA-256 of Belay's own signing certificate, hex: the server pins the first one it sees |

### Policy additions

| Field | Type | |
|---|---|---|
| `agent_update` | `{version_code, version_name, sha256, size}`? | the update a parent approved for this phone |
| `recovery` | `{salt, hash, version}`? | SHA-256 of salt and key, hex; the key's 128 random bits make a slow hash unnecessary, so no new library |

### Enforcement additions

| Field | Type | |
|---|---|---|
| `agent_update` | `{version_code, state: "downloading" \| "checking" \| "installing" \| "failed" \| "done", problem?}`? | |
| `recovery_used_at` | int? | the last use of the recovery key |

### `GET /api/v1/agent/<sha256>.apk`

The approved APK, with the device token, at most 100 MB, `Content-Type:
application/vnd.android.package-archive`. 404 unless that file is approved for this phone. Supports
`Range`, so a download over cellular can resume.

## Privacy and transparency

No new data. The kid sees Android's "Updated by your admin" (I2) and Belay's own "Belay was updated
to version %1$s by your parent." The Recovery screen says what it's for: "For your parent, if
Belay's server is gone. It opens repair access for 24 hours."

## Threat model changes

| Who, what | With Phase 6 |
|---|---|
| Someone who takes over the server | Can't sign an APK (the key is on the family's computer), so Android and Belay's pin refuse anything else; can't push an older genuine version either, since Android refuses downgrades (I2). |
| Someone with the server and a parent's password | Can approve an update, but only of an APK the family signed. |
| The kid guesses the recovery key | 128 bits, with waits after wrong tries. |
| The kid sees the key typed in | One use, then the server replaces it; the use is reported. |
| A bad update | Can't roll back; the emulator test gates releases; silence after an update is flagged. |
| A lost server and no backup | The recovery key reopens adb and factory reset; the phone then needs re-enrolling (docs). |
| Developer verification refuses the update | Reported; adb in maintenance mode still works (I3). |

## Test plan

**JVM:** the update checks (hash, package, version, certificate) as a pure function with fixture
metadata; the recovery key's hash and the waits after wrong tries.

**Server (Vitest):** upload, approval only from the parent page, the offer in the policy, the
download's 404 rules and `Range`; `VACUUM INTO` and `verify-backup` on a fixture database;
encryption round trip; `/healthz`.

**Instrumented:** a `PackageInstaller` session as device owner installs the fixture app's v2
silently; a fixture signed with another key is refused by Belay's check before installing.

**CI end to end:** CI builds Belay twice with the same debug key (version codes 2 and 3); the
server's CLI uploads and approves version 3; the phone updates itself and checks in with version
code 3. The recovery key: debug builds never apply `debugging` or `factory_reset` (Phase 2's
rule), but they report what they would enforce; the test turns both on from the CLI, enters the
key through an instrumented test, and sees both reported as lifted for 24 hours.

## Decisions the family must make

1. Who approves updates, and whether to update every phone at once.
2. Where the recovery key lives (printed, password manager) and who has it.
3. The backup passphrase, and where off-site copies go.
4. Which problems wake a parent (push) and which wait for the digest.

## Open questions

- Will Google's verifier accept Belay's own updates on a registered package in 2027 (I3)? Measure
  on the Pixel when enforcement reaches the US; kidctl's result (D1) is encouraging.
- Does the recovery key need to lift FRP's policy too, so a phone can be reset and set up without
  the parent's Google account? Proposed: no; lifting `factory_reset` plus a reset from Settings
  avoids FRP ([pixel.md](../pixel.md)).
- Should self-update also be allowed for the debug build on the emulator only, to test it? Yes:
  the update path is the same; only the key differs.
