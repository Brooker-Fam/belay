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
2. Open it: Android shows a dialog (titled "Blocked by work policy" in AOSP, with Belay's
   message). Write down the exact words.
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
- Play's accounts, before the account lock: on the phone's page (Hardening), list the
  parent-owned account's email address for Play and save. Add a second Google account to the
  phone (a test account), open the Play Store, and try to switch to it: Play shouldn't let it
  install anything. Write down what Play shows, word for word, and Play's version (Play Store >
  Settings > About). Remove the test account, then empty the list: the test account works in
  Play again.

## 6. Hardening (only when you're ready)

Hardening blocks factory reset and USB debugging, and can set factory reset protection
with your Google account. **It can lock the phone for good if something goes wrong.**
Make sure you know the parent account's password, then:

1. Turn on "Lock factory reset", typing the phone's name to confirm. Settings > System >
   Reset options is greyed out.
2. Turn on "Lock developer options and USB debugging". `adb devices` no longer sees the phone. Maintenance mode
   for 1 hour brings it back; it goes away again on its own.
3. Factory reset protection: add your Google account id (the parent page explains how to
   find it). Don't test a recovery-mode reset unless you're ready to sign in with that
   account afterwards.

## 7. Ways around Belay (only the real phone shows these)

From the audit in [platform-notes.md](platform-notes.md#getting-around-belay-the-phase-2-audit)
(H1 to H12). Do these with protection on and before hardening, except where it says. Have
the home Wi-Fi's password ready.

1. **Chrome's settings.** In Chrome, open `chrome://policy`: `ProxySettings` and
   `DnsOverHttpsMode` are listed with the others, status OK. Write down Chrome's version
   (`chrome://version`).
2. **A proxy.** Settings > Network & internet > Internet > the home Wi-Fi > the pencil >
   Advanced options > Proxy: Manual, host `192.0.2.1`, port `8080` (a test address nobody
   uses). Save. Within a minute the phone's page shows "Someone may be getting around Belay"
   with Belay's words about a proxy. Chrome still opens pages; write down whether an approved
   app's own browser does (it shouldn't, through a proxy that isn't there). Set Proxy back to
   None: the warning goes at the next check-in.
3. **Chrome rolled back.** Settings > Apps > Chrome > the menu > Uninstall updates. Open
   Chrome: `chrome://policy` still lists Belay's settings, OK; write down the version and any
   setting it marks unknown. Update Chrome from Play again. Then Settings > Apps > Chrome >
   Storage & cache > Clear storage: `chrome://policy` still lists them.
4. **Reset options.** Settings > System > Reset options > Reset Bluetooth & Wi-Fi, then join
   the Wi-Fi again: Settings > Network & internet > Private DNS still shows the filter and
   can't be changed. With screen time on, Reset app preferences: the phone's page says
   Belay's usage access is off, and Belay's screen asks to turn it back on. Try: write down
   whether Android lets you, or asks to allow restricted settings first.
5. **The time zone.** Settings > System > Date & time: "Set time zone automatically" is on
   and can't be turned off.
6. **Wireless debugging (before hardening).** Settings > System > Developer options >
   Wireless debugging, on: at Belay's next step (within the hour; opening Belay runs one) the
   phone's page shows Belay's words about wireless debugging. Turn it off: they go. After
   hardening, it can't be turned on.
7. **Pinning and picture-in-picture.** Settings > Security & privacy > More security settings
   > App pinning, on. Pin an approved app, then pause the phone from the parent page: the app
   closes and pinning ends. Write down what you see. The same with a video in
   picture-in-picture.
8. **The assistant during a pause.** With the phone paused, hold the power button (or say
   "Hey Google"): write down whether the assistant answers a question, which app answers
   (Settings > Apps > Default apps > Digital assistant app), and what happens when you ask it
   to open YouTube.
9. **Guests and in-app browsers.** Quick settings shows no user switcher, and Settings >
   System > Multiple users can't add a guest. A link to a site the filter blocks, opened in an
   approved app's own browser and in the Google app, doesn't load; a Google search in the
   Google app uses SafeSearch.
10. **The captive portal** (optional, at a café or hotel with a sign-in page): write down the
    sign-in app (Settings > Apps > show system apps: "Captive Portal Login" and its package
    name), and whether the page opens in Chrome or in its own window. Then pause the phone on
    the parent page, forget that Wi-Fi and join it again: write down whether the sign-in page
    still opens while the phone is paused (the threat model's captive-portal row).
11. **A parent's password on the kid's phone.** Have notifications on in your own browser or
    phone first (Settings → Notifications). On the Pixel, open Chrome, go to the server's address
    (Belay's screen shows it) and sign in with your own parent account. Within seconds your other
    browsers show "Belay: a new sign-in", "… signed in on Chrome on Android (…)": write down how
    long it took, and the words. Tap it: it opens Settings at that browser, under Your account.
    Sign the Pixel's browser out there, and check the Pixel's page asks to sign in again. Activity
    says "signed in on Chrome on Android" (the second bypass audit's B1).

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
| 5 | Play's accounts: another account refused in Play (Play's words, and its version); works again with the list empty | pending | |
| 6 | Factory reset greyed out; adb blocked and back in maintenance mode | pending | |
| 7 | `chrome://policy`: ProxySettings and DnsOverHttpsMode OK; Chrome's version | pending | |
| 7 | A Wi-Fi proxy: reported within a minute; Chrome still works; the report goes with it | pending | |
| 7 | After "Uninstall updates" and Clear storage, Chrome still has Belay's settings | pending | |
| 7 | Network reset keeps Private DNS; "Reset app preferences" turns usage access off (could it be turned on again?) | pending | |
| 7 | Time zone automatic and locked | pending | |
| 7 | Wireless debugging reported, and gone with it; not possible after hardening | pending | |
| 7 | A pinned app and picture-in-picture close when the phone pauses | pending | |
| 7 | The assistant during a pause: does it answer, which app, what "open YouTube" does | pending | |
| 7 | No guest; in-app browser and Google app filtered, SafeSearch on | pending | |
| 7 | The captive portal's app and window, and whether it opens while paused (optional) | pending | |
| 7 | A parent's sign-in from the Pixel's Chrome: the notice's words and how fast; it opens that browser's row; Sign out works | pending | |
