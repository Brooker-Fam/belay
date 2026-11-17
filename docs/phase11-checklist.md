# Phase 11 checklist: off belay on the Pixel 8

CI proves the debug build's side on the Android 17 emulator: with a policy that hands the phone
over, Belay holds none of the hand-over's locks, says it left reset protection alone (a debug
build never sets it), and Home shows the hand-over (`HandoverInstrumentedTest`); end to end, the
server's `handover` reaches the phone and its debug state shows it carried out, before the restart
and `unprovision.sh` (`ci-emulator-test.sh`). This checklist is for the real Pixel 8 with the
**release** build: a full hand-over, ending in a reset from Settings and a setup with a different
Google account. Do [phase2-checklist.md](phase2-checklist.md) first, with hardening on.

**This ends the test phone's setup for good.** Afterwards Belay is gone and the phone is set up
with another account; provisioning it again means starting from [pixel.md](pixel.md). Use a
made-up kid account, never a real kid's. Record what you see in the table at the end: no
screenshots in the repository, and no account names, phone numbers or serial numbers.

## 0. Before

1. The phone runs the release build as device owner, connected to the server, with protection on
   and hardening on: factory reset and debugging locked, reset protection with the parent-owned
   account's id, and accounts locked. The phone has applied those rules (its page says so).
2. In maintenance mode, over adb: `adb shell dumpsys device_policy` and find the factory reset
   protection entry under Belay's admin. Write down its exact text (the account ids: just "an id",
   not the number).
3. Have a made-up Google account ready for the kid: a different one from the parent-owned account.

## 1. The last stage, from the first day

1. On the Stages page, Off belay is last, says "The last stage: it blocks nothing", and has no
   delete button. Write "When you turn 16" as its words and save.
2. On the phone, My stage: with the phone on a stage, Off belay is the last card, with those words
   and what "off belay" means. On the stage just before Off belay, the card says it's the next and
   last one. Write down the words exactly.
3. Ask the AI app (Claude) to move the phone to Off belay. It says only a parent can, and nothing
   waits on the Proposals page.

## 2. Stop blocking

1. On the phone's Screen-time rules tab, move it to Off belay: its limits and schedules go within
   seconds.
2. Turn protection off on the phone's page (new apps run without asking, no web filter). My stage
   now says "Belay isn't blocking any apps or websites on this phone any more." Note how long it
   took, and that it doesn't show while anything is still held back or filtered.

## 3. Stop collecting

1. On the phone's page, under "What the server keeps about this phone", stop each category in turn:
   screen time, where the phone is, apps, requests. Each confirmation lists what goes; check it
   against the phone's pages before confirming.
2. After each: the phone's pages show it gone, and the phone's "What your parent can see" loses
   screen time and location within seconds (apps and requests stay listed: the phone still sends
   them). The Activity page has a line for each stop.
3. My requests on the phone still shows each answered request as answered, not as waiting.

## 4. Hand over

1. On the phone's page, "Hand this phone over": typing a wrong name refuses it; the phone's name
   hands it over. Within seconds the phone's Home starts with "This phone is becoming yours" and the
   steps. Read them aloud with a 12-year-old in mind; write down anything unclear.
2. The parent page says "The phone has it" with the rules version it applied.
3. In maintenance mode, or with debugging now unlocked, `adb shell dumpsys device_policy`: the
   factory reset protection entry is gone (or empty); write down its exact text. `adb shell
   dumpsys user`: no `no_factory_reset`, `no_debugging_features` or `no_modify_accounts`.
4. Settings > System > Reset options > Erase all data is there and not greyed out. Write down the
   exact path on this Pixel to the accounts page, and that "Add account" and "Remove account" work.

## 5. Reset, together

1. Add the made-up kid account in Settings. Back up a test photo to it (Google Photos), and check it
   arrived from another device or the web.
2. Remove the parent-owned account (write down the exact path).
3. Settings > System > Reset options > Erase all data (factory reset). Keep the eSIM if asked.
4. The setup wizard: does it ask for any Google account to verify the phone (reset protection)?
   Write down exactly what it asks. Set it up with the made-up kid account: it works.
5. The phone has no Belay, no "This phone is managed by your organization", and Play uses the kid's
   account. The test photo is in the kid's Google Photos.

## 6. Close the server side

1. The phone goes quiet on the parent page (silent after the family's threshold). Disconnect it,
   then "Delete this phone": it's gone from the phones and from `status --json`.
2. The Activity page still has the hand-over and the stops (with the phone's name gone).

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 0.2 | Reset protection entry before (exact text) | pending | |
| 1.2 | Off belay last on My stage, with the family's words; "next" on the stage before | pending | |
| 1.3 | The AI app can't move the phone to Off belay | pending | |
| 2.2 | "Isn't blocking any apps or websites": when it showed | pending | |
| 3.1 | Each stop's list matched what the pages showed | pending | |
| 3.2 | "What your parent can see" after each stop | pending | |
| 3.3 | Answered requests stay answered on the phone | pending | |
| 4.1 | Hand-over screen within seconds; words read aloud | pending | |
| 4.3 | Reset protection entry after; restrictions gone | pending | |
| 4.4 | Erase all data available; accounts path; add and remove work | pending | |
| 5.1 | Photo backed up to the kid's account | pending | |
| 5.4 | What the setup wizard asked after the reset | pending | |
| 5.5 | No Belay, no management notice, Play with the kid's account | pending | |
| 6.1 | Disconnect and delete | pending | |
