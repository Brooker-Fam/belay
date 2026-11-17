# Phase 11: off belay

**Status: built** on the server and the phone, with the debug build's side run in CI on the
Android 17 emulator (`HandoverInstrumentedTest`, and `ci-emulator-test.sh` before its restart).
**Still open:** [phase11-checklist.md](../phase11-checklist.md) on the Pixel with a release build:
a full hand-over, ending in a reset from Settings and a setup with another account. What was
built differs from this design in a few places, each because the code can't claim more than it
does:

- The policy gains `off_belay` (`{how, position}`), so the phone can list Off belay last from the
  first day; `stage` only names the next stage.
- Moving to Off belay stops a phone's screen-time limits and schedules, as any stage does; Phase
  2's blocking (new apps, blocked apps, the web filter) stops when a parent turns protection off,
  and the kid's sentence is "Belay isn't blocking any apps or websites on this phone any more.",
  shown only when that's true.
- Play's `allowed_accounts` (the policy's `play_accounts`, set by a parent with hardening) came
  after this design: the hand-over empties them, and lifting `modify_accounts` lets the kid add
  their own account.
- Stopping collecting has a switch only for screen time (measuring) and location; the phone sends
  its app list and the kid's requests while Belay is on it, so for those the server deletes what
  it keeps, and a request the phone still lists keeps a bare record with its answer.
- A parent can take a hand-over back; while one lasts, nothing it lifted can be locked again.

In climbing, "off belay" is the call when the climber is safe and doesn't need the rope any more.
This phase is the end of principle 7, "built to loosen": the kid outgrows Belay, and the phone
becomes simply theirs.

## Goals

1. **A last stage that's visible from the start:** the kid can see, from the first day, that the
   rules end.
2. **Wind down in steps:** stop blocking, then stop collecting, then remove Belay, each a parent's
   decision the kid sees coming.
3. **Hand over the phone cleanly:** the kid's own account, their own data kept, no factory reset
   protection tied to the parent's account, nothing left behind on the server.

## What Android 17 allows

- A release device owner can only be removed by a factory reset (P4). Belay's release builds
  contain nothing that can switch Belay off (CLAUDE.md), so this phase keeps it that way.
- Phase 2 blocks factory reset and sets factory reset protection with the parent's account (F1).
  A reset from Settings, while that account is on the phone, doesn't trigger FRP; a recovery-mode
  reset does ([pixel.md](../pixel.md)).
- Clearing the FRP policy (`setFactoryResetProtectionPolicy(null)`) returns the phone to consumer
  FRP, which asks for an account that was on the phone (F1).

## Design

### The last stage

The family's stage list ends with **Off belay**. Its template turns off every restriction except
the ones the family keeps (often none), every collection except device health, and every limit.
From Phase 3 on, the kid's "My stage" screen shows it at the end of the list, with the family's
words for when it comes ("When you turn 16", "When you've kept the agreement for a year").

### Winding down

1. **Stop blocking:** the phone moves to Off belay. Apps, schedules and filters stop; the kid sees
   "Belay isn't blocking anything on this phone any more."
2. **Stop collecting:** each category turns off (Phase 3's collection switches); the kid's "What
   your parent can see" shrinks to device health, then to nothing. The server deletes the data of
   each category turned off, after a confirmation that says exactly what goes.
3. **Hand over:** on the parent page, "Hand this phone over":
   - lifts `factory_reset` and `debugging` (Phase 2),
   - clears the FRP policy,
   - removes `allowed_accounts` (Play may use the kid's own account),
   - tells the kid what happens next and what to back up first.
4. **Reset, together:** the kid (with a parent) backs up their photos and data to the kid's own
   account, removes the parent-owned account, and resets from Settings. The phone starts as a
   normal phone; the kid sets it up with their own Google account. Belay is gone.
5. **Close the server side:** the server disconnects the phone and offers to delete everything it
   recorded about it (the existing "delete a disconnected phone", docs/privacy.md).

Nothing here happens by itself and nothing can be done by an AI client: every step loosens or
deletes, so each is a parent's action on the parent page (principle 2), and the phone shows each
step before it happens.

## Protocol

- The stage is an ordinary stage (Phase 3); no new policy fields.
- `handover: {at, by}?` in the policy: the phone shows the hand-over screen and runs the step 3
  actions (each already a policy field: restrictions, `frp_accounts`, Play's configuration).

## Privacy and transparency

Kid-facing words (drafts):

- "Last stage: Off belay. %1$s" (the family's words for when)
- "Belay isn't blocking anything on this phone any more."
- "Your parent is handing this phone over to you. Before you reset it, back up your photos and
  anything else you want to keep to your own account. Then go to Settings > System > Reset options
  > Erase all data."
- "After the reset, this phone is yours. Belay won't be on it."

## Threat model changes

| What the kid could do | With Phase 11 |
|---|---|
| Ask the AI to hand the phone over | AI clients can't move stages or hand over; only a parent. |
| Reset early from recovery mode | Still blocked by FRP until the hand-over clears it. |

## Test plan

- **Server:** Off belay's template; the hand-over sets exactly the restrictions, FRP and Play fields
  it should, and data deletion removes every category's rows.
- **CI end to end:** on the emulator with the debug build, the hand-over policy lifts the
  restrictions (as Phase 2's debug builds report them) and clears FRP; the debug build is then
  removed by `unprovision.sh` as today.
- **On the Pixel:** a full hand-over with the release build, ending in a Settings reset and a setup
  with a different account, recorded in a checklist.

## Decisions the family must make

1. When Off belay comes, in words the kid can read from the start.
2. Which collections, if any, stay on after blocking stops, and for how long.
3. Whether the server keeps anything after the hand-over (default: delete everything).

## Open questions

- Can the kid move their data across the reset with Google's own backup, given the phone was fully
  managed? (Backup rules on managed devices; untested.)
- Should there be an "Off belay" for siblings sharing a server, keeping the family's server but not
  this kid's data? (Phase 9's families model covers one family; this is per phone.)
