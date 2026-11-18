# Phase 13 checklist: mobile data on the Pixel 8

CI proves the debug build's side on the Android 17 emulator: a Wi-Fi-only app reaches Android's
list for Belay (`getMeteredDataDisabledPackages`) and the report, the phone app never does, an
empty list clears it, measuring reads Android's accounting as device owner, and Room's database
migrates from version 7 (`MobileDataInstrumentedTest`, `MigrationInstrumentedTest`); end to end,
the server's `wifi-only` reaches Android's admin dump (`meteredDisabledPackages=[…]`) and
`--remove` empties it, and `mobile-data --measure on` gets a day to the server
(`ci-emulator-test.sh`). Only a real phone shows an app actually losing mobile data, what the kid
sees, a hotspot, Wi-Fi marked metered, real byte counts, and the battery. This checklist is for
the real Pixel 8 with the **release** build and a real SIM with mobile data.
[platform-notes.md](platform-notes.md) Q1 to Q9 say what each step expects, as read in AOSP.

Use made-up apps where you can (any free video app the family doesn't use will do), a made-up kid
account, and the family's own data plan only for a few megabytes. Record what you see in the table
at the end: no screenshots in the repository, and no phone numbers, network names or account names.

## 0. Before

1. The phone runs the release build as device owner, connected to the server, with a SIM whose
   mobile data works (Settings, Network and internet, SIMs: Mobile data on). Note the carrier's
   name in your notes only, not here.
2. Two test apps installed and allowed: a video app (call it "the video app") and any second app
   that uses the internet ("the other app"). Note their package names.
3. A second Android phone whose hotspot you can turn on, and, if you have one, an iPhone's
   hotspot.
4. On the parent page, the phone's **Mobile data** tab: no app is Wi-Fi only, measuring is off.

## 1. Wi-Fi only, on mobile data

1. Turn the phone's Wi-Fi off, so it's on mobile data. Open the video app: a video plays.
2. On the Mobile data tab, make the video app Wi-Fi only. Within seconds the tab says "On the
   phone: it can't use mobile data." Note how long it took.
3. On the phone: the video app now acts as if there's no internet (write down exactly what it
   shows: an error, a spinner, an offline screen). The other app still works. Android posts no
   notice of its own (Q4).
4. Belay on the phone, This phone's rules: "Some apps work only on Wi-Fi.", naming the video app,
   and the Wi-Fi only card with "Wi-Fi only: your parent chose this". Read it aloud with a
   12-year-old in mind; write down anything unclear.
5. Make a call and send a text (to a parent's phone): both work. Open the texting app: RCS chats
   still send (the texting app is never Wi-Fi only).
6. Try to make the texting app and the phone app Wi-Fi only on the parent page (type their package
   names): both are refused, with why.

## 2. What the kid can't undo

1. Settings, Apps, the video app, Mobile data & Wi-Fi: "Background data" and "Unrestricted data
   usage" show "Disabled by admin" (Q4). Tap one: Android's admin dialog, with Belay's support
   message. Write down its exact words.
2. Turn Data Saver on, then off: the video app still has no mobile data.
3. Settings, System, Reset options, Reset app preferences: the video app still has no mobile
   data. Then Reset mobile network settings (it forgets saved Wi-Fi networks: note them first):
   the video app still has no mobile data (Q5).
4. Uninstall the video app and install it again (it may get a new uid): within a minute or two
   of the install, it has no mobile data again (Belay calls Android again for the new uid, Q2).
   Note how long it took.

## 3. Other networks

1. Turn Wi-Fi on, on the home network: the video app works.
2. Join the second Android phone's hotspot: the video app has no network (an Android hotspot says
   it's metered, Q3). The other app works. Note what Settings, Wi-Fi, the hotspot's network,
   Network usage says (Detect automatically / metered).
3. On that network, set Network usage to "Treat as unmetered": the video app now works, using the
   hotspot's data (the threat model's open gap). Set it back to "Detect automatically".
4. On the home Wi-Fi, set Network usage to "Treat as metered": the video app has no network. Set it
   back.
5. If you have an iPhone: join its hotspot. Does the video app work? Write down what Settings says
   about the network's usage (an iPhone's hotspot may not say it's metered: the design's open
   question).

## 4. What Wi-Fi only doesn't cover

1. With the phone on mobile data, start a download in the video app that it hands to Android's
   download manager, if it does (a notification from "Download manager" shows it), or in a test
   app that does. Does the download use mobile data (Q9)? Write down what you saw.
2. Play Store, an update for the video app over mobile data: does it download? (Updates are Play's
   traffic, not the app's.) Then make Google Play (`com.android.vending`) Wi-Fi only and try again.

## 5. Measuring

1. On the Mobile data tab, turn measuring on. Within seconds the phone's "What your parent can
   see" lists "How much mobile data apps use", with its lines. Read them aloud; write down anything
   unclear.
2. Use the other app on mobile data for a few minutes (a few megabytes). Within about an hour and a
   half, the tab shows today's bar and the table row: mobile data, Wi-Fi, the top app. Compare with
   Settings, Network and internet, SIMs, App data usage, for today: note both numbers. They can
   differ a little at the day's edges (Android's 2-hour buckets, Q7).
3. The day's apps: "Android, calls and texting" is one line; the phone app and texting never appear
   by themselves, even after a call and a text. Turn the phone's hotspot on, connect a laptop for a
   minute: "Other devices, through this phone's hotspot" shows after the next report.
4. The next day, 2.5 hours after midnight or later: yesterday's row says the whole day (not "so
   far"), and doesn't change after that.
5. The video app is Wi-Fi only: if it used any mobile data on a day that began after you added it
   (the download in section 4), it's flagged "Used mobile data". Note whether it was.
6. Ask the AI app (Claude) which apps used the most mobile data this week; then to make the other
   app Wi-Fi only (it applies at once); then to let the video app use mobile data again (it's a
   proposal on the Proposals page: reject it). Then ask it to turn measuring off: it can't.
7. Turn measuring off: "What your parent can see" loses it within seconds, and the tab says the
   days kept stay until they're 90 days old.

## 6. Battery

1. With measuring on and two apps Wi-Fi only, leave the phone a day in ordinary use. Settings,
   Battery, Battery usage: note Belay's share. Belay reads Android's accounting about hourly, and
   only when a step runs: no new wakeups (compare with a day before Phase 13, if you noted one).

## 7. After

1. Make no app Wi-Fi only, and turn measuring off. Over adb in maintenance mode:
   `adb shell dumpsys device_policy` shows `meteredDisabledPackages=[]` under Belay's admin, and
   `adb shell dumpsys netpolicy` lists no uid under "Admin restricted uids for metered data".

## Results

| Step | Seen on the Pixel (date, build) | Notes |
|---|---|---|
| 1. The app loses mobile data; calls, texts and RCS work | | |
| 1. The kid's words | | |
| 2. "Disabled by admin"; Data Saver, resets don't undo it | | |
| 2. Reinstalled: restricted again, how soon | | |
| 3. An Android hotspot is metered; "Treat as unmetered" lifts it | | |
| 3. An iPhone's hotspot | | |
| 4. The download manager; Play's updates | | |
| 5. The numbers against Settings' | | |
| 5. Calls and texts never on their own line; the hotspot's line | | |
| 6. Battery | | |

When a step is confirmed, update its entry (Q1 to Q9) in [platform-notes.md](platform-notes.md)
with "Pixel" and the date.
