# Designs for Phase 3 and later

The design for each phase after Phase 2. Each has the same parts: goals, what Android 17 allows
(with sources), the design across phone, server, MCP, parent page and the kid's screens, an exact
protocol proposal, privacy and transparency, threat model changes, a test plan, the family's
decisions, and open questions. The device API's contract is [docs/protocol.md](../protocol.md):
where a design's protocol proposal differs from it, protocol.md is what's built.

**What's built:** every phase here but Phase 5's texts and Phase 9, run end to end on the Android
17 emulator in CI ([emulator.md](../emulator.md#what-ci-runs)). None of it has run on a real Pixel
yet: each built phase has a Pixel checklist, named below. [ROADMAP.md](../../ROADMAP.md) has the
rest.

The Android facts were checked on 2026-11-17 against AOSP `android-17.0.0_r1` and
developer.android.com, and written up as entries for [docs/platform-notes.md](../platform-notes.md)
in [platform-notes-drafts.md](platform-notes-drafts.md) (ids like U1, T8). As each phase was built,
its entries moved into platform-notes.md (the drafts' summary says which), where "Verified on" says
what the emulator has shown; none has run on a real Pixel yet. Principles 1 to 9
([CLAUDE.md](../../CLAUDE.md)) hold in every design.

## The phases

**[Phase 3: screen time, schedules and stages](phase3-screen-time.md).** Built; its Pixel checklist
is [phase3-checklist.md](../phase3-checklist.md). Belay counts per-app foreground time on the phone
from `queryEvents` (public, with the usage access granted at provisioning), because the system's
usage-limit observers are closed to it. Daily limits and school, bedtime and custom schedules are a
pure function in `:core`, enforced by suspension, with exact alarms at the boundaries; "lock now" is
a pause plus `lockNow`. The kid asks for more time; a parent answers. When usage access is turned
off, apps with a limit pause by default and the parent page says why. Named stages bundle the rules,
the phone shows what the next stage changes, and a family agreement with an MCP prompt,
`family_check_in`, supports a monthly talk. Network logging is opt-in, reduced on the phone to
domains per app per day, off for AI by default.

**[Phase 4: location](phase4-location.md).** Built; [phase4-checklist.md](../phase4-checklist.md).
Off by default; on demand, or periodic with places (arrive, leave) computed on the phone, plus a
lost-phone mode. Belay grants itself location only while the family turns it on, takes single fixes
with the phone's own GPS by default (on a Pixel, the "fused" and "network" providers are expected to
be Google's), and tells the kid about every check, from the phone's own record. AI access is off by
default; the server never calls a map or geocoding service.

**[Phase 5: calls and texts](phase5-calls-texts.md).** Calls are built
([phase5-checklist.md](../phase5-checklist.md), sections 1 to 11); texts aren't. They wait on one
Pixel test, Google Messages' archival (T8), which debug builds carry behind an adb switch (the
checklist's section 12). Belay becomes the default dialer, so the family decides who rings,
including withheld numbers, which call screening never sees. 911 always goes to the phone's
preloaded dialer (Android guarantees it); 988 is an ordinary number to Android, so Belay allows it
in code, and keeps every call and text with emergency numbers and 988 out of its records. For texts,
the recommended start is to keep Google Messages and use its RCS archival hook for fully managed
devices, so Belay can read SMS, MMS and RCS on the phone and send alerts, not transcripts, in tiers
the family picks. Being the default SMS app instead (SMS and MMS only, no RCS) remains the option
for "approved contacts only" texting.

**[Phase 6: reliability and operations](phase6-reliability.md).** Built;
[phase6-checklist.md](../phase6-checklist.md). Self-update from the family's server: the parent
uploads an APK signed on their own computer and approves it, and the phone checks the hash, version
and its own signing certificate before a silent install. A recovery key the parents keep offline
lifts the debugging and factory-reset locks for 24 hours if the server is ever lost. Daily backups
with a verify command and restore drills, and health monitoring of both phones and server.

**[Phase 7: the kid's side](phase7-kid-side.md).** Built; [phase7-checklist.md](../phase7-checklist.md).
Belay as the kid's own app: requests and their answers, the stage and agreement, what the parents
can see and what Belay told them, an "I need help" button and an emergency card that work even when
the phone is paused, and "talk to my parent".

**[Phase 8: setup without the Android SDK](phase8-setup-without-sdk.md).** Built
([docs/setup-kit.md](../setup-kit.md)); not yet tried with a real Pixel 8 (the design's
[test plan](phase8-setup-without-sdk.md#test-plan)). A setup kit, a container on the parent's
computer, that makes the key, builds and signs the APK, and provisions the phone from a localhost
page in desktop Chrome over WebUSB (Tango, MIT). One provisioning plan file drives both the page and
`provision.sh`, so they can't drift. The key never touches the family's server.

**[Phase 9: more families](phase9-more-families.md).** Not built. A configurable application id,
with a check that each id is signed by its own family's key and registered by its own developer
account. Later, an optional server for a few families who trust its operator, with every query
scoped to one family and tests that prove it.

**[Phase 10: living with Android's own parental controls](phase10-android-parental-controls.md).**
Built; its Pixel checks are in [phase6-checklist.md](../phase6-checklist.md), sections 4 and 5.
Android 17's built-in Parental Controls create a hidden supervising profile even when adding users
is blocked; while it exists, a device owner can't change Private DNS or read network logs, and its
app policies can lift Belay's suspensions. Belay detects other users, re-applies its own rules, and
lets a parent remove the profile.

**[Phase 11: off belay](phase11-off-belay.md).** Built; [phase11-checklist.md](../phase11-checklist.md).
The last stage, visible from the start: blocking stops, then collection stops, then the parent hands
the phone over: restrictions and FRP lifted, data backed up to the kid's own account, a reset from
Settings, and the server's data deleted.

**[Phase 12: caregivers](phase12-caregivers.md).** Built; [phase12-checklist.md](../phase12-checklist.md).
A parent gives a grandparent, a babysitter, a coach or the kid's other household limited access to a
phone, for at most 30 days at a time: its status, pausing or locking it (only ever tighter), the
kid's "I need help", and, if the parent allows it, checking where it is now. A separate kind of
account with its own few pages and a session no parent page, MCP or OAuth accepts (a test walks
every route); never anything that loosens. The kid's screen lists each caregiver with what they can
see and do and until when, from the policy, and every pause and check names them. No new Android
capability: only the kid's words.

**[Phase 13: mobile data](phase13-mobile-data.md).** Built; [phase13-checklist.md](../phase13-checklist.md).
For a family plan with a data cap, two parts, both off until a parent turns them on. Wi-Fi-only
apps: a parent marks apps that may not use mobile data, and the phone enforces it as device owner
with `setMeteredDataDisabledPackages`, on every metered network (a phone's hotspot and Wi-Fi marked
metered too), never for Belay, calls, texting, the keyboard, the home screen or Android's own parts;
adding one tightens, removing one is a proposal. Mobile data use: per app per day, from
`NetworkStatsManager` (a device owner reads every app's), with the day's Wi-Fi total, never which
websites or networks; AI access on by default, like screen time's.

## The build order

The order these designs recommended, and where each step stands:

1. **Finish Phase 2**, with the re-check's findings below. Built.
2. **Phase 10's detection** (other users, re-applying suspensions) and **Phase 6's self-update and
   recovery key.** Once Phase 2 locks debugging, every update needs maintenance mode and a
   computer, and a lost server could strand the phone. Both are small, and they make every later
   phase cheaper to ship. Built.
3. **Phase 3 with Phase 7's core** (Home, requests, stage, help, emergency card): the rules and the
   kid's view of them belong together. Built.
4. **Phase 4.** Off by default; the permission-by-policy rule lands here. Built.
5. **Phase 5, calls first** (the dialer, contacts, 911 and 988 rules), **then texts** after a Pixel
   test of Google Messages' archival path. Calls built; texts wait on that test (T8).
6. **Phase 6's backups and monitoring** alongside 3 to 5; **Phases 8, 9 and 11** when other
   families or an older kid need them. Built, but Phase 9. Phases 12 and 13 came after, and are
   built too.

## Phase 2's facts, re-checked before it was built

From the re-check of Phase 2's facts (details and sources in the drafts):

- **Hidden apps look uninstalled to Belay's own inventory** (S3). `setApplicationHidden` kills the
  app and sends package-removed; `getInstalledPackages` without `MATCH_UNINSTALLED_PACKAGES` drops
  it. Blocking an app would record "Removed", unblocking "Installed".
- **`DISALLOW_INSTALL_UNKNOWN_SOURCES(_GLOBALLY)` doesn't block `adb install`** (I1). Only
  `debugging` does, by turning adb off (`DISALLOW_INSTALL_APPS` would block every install).
- **`DISALLOW_SIM_GLOBALLY` only blocks eSIM downloads** (H1); a physical SIM swap isn't blocked.
  Detect a different SIM instead.
- **Private DNS** (W2): the check runs in Belay's process, returns `HOST_NOT_SERVING` when offline,
  and the call throws `SecurityException` while any other user or profile exists, which Android's
  own Parental Controls can create despite `DISALLOW_ADD_USER` (V1, V2).
- **What a suspension shows** (S1): one generic "Can't open this app" screen with the short
  support message (200 characters); per-app words need Belay's own notification. Suspension closes
  the app's screens but doesn't stop its process (S2).
- **FRP** (F1): send `FRP_CONFIG_CHANGED` after `setFactoryResetProtectionPolicy`, as Google's guide
  says (AOSP 17 also sends its own broadcast); FRP is off while OEM unlocking is on.
- **Chrome policies** (W3): all the planned keys exist on Android, with minimum versions; lists can
  be String arrays. In-app browsers (WebView) read `com.android.browser:`-prefixed keys from the
  host app's restrictions (W4).
- **Play's `allowed_accounts`** (A4) and **network in Doze** (W5) are confirmed.
- **Grant by policy, not by manifest:** `DeviceOwnerSetup.ensure` grants every runtime permission
  Belay declares. Any new permission (`READ_PHONE_STATE` for SIM checks, location later) would be
  granted at once, whatever the family decided (L1).

## Shared conventions in these designs

- **Policy fields are additive** and default to enforcing and collecting nothing.
- **Commands** (`lock_now`, `locate_now`, `remove_other_users`) are one-shot entries in the
  policy's `commands`, run once per id, reported in `enforcement.commands`.
- **Requests** become a union on `kind`: `app` (Phase 2), `more_time`, `agreement`, `contact`,
  `help`, `talk`. Parents answer them, never AI clients.
- **Tighten or loosen** is decided by one tested server function per area. AI clients may apply a
  change that only tightens; anything else becomes a proposal for the parent page.
- **Collection is a parent decision:** turning any data category on or off is never an AI action,
  and the kid's "What your parent can see" is built from the collectors that are on.
- **Emergency and crisis numbers:** 911, Android's emergency numbers and 988 are always allowed and
  never recorded, in code; the family can add more private numbers, which Belay never reads or
  records either.

## Riskiest assumptions

1. **adb provisioning keeps working on the real Pixel** (P2), and Google's developer verification
   lets Belay update itself in 2027 (I3): Google's FAQ exempts "organization store" installs on
   managed devices, but doesn't say whether an adb-provisioned controller counts.
2. **Google Messages' RCS archival works with an adb-provisioned device owner and no managed Google
   Play** (T8), and what it shows the kid is acceptable. The texts design leans on it.
3. **Usage access stays on,** or the "can't count" rule is acceptable to the family (U4): the kid
   can turn it off in Settings, and Belay can only notice.
4. **Android's own Parental Controls stay off or can be removed** (V1, V2): nothing in Settings'
   code hides them on a device-owner phone, and nothing Belay sets prevents them.
5. **Belay can be a good enough phone app** (T1, T2): a weak dialer hurts every call; 911 is safe
   (Telecom uses the preloaded dialer), but 988 and everything else run through Belay's code.
