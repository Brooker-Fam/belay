# Pixel day: the checklists, in order

Belay is built, all but Phase 5's texts and Phase 9, and runs end to end on the Android 17
emulator in CI ([emulator.md](emulator.md#what-ci-runs)), but none of it has run on a real Pixel.
This page is the order to run the Pixel checklists on the family's Pixel 8, from a factory-fresh
phone to handing it to your kid, in as few sittings as the checklists allow: one to get ready, then
14 with the phone, over about two and a half weeks. That's about 40 hours in all, and some days
when the phone only needs to be carried and used.

The checklists hold the steps; this page holds their order, what to have ready, and where a result
changes the plan. Where this page and a checklist differ, the checklist is right, and the
difference is worth sending back. Nobody has done this before: expect surprises, and write them
down.

## In every sitting

- **Never call or text 911 or 988 for a test.** Stop at the dial pad or the texting app with the
  number typed, as Phases 5 and 7 say.
- **Made-up names:** contacts, caregivers and places get made-up names, and the kid account is a
  made-up one.
- **Every factory reset is from Settings** (Settings > System > Reset options > Erase all data),
  never from recovery mode, and keeps the eSIM: don't tick the option to erase eSIMs.
- **"Maintenance" in a checklist** means adb with the debugging lock off. Until sitting 12 nothing
  locks debugging, so adb just works, with no maintenance mode.
- **Record as you go** in each checklist's Results table (Phase 0's is in
  [platform-notes.md](platform-notes.md#phase-0-results)): Android's and Belay's words word for
  word, and the Android build (Settings > About phone > Android version > Build number).
- **Stop point** marks a result that changes the plan. **Your decision** marks a step from the
  project's [Ask before](../CLAUDE.md#ask-before) list: this page asks you each time, and never
  takes one for you. **Your call** marks the other choices that are yours.

## Your decisions

Four steps can't be undone without a factory reset, or could lock you out of the phone if
something goes wrong:

| Your decision | Where | What it means |
|---|---|---|
| A release build of Belay as device owner | Sittings 1, 3 and 14 | Only a factory reset removes it. A reset from Settings works while factory reset isn't locked. |
| Lock factory reset (`DISALLOW_FACTORY_RESET`) | Sitting 12 (Phase 2 §6.1) | Nobody can reset the phone from Settings until you unlock it on the phone's page, use the recovery key, or hand the phone over. |
| Lock developer options and USB debugging (`DISALLOW_DEBUGGING_FEATURES`) | Sitting 12 (Phase 2 §6.2) | Until you unlock it, a computer reaches the phone only in maintenance mode, or with the recovery key. |
| Reset protection (a factory reset protection policy with the parent-owned account) | Sitting 12 (Phase 2 §6.3) | A reset from recovery mode sets the phone up again only with that account. |

Phase 6 §3 can only be checked with the factory reset and debugging locks on, and Phase 11 with all
three. If you'd rather not turn them on before your kid has the phone, skip sittings 12 and 13:
sitting 14 says what changes.

Two other choices are your call: registering Belay's package name for Google's developer
verification (sitting 0), and what texts become, from the archival test's outcome (sitting 2).

## The sittings at a glance

| Sitting | When | Hands-on | Checklist sections | Belay on the phone |
|---|---|---|---|---|
| [0](#sitting-0-before-the-phone) | the week before | 2 to 4 hours | Phase 0's "Before you start" | none |
| [1](#sitting-1-phase-0s-first-day) | day 1 | 1 hour | Phase 0 §1, §2.1 to 2.6 | release build |
| [2](#sitting-2-the-rest-of-phase-0-then-the-debug-build) | day 2 | 3 hours | Phase 0 §2.7 to 2.8, §3, §4; Phase 5 §12; Phase 6 §5 (optional) | release, then debug, then none |
| [3](#sitting-3-the-release-build-and-phase-1) | day 3 | 3 hours | Phase 1 §1 to 5 | release build, from here on |
| [4](#sitting-4-phase-2-without-hardening) | day 4 | 3 hours | Phase 2 §1 to 5, §7 | |
| [5](#sitting-5-phase-3-screen-time) | day 5 | 3.5 hours | Phase 3 §0 to 5, §8, §6.1 | |
| [6](#sitting-6-network-logging) | day 6, evening | 1.5 hours | Phase 3 §6.2, §7.1 to 7.3 | |
| [7](#sitting-7-the-end-of-network-logging-and-phase-4) | day 8 | 4 hours | Phase 3 §7.4 to 7.6; Phase 4 §0 to 5 | |
| | days 9 and 10 | minutes | Phase 4 §6 | |
| [8](#sitting-8-phase-7-then-phase-5s-calls) | day 11 | 4 hours | Phase 7 §1 to 6; Phase 5 §1 to 10 | |
| [9](#sitting-9-the-callback-window-with-caregivers-in-its-waits) | day 12 | 4 hours, half of it waiting | Phase 5 §11; Phase 12 §0 to 5 | |
| [10](#sitting-10-phase-13-mobile-data) | days 13 and 14 | 3 hours, spread out | Phase 13 §0 to 7 | |
| [11](#sitting-11-belay-updates-itself-and-androids-own-parental-controls) | day 15 | 2 hours | Phase 6 §1, §2, §4 | newer versions you build |
| [12](#sitting-12-your-decision-hardening) | day 16 | 1 hour, then 5 minutes | Phase 2 §6, the end of §7.6; Phase 6 §3 | release, hardened |
| [13](#sitting-13-your-decision-the-hand-over) | day 17 | 2 hours | Phase 11 §0 to 6 | none, after a reset |
| [14](#sitting-14-your-kids-phone) | day 17 or 18 | 2 to 3 hours | pixel.md; guide.md §6 | release build, for your kid |

The only debug-build test is Phase 5 §12, the archival test (T8): release builds don't contain it.
It runs in sitting 2, before the release build goes on for the weeks of sittings 3 to 13. Every
other section is for the release build (Phase 12's works with either), and the ones that need adb
before the first unlock after a restart, or "maintenance", come before sitting 12 locks debugging.

## Sitting 0: before the phone

The week before, at your computer: 2 to 4 hours, most of it the server.

1. **The server**, reachable over HTTPS from the phone on cellular and from claude.ai
   ([guide.md](guide.md#3-set-up-the-server), section 3): your parent account, the family's
   timezone, notifications on in your browser and on your own phone, the emergency card's numbers,
   and the backup passphrase. Phase 0 doesn't use it; Phase 1 does.
2. **The release key**, made once (Phase 0's [Before you
   start](phase0-checklist.md#before-you-start-two-decisions), 1): `android/scripts/make-release-key.sh`,
   then backed up as [signing.md](signing.md#back-it-up-before-using-it) says, with one test
   restore on another computer. Write down its certificate SHA-256.
3. **Your call: register Belay's package name** for developer verification (Before you start, 2),
   before any Belay build goes on the phone. The debug build has the same package name as the
   release build (`family.brooker.belay`), so sitting 2's debug build counts too.
4. **Google accounts:** the parent-owned account for this phone, not your main one and not a child
   account ([pixel.md](pixel.md#which-google-account)), made now: reset protection can take up to
   72 hours to accept a new account. And a made-up test account, for Phase 2 §5, which can be
   Phase 11's made-up kid account too.
5. **The phone:** bought as [pixel.md](pixel.md#buying-a-used-one) says, updated to the current
   Android 17, its line (SIM or eSIM) activated and working for calls, texts and mobile data, and
   charged.
6. **The computer:** JDK 21, the Android SDK (platform 37.0, the build tools, and platform-tools
   for `adb`) and a copy of this repository. Phase 0 uses `provision.sh`, sitting 2 builds the
   debug build, and many steps type `adb` commands. The [setup kit](setup-kit.md) can do the
   provisioning in sittings 3 and 14 instead, but not those steps: if you'll use it, build its image
   ahead (it downloads several GB).
7. **Claude:** an account, on the web and in the app on your phone. Phase 1 §4 connects it.
8. **For later sittings:** a second phone that can call and text (a parent's is fine), a third
   phone for one step (Phase 5 §11.9), a second Android phone with Chrome and a hotspot (Phases 12
   and 13; it can be the second phone), a laptop, and a stopwatch. If you have them: an iPhone or
   iPad, a Bluetooth headset or car, and a second SIM or an eSIM.

## Sitting 1: Phase 0's first day

Day 1, about an hour.

**Your decision:** Phase 0 puts the **release build** on as device owner: its question is whether
a real Pixel 8 takes that build over adb, Play Protect and all. Only a factory reset removes it; a
reset from Settings works (nothing before sitting 12 locks factory reset), and Phase 0 §4 makes
one. `provision.sh` asks before it makes Belay the device owner.

**Have ready:** the Pixel, factory-fresh; the computer, with the release key's password; a USB-C
cable that carries data; Wi-Fi.

**Run:** [Phase 0](phase0-checklist.md) §1, then §2, items 1 to 6. Then leave the phone for about
a day on Wi-Fi, overnight included.

**Stop point:** if `dpm set-device-owner` refuses Belay (§1), or Belay isn't device owner in §2,
stop there: the plan changes (Phase 0's stop condition, platform notes P2). Send the results. A
reset from Settings gives you the phone back.

**Record:** Phase 0's table in platform-notes.md: Play Protect's prompt word for word (or none),
the `dpm set-device-owner` line, the Result lines, the Android build.

## Sitting 2: the rest of Phase 0, then the debug build

Day 2, about 3 hours: 45 minutes of Phase 0, then about 2 hours with the debug build.

**Have ready:** as in sitting 1; the release APK at an HTTPS address (Phase 0 §4.1); the
parent-owned account; your own phone, which texts the Pixel and can turn RCS (chat features) off
and on; a third phone, if you have one, for one optional message. No server is needed.

**Run:**

1. [Phase 0](phase0-checklist.md) §2, items 7 and 8. **Stop point:** as in sitting 1, if Belay is
   no longer device owner after the day.
2. Phase 0 §3 and §4. §4 resets the phone from Settings and tries QR provisioning: if it
   provisions Belay, that's news (platform notes P1): note every screen, finish setting up, and
   reset from Settings again. Either way the phone ends freshly reset. **Send Phase 0's results
   now:** Phase 1 starts from them.
3. **The debug build, for texts' one test:** [Phase 5
   §12](phase5-checklist.md#12-texts-one-test-google-messages-archival-t8-with-the-debug-build)
   (T8), about an hour and a half. Set the phone up as in Phase 0 §1.2 and 1.3 (Wi-Fi, no Google
   account, USB debugging), build the debug build (`(cd android && ./gradlew :app:assembleDebug)`),
   and run `android/scripts/provision.sh --debug` without `--server`: the test needs no server.
   Calls stay off for the whole section (with no server, they are). If §12.1 needs Google Messages
   updated from the Play Store, add the parent-owned account for it; the reset in step 6 takes it
   off again.

   **Stop point, for texts:** §12 ends in one of three outcomes. Archival works: texts get the
   design's Option A. Updates come but RCS can't be read: Option A covers SMS and MMS only. Google
   Messages doesn't call Belay: the family chooses between Belay as the default SMS app (Option B,
   SMS and MMS only) and no text monitoring. Write down which, and send §12's results. Nothing in
   the later sittings waits on it: texts aren't built.
4. `android/scripts/unprovision.sh`: the debug build comes off without a reset.
5. Optional, [Phase 6
   §5](phase6-checklist.md#5-provisionsh-on-a-phone-with-androids-parental-controls-optional),
   on a phone you're about to reset anyway: remove the parent-owned account if you added it (the
   dry run stops at accounts before it looks for Parental Controls), set up Android's own Parental
   Controls in Settings, then run `android/scripts/provision.sh --dry-run`. If Settings won't set
   them up without an account, leave this one out.
6. Factory reset from Settings, keeping the eSIM.

**Record:** Phase 0's table; Phase 5's rows 12.1 to 12.8 and the outcome; Phase 6's row 5.

## Sitting 3: the release build, and Phase 1

Day 3, about 3 hours, one of them with the phone off.

**Your decision:** the release build goes on as device owner again, this time for the weeks of
sittings ahead (and, if you skip sittings 12 and 13, for your kid). Only a factory reset removes
it.

**Have ready:** the server, and your parent account; Claude on the web and on your phone; the
computer with the release APK (Phase 0's, or a new build with the same key and version code), or
the setup kit; the USB cable; the parent-owned account's password.

**Run:** [Phase 1](phase1-checklist.md) §1 to §5.

- §1 sets the phone up as [pixel.md](pixel.md#setting-it-up) says, steps 1 to 7: the
  parent-owned account goes on after Belay. With `provision.sh`, or with the setup kit's page: a
  factory-fresh Pixel 8 set up from desktop Chrome is Phase 8's check by hand ([the design's test
  plan](design/phase8-setup-without-sdk.md#test-plan)). With the kit, run `adb kill-server` first
  (the page can't open the phone while adb holds it), and note your computer's system, Chrome's
  version, and whether the page found the phone again after its restart.
- §3 needs the phone off for over an hour: do §4 meanwhile, since Claude only reads the server.
- §1's QR scan from Belay's own screen needs a phone that isn't connected: do it at §5.3, scanning
  the reconnect code's QR code from Belay's screen instead of running `provision.sh` again (§1
  already ran it).

**Record:** Phase 1's table, and the setup kit's lines for platform notes X1 if you used it.

## Sitting 4: Phase 2, without hardening

Day 4, about 3 hours.

**Have ready:** Phase 2's [Before you start](phase2-checklist.md#before-you-start): the
parent-owned account on the phone, the line working, and Play's parental controls (with a PIN) and
purchase authentication, which you set in Play yourself. Also Claude; a number to call during the
pause (your own phone, never 911); the made-up test account (§5); the home Wi-Fi's password (§7);
and, if you like, a café or hotel with a sign-in page (§7.10).

**Run:** [Phase 2](phase2-checklist.md) §1 to §5, then §7, with protection on and before hardening,
as §7 says.

- In §5, Play's accounts come before the account lock, as it says. If you'll try Phase 5 §9.3 with
  an eSIM as the second line, add that eSIM before the SIM lock: afterwards none can be added.
- §6 (hardening) and the last sentence of §7.6 wait for sitting 12.

**Record:** Phase 2's table; its row 6 waits for sitting 12.

## Sitting 5: Phase 3, screen time

Day 5, about 3.5 hours, then a night.

**Have ready:** a stopwatch; a game; an app that plays video in picture-in-picture, and two apps for
split screen; your own phone, in the Pixel's contacts, to call; an approved app with voice or video
calls (§3.5); a keyboard app that isn't the phone's own (§8.2); the computer with adb.

**Run:** [Phase 3](phase3-checklist.md) §0 to §5, then §8. In the evening, §6.1: use up a daily
limit and leave the phone idle overnight.

- §0.1 is for a phone provisioned before Phase 3. This one had `force-lock` from its first install,
  so write "n/a" for 0.1, as its note says, and do §0.2 and §0.3.
- Network logging (§7) stays off until sitting 6: §6.2's day is measured without it.
- §8.1: look, don't trigger Emergency SOS.

The next day is §6's: in the morning, the check in §6.1; then carry the phone as usual, with
location and network logging off, and in the evening note Belay's battery use (§6.2). Keep that
number: Phase 4 §6 ("off") and Phase 13 §6 compare with it.

**Record:** Phase 3's table.

## Sitting 6: network logging

Day 6, in the evening, about an hour and a half.

**Have ready:** a browser on the Pixel; your own phone, to call and text (§7.3); the computer with
adb (`adb shell dpm force-network-logs` saves §7.2's 90-minute wait).

**Run:** Phase 3 §6.2 (the day's battery use), then §7.1 to §7.3. Leave logging on: the next day is
§7.4's.

## Sitting 7: the end of network logging, and Phase 4

Day 8, about 4 hours, some of them outdoors.

**Have ready:** a clear sky; a place to walk out of and back into (§3.2: 100 m, with a made-up
name) and another 2 km away; something to time the fixes with; Claude, with the AI
category "location" on for §1.5; the computer with adb.

**Run:** Phase 3 §7.4 to §7.6, then turn network logging off again (§7.6 leaves it on). Then
[Phase 4](phase4-checklist.md) §0 to §5.

- Phase 4 §0.1's update is already done: today's build has every phase.
- §3.1's hour of periodic fixes is the time to walk §3.2.

Then Phase 4 §6's two days: day 9 with location on demand and 5 checks, day 10 periodic every 30
minutes all day (sitting 5's day was "off"). Run no other sitting on those days: it would spoil
their numbers.

**Stop point:** Phase 3 §7.6. A name under Chrome that isn't one of 988's own (a chat provider's)
would need adding to 988's list on both sides (`core/network/Domains.kt` and the server's
`family/network/store.ts`), so it's never kept. Send it at once, and don't rely on network logging
until it's added.

**Record:** Phase 3's rows 7.4 to 7.6; Phase 4's table.

## Sitting 8: Phase 7, then Phase 5's calls

Day 11, about 4 hours.

**Have ready:** location on (Phase 7 §5.1); the second phone, to call from and to call (as a
contact with a made-up name); the computer with adb; if you have them, a Bluetooth headset or car
and two SIMs (Phase 5 §9).

**Run:** [Phase 7](phase7-checklist.md) §1 to §6, then [Phase 5](phase5-checklist.md) §1 to §10,
then Phase 5 §13 (Gemini in Google Messages, about 15 minutes).

- Phase 7 §1.1 needs each state in turn: a pause, a bedtime, a limit used up, lost mode. Set each
  from the parent page.
- Calls go on for the first time here, after the archival test (which needs Belay not to be the
  phone app).

**Record:** Phase 7's table; Phase 5's rows 1.1 to 10.2, and 13.1 to 13.6.

## Sitting 9: the callback window, with caregivers in its waits

Day 12, about 4 hours, half of them waiting.

**Have ready:** the second phone, not a contact, with full signal on both phones; a third phone you
can answer (§11.9); the computer with adb. For Phase 12: the second phone's Chrome, as the
caregiver's (never signed in as a parent); an iPhone or iPad if you have one; the Pixel's own
number on its Location and help tab, and location on demand.

**Run:** Phase 5 §11.1 to §11.7. §11.6's calls open a 2-hour callback window: in that time, do
[Phase 12](phase12-checklist.md) §0 to §5 (§5.2's hour fits in it too). Then Phase 5 §11.8 and
§11.9, both at least 2 hours after §11.6.

**Stop point, for safety:** in §11, if the second phone doesn't ring within a few seconds, or either
phone says anything about an emergency, hang up at once, clear the test number (`-c`) and stop
§11, as it says. Send what happened, and carry on with Phase 12.

**Record:** Phase 5's rows 11.1 to 11.9; Phase 12's table.

## Sitting 10: Phase 13, mobile data

Days 13 and 14, about 3 hours spread over both. Start in the morning.

**Have ready:** the Pixel's mobile data on; two test apps (a video app the family doesn't use, and
another app that uses the internet); the second Android phone's hotspot; a laptop; an iPhone's
hotspot, if you have one; a few megabytes of the family's data plan; Claude (§5.2, §5.6); the
computer with adb.

**Run:** [Phase 13](phase13-checklist.md) §0 to §4, and §5.1 and §5.2's morning use; then the
Mobile data tab after noon and after 6 PM (§5.2, §5.3). The next morning, §5.4 to §5.6. §5.6
leaves two apps Wi-Fi only with measuring on, as §6 asks, so §6's day comes next, and §5.7 and §7
after it.

**Record:** Phase 13's table. Its last line says where else each confirmed step goes: its Q entry
in platform-notes.md, with "Pixel" and the date.

## Sitting 11: Belay updates itself, and Android's own Parental Controls

Day 15, about 2 hours.

**Have ready:** the computer, with the release key for two builds, and adb; Wi-Fi, then cellular
for §2.5; Android's own Parental Controls to set up, with a PIN (§4).

**Run:** [Phase 6](phase6-checklist.md) §1, §2 and §4 (§3 needs hardening, in sitting 12; §5 was
sitting 2's). §2.1 and §2.5 each need a build with a higher `versionCode` (in
`android/app/build.gradle.kts`). Keep every APK you build: the phone only ever takes a higher
version.

**Stop point:** Phase 6 §2.4. If Android refuses the update (developer verification), write its
words down: updates then go over adb, with `provision.sh` in maintenance mode
([guide.md](guide.md#updating), section 8), and the plan for updates changes. Send it.

**Record:** Phase 6's rows 1, 2 and 4.

## Sitting 12: your decision: hardening

Day 16, about an hour, then 5 minutes a day later.

**Your decision, three times:** Phase 2 §6 locks factory reset, locks developer options and USB
debugging, and sets reset protection with the parent-owned account. "It can lock the phone for good
if something goes wrong" (Phase 2 §6), and [the guide](guide.md#later-not-today-hardening) suggests
turning them on once the phone has worked well for a few weeks. Sittings 12 and 13 check, on this
phone and before your kid has it, that the recovery key and the hand-over undo them. If you'd
rather not lock them yet, skip both and go to sitting 14: Phase 6 §3 then waits until you lock
them, and Phase 11 until the real hand-over.

**Have ready:** the parent-owned account's password, and its Google account id (the parent page
says how to find it); a printer or your password manager, for the recovery key; the computer with
adb.

**Run:** Phase 2 §6: don't test a recovery-mode reset unless you're ready to sign in with that
account afterwards. Then the last sentence of §7.6: wireless debugging can't be turned on now. Then
Phase 6 §3, without factory resetting the phone; §3.7 is the next day.

**Record:** Phase 2's row 6 and §7's wireless debugging row; Phase 6's rows 3.

## Sitting 13: your decision: the hand-over

Day 17, about 2 hours, after Phase 6 §3.7.

**Your decision:** Phase 11 ends this setup for good. The hand-over lifts the locks and reset
protection, the phone is reset and set up with the made-up kid account, and Belay is gone. Setting
it up again starts from pixel.md (sitting 14).

**Have ready:** hardening on and applied (sitting 12); the made-up kid account; Google Photos on
another device or the web; Claude (§1.3); the computer with adb, which needs maintenance mode now.

**Run:** [Phase 11](phase11-checklist.md) §0 to §6. §6.1 waits for the phone to show as silent: set
"Report a phone as silent after" to 1 hour, as in Phase 1 §3, and back to 12 afterwards.

**A result for your decisions:** §5.4. If the setup wizard asks for the parent-owned account after
the hand-over's reset, reset protection wasn't cleared as platform notes O1 expects. Send it before
you decide on reset protection for your kid's phone.

**Record:** Phase 11's table.

## Sitting 14: your kid's phone

Day 17 or 18, 2 to 3 hours, the last hour with your kid.

**Your decision:** the release build as device owner, for your kid's phone.

After sitting 13: factory reset from Settings (keeping the eSIM), and set the phone up as
[pixel.md](pixel.md#setting-it-up) says, with a new Add a phone, using the newest APK you kept (the
highest version code: the next update has to be higher). With the setup kit, this is another of
Phase 8's checks by hand, on another computer if you have one. Then
[guide.md](guide.md#6-the-first-day) section 6, the first day, together with your kid. Hardening
comes later, and it's your decision ([guide.md](guide.md#later-not-today-hardening)).

If you skipped sittings 12 and 13, the phone from sitting 3 is set up already. Put its rules back to
what you want for your kid (calls, contacts, caregivers, Wi-Fi-only apps, measuring, location,
network logging), take off the test contacts and caregivers, and go on with the first day. Or start
clean: on the phone's page, Disconnect this phone and Delete this phone, reset it from Settings, and
set it up as above.

## Stop points, and the results designs wait for

| Sitting | Section | Result | What changes |
|---|---|---|---|
| 1, 2 | Phase 0 §1, §2 | The Pixel refuses Belay as device owner over adb, or drops it | **Stop.** The plan changes (P2). |
| 2 | Phase 5 §12 | Archival works; or SMS only; or Google Messages doesn't call Belay | The texts design: Option A; Option A for SMS and MMS; or Option B or no text monitoring, the family's choice (T8). |
| 7 | Phase 3 §7.6 | A name that isn't 988's own, on 988's chat page | It goes on 988's list on both sides before network logging is relied on. |
| 9 | Phase 5 §11 | The second phone doesn't ring at once, or a phone mentions an emergency | **Stop §11**, clear the test number. |
| 11 | Phase 6 §2.4 | Android refuses Belay's own update | Updates go over adb in maintenance mode (I3). |
| 13 | Phase 11 §5.4 | The setup wizard asks for an account after the hand-over | Your decision on reset protection (O1). |

And results that answer open questions, with nothing to stop for: Phase 0 §4 (QR provisioning,
P1), Phase 3 §0.3 (Android's flags, from the screen-time design), Phase 5 §12.5 (an RCS group chat,
the texts design's first question), and Phase 13 §3.5 (an iPhone's hotspot) and §4.1 (the download
manager, Q9), both in the mobile data design.

## What to send back

Send each checklist's Results table, filled in, once its sittings are done, and Phase 0's at once:
it's the gate for everything after. Paste it to Claude, or edit the tables in a pull request. With
them, the platform notes' "Verified on" entries get "Pixel 8" and the date, and the guide's "Not yet
checked on a Pixel" notes can go.

Send:

- the words Android, Belay, Play, Chrome, Google Messages and the carrier showed, word for word;
- the Android build, and the versions a checklist asks for (Play's, Chrome's, Google Messages');
- times, counts, distances and battery use, and which app did what (the packages of the apps that
  came with the phone, and of the test apps you installed);
- for the setup kit, your computer's system, Chrome's version, and what the page said.

Never send, and never put in the repository: screenshots of the phone, account names or email
addresses, phone numbers, serial numbers or IMEIs, coordinates, addresses or place names, Wi-Fi
network or carrier names, your kid's real apps or times, or anything from a text or a call. Write
"the second phone", "matched" or "40 m", never who or where.
