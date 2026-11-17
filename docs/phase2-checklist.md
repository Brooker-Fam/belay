# Phase 2 checklist: is the Pixel 8 safe to hand over?

Phase 2 is the milestone where the phone can go to the kid: new apps wait for a parent,
the web is filtered, and the settings that undo Belay are locked. CI proves the rules on
the Android 17 emulator; this checklist proves them on the real phone.

Do [phase1-checklist.md](phase1-checklist.md) first. Record what you see in the table at
the end, or paste it to Claude. Write messages word for word. No screenshots in the
repository, and no account names, phone numbers or serial numbers.

## Before you start

- The parent-owned Google account is on the phone (Settings > Passwords & accounts), and
  the phone line is active, SIM or eSIM. The account lock and the SIM lock come after both.
- In the Play Store, as the parent: Settings > Family > Parental controls on, with a PIN,
  and apps up to the rating you choose; Settings > Authentication > "For all purchases
  through Google Play on this device". Play has no setting Belay can turn on for you here.

## 1. Turn protection on

1. On the phone's page, turn protection on and read the summary.
2. Within a minute, Belay's screen on the phone shows the new rules, and the phone's page
   says the rules are applied.
3. Every app the kid already had still opens.

## 2. New apps wait for a parent

1. Install a free app from the Play Store.
2. Open it: Android says it's paused or blocked. Write down the exact words.
3. Open Belay: the app is under "Waiting for your parent". Write a reason and send it.
4. On the parent page, the request shows with the reason. Approve it. Within seconds, the
   app opens on the phone, and Belay shows "approved" with your note.
5. Install another app, and decline it with a note. The kid sees the answer and the note.
6. Ask Claude: "What is my kid asking for?" Ask it to approve the app: it can only
   propose; the proposal waits on the parent page until you approve it there.

## 3. Block and pause

1. Ask Claude to block an app the kid has. It disappears from the phone at once.
2. Pause the phone for 15 minutes with a note. Every app but the phone, texts and Belay
   stops opening; Belay shows the note and the time.
3. **During the pause, place a call to a test number and check that the dialer and
   emergency calling still open. Don't call 911.** Texting stays available too.
4. Resume from the parent page.

## 4. The web filter

1. In Chrome, search for something explicit: SafeSearch is on.
2. Open a site the family filter blocks (CleanBrowsing's test page, if it has one): it
   doesn't load.
3. Incognito is gone from Chrome's menu.
4. Settings > Network > Private DNS can't be changed.

## 5. What the kid can no longer change

- Safe mode (hold power off): it doesn't start in safe mode.
- Settings > System > Multiple users: can't add a user.
- Installing an APK from Files: blocked.
- Settings > Network > VPN: can't add one.
- Settings > System > Date & time: can't change.
- After the account lock: Settings > Passwords & accounts: can't add or remove accounts.
- After the SIM lock: can't add or switch an eSIM.

## 6. Hardening (only when you're ready)

Hardening blocks factory reset and USB debugging, and can set factory reset protection
with your Google account. **It can lock the phone for good if something goes wrong.**
Make sure you know the parent account's password, then:

1. Turn on "Block factory reset", typing the phone's name to confirm. Settings > System >
   Reset options is greyed out.
2. Turn on "Block USB debugging". `adb devices` no longer sees the phone. Maintenance mode
   for 1 hour brings it back; it goes away again on its own.
3. Factory reset protection: add your Google account id (the parent page explains how to
   find it). Don't test a recovery-mode reset unless you're ready to sign in with that
   account afterwards.

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 1 | Protection on: rules applied within a minute; existing apps still open | pending | |
| 2 | New Play app paused at once; Android's exact words | pending | |
| 2 | Request with reason on the parent page; approved app opens within seconds | pending | |
| 2 | Declined with a note: the kid saw it | pending | |
| 2 | Claude could only propose; approved on the parent page | pending | |
| 3 | Block from Claude: app gone at once | pending | |
| 3 | Pause: apps stop, phone and texts still work; resume | pending | |
| 4 | SafeSearch, a filtered site, no incognito, Private DNS locked | pending | |
| 5 | Safe mode, users, APK install, VPN, date/time blocked | pending | |
| 5 | Account lock and SIM lock | pending | |
| 6 | Factory reset greyed out; adb blocked and back in maintenance mode | pending | |
