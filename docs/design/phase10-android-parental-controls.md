# Phase 10: living with Android's own parental controls

**Status: design.** A new phase. Android facts cite
[platform-notes-drafts.md](platform-notes-drafts.md): V1 to V3, S4, W1, W2. Its detection part is
small and protects Phase 2, so build it with Phase 2 or right after.

## Goals

1. **Know** when Android's own parental controls, Family Link, Digital Wellbeing or another user or
   profile is active on a Belay phone, and say so plainly.
2. **Keep Belay's rules in force** when something else changes the same settings.
3. **Let the family choose:** keep Android's controls next to Belay, or remove them, with a
   parent's approval.

## What Android 17 does

- **Android Parental Controls** are in Settings on every Android 17 phone, behind a PIN, with a
  daily limit, downtime, app limits and blocking, and Play rating filters (V1, Google's blog
  2026-06-16).
- **The PIN creates a hidden user**, a supervising profile, and Settings creates it even when
  `DISALLOW_ADD_USER` is set (V1). Phase 2's restriction doesn't stop it.
- **That profile is an unaffiliated user** to the device-owner code (V2), so while it exists:
  Private DNS can't be changed (`SecurityException`), network logs pause and can't be read, and the
  global proxy and bug reports fail (W1, W2). A Private DNS host already set stays set.
- **Its app policies share Belay's suspension entry** (S4): allowing or blocking an app there
  unsuspends the platform's entry, which can lift a Belay suspension until Belay puts it back.
- **Before provisioning,** an existing supervising profile makes `dpm set-device-owner` refuse
  (V1, P3).
- **Family Link child accounts** very likely can't coexist with a device owner (A1).
- **Digital Wellbeing** suspends under its own name; its timers add to Belay's (S4).
- **The supervision roles and APIs** are system-only (V3): Belay can't join Android's supervision.
- A device owner can **list** other users (`getSecondaryUsers`, which includes a supervising
  profile) and **remove** one (`removeUser`) (V2).

## Design

### Detect

At every agent step, Belay checks:

- `getSecondaryUsers(admin)`: any user at all is reported as "Another user or profile is on this
  phone". Belay can't read its type without system permissions, so the parent page explains the
  likely cause: "This usually means Android's own Parental Controls were set up in Settings."
- Its held suspensions, read back (Phase 3): one that something else lifted is put back and
  reported ("Something else changed Belay's app rules; Belay put them back").
- Private DNS and network-log calls that throw `SecurityException`: reported with Android's
  reason, never retried in a loop.
- `UserManager.hasUserRestriction` for restrictions Belay didn't set (for example
  `DISALLOW_FACTORY_RESET` from Android's supervision): reported as information.

These go in `health.other_users` and `enforcement.problems`; the server shows them as problems.

### Respond

- **Keep both** (the family's choice): Belay keeps re-applying its own suspensions; Android's
  limits add up with Belay's. Belay reports that Private DNS changes and network logs are paused
  while the profile exists.
- **Remove it:** a parent approves "Remove the other user or profile" on the parent page (it
  removes another control, so it's a parent's action, never an AI client's); the phone calls
  `removeUser` (V2) and reports the result. The kid sees beforehand: "Your parent is removing
  Android's own Parental Controls from this phone, because Belay does that job."
- **Prevent it** (to test first): hiding the system supervision app might remove the Settings entry
  (V1: the entry needs that component). The package name on the Pixel is unknown (`dumpsys role`
  for `android.app.role.SYSTEM_SUPERVISION`). Only after a Pixel test, and as a family decision.

### Provisioning

`provision.sh` already refuses when another user exists (P3). It gains a specific message when
`adb shell cmd user list -v` shows a user with `type=profile.SUPERVISING` (the verbose list prints
each user's type, `UserManagerServiceShellCommand`): "Android's own Parental Controls are set up on
this phone. Turn them off in Settings > Parental controls, then run this again."

### Family Link and Play

Belay's Phase 2 plan stays: a parent-owned regular Google account, not a child account (A1), and
Play's own parental controls behind a PIN for ratings and purchases.

## Protocol

### Health additions

| Field | Type | |
|---|---|---|
| `other_users` | int | users other than the kid's own, from `getSecondaryUsers` |
| `foreign_restrictions` | string[] | user restriction keys in force that Belay didn't set, at most 20 |

### Commands

`kind: "remove_other_users"`, issued only from the parent page. The phone removes every user
`getSecondaryUsers` lists and reports each result in `enforcement.commands`.

## Privacy and transparency

No new data beyond a count of users. Kid-facing words:

- "Android's own Parental Controls are also set up on this phone. Belay still works. Your parent
  can see this."
- "Your parent is removing Android's own Parental Controls from this phone, because Belay does that
  job."

## Threat model changes

| What the kid could do | With Phase 10 |
|---|---|
| Set up Android Parental Controls with their own PIN, to stop Private DNS changes or network logs | Reported at once as another user; a parent can remove it. |
| Use Android's controls to unblock an app | Belay puts its suspension back and reports it (S4). |
| Use Digital Wellbeing's timers | Only stricter, so allowed. |

## Test plan

- **JVM:** the reconcile step that re-applies lifted suspensions, from fake read-backs.
- **Instrumented (emulator):** create a user with `pm create-user` from the test (emulator only),
  check `other_users`, the `SecurityException` from `setGlobalPrivateDnsModeSpecifiedHost` (W2), and
  `removeUser` removing it.
- **On the Pixel:** set up Android Parental Controls on a provisioned phone; record what Settings
  shows, what Belay reports, and what removal does.

## Decisions the family must make

1. If Android's own controls appear: keep them alongside Belay, or remove them.
2. Whether to try hiding Android's supervision entry, once it's tested.

## Open questions

- Does Settings offer Android Parental Controls on a device-owner Pixel at all (the flags and the
  supervision component, V1)?
- What does Settings call the entry on the Pixel ("Parental controls", or under Digital Wellbeing),
  for `provision.sh`'s message?
- Do Android's supervision policies reach the Pixel's Android 17 (the flag
  `enable_supervision_package_usage_apis`)?
