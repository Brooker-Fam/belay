# Phase 4 checklist: location on the Pixel 8

CI proves the phone's side on the Android 17 emulator: with location on demand and `keep_on`,
Belay holds location by policy and the kid can't turn it off; `locate-now` gets a fix from the
emulator's GPS (`adb emu geo fix`) at the right point, not a mock, and is reported done; a help
request carries a shared fix; and turning location off takes the permission away (Android restarts
Belay, which comes back). This checklist is for the real Pixel 8 with the **release** build: real
satellites, indoors and outdoors, Google's location settings, a day of battery, and what Android
shows the kid. Do [phase3-checklist.md](phase3-checklist.md) first.

Record what you see in the table at the end. Write Android's and Belay's words word for word.
No screenshots in the repository, and no coordinates, addresses, place names, account names,
phone numbers or serial numbers: write "matched" or the distance, not where.

## 0. The update

1. Update Belay to the Phase 4 version (the parent page's update, or `provision.sh` in
   maintenance mode). No restart is needed for location.
2. With location off on the parent page: Settings > Apps > Belay > Permissions > Location says
   Belay isn't allowed, and that the setting is controlled (write down the words). Tapping it
   can't change it.

## 1. On demand

1. On the parent page, set location to "on demand". Within seconds Android shows its own notice:
   write down its title and text (expected: "Belay has location access" / "Your organization
   allows Belay to access your location", platform notes L1). Settings > Apps > Belay >
   Permissions > Location now says allowed (all the time?), and can't be changed.
2. "What your parent can see" on the phone lists "Where this phone is"; the Location card says
   "Your parent can check where this phone is. You get a notification every time they do."
3. Outdoors, with a clear sky: "Check now". Time it from the tap to the fix on the parent page,
   and write down the accuracy and how far it is from where you stand (not the coordinates). The
   kid's notice: "Your parent checked where this phone is (…)." Does the status bar's location
   icon show while it looks (L6)?
4. Indoors, away from windows: "Check now" three times. How many found a fix, how long each took,
   and the accuracy. A miss shows "No GPS fix in 60 seconds." on the parent page.
5. Ask the parent's AI app to check where the phone is (with the AI scope "location" on): the
   kid's notice names the app ("…, using Claude.").
6. The phone's "What Belay told your parent" lists each check of steps 3 to 5, and the Location
   card counts them.

## 2. Keep location on

1. Turn `keep_on` on. Pull down Quick Settings: what does the Location tile do when tapped? In
   Settings > Location, is the switch greyed out, and what does it say? Write both down.
2. Turn `keep_on` off, then turn location off in Quick Settings. Within a minute the parent page
   says location is off. "Check now" fails with "Location is turned off in the phone's settings…".
3. With location off in Quick Settings, turn `keep_on` on again: location turns on by itself.
   Write down Android's notice (expected: "Apps can access your location", L2).

## 3. Periodic, and places

1. Set periodic, every 15 minutes, between hours that include now. The managed notice says
   "Shares where this phone is every 15 minutes, … to …." Leave the phone for an hour: the parent
   page has about 4 fixes, and none outside the hours.
2. Name a place around where you are (100 m), and one 2 km away. Walk out of the first and come
   back: the parent page records "left" and then "arrived" for it, once each, and nothing for
   the other. How long after you crossed the edge did each come (fixes come sooner near an edge,
   at least every 5 minutes)?
3. Stand right at the place's edge for 20 minutes: no flapping "arrived"/"left".
4. With `adb shell dumpsys location` (maintenance mode): which packages serve "network" and
   "fused" (L3)? Is "gps" listed with any assistance (SUPL, PSDS) that reaches the network?

## 4. Fused

1. Set the provider to "fused". Indoors, "Check now" three times: time and accuracy each. Compare
   with section 1's indoor GPS.
2. Back to "gps" with "fallback_fused": indoors, where GPS misses, the check comes from "fused"
   within the minute.

## 5. Lost mode

1. Turn lost mode on with a message. The screen locks once; the lock screen shows the message
   (where? write down how it looks); the phone takes a fix every 5 minutes; the kid's ongoing
   notice says "This phone is in lost mode…". Location can't be turned off.
2. Turn lost mode off: the message goes from the lock screen, the notice goes, and with location
   mode "off" Belay loses the permission again (Settings shows it) and restarts once (the managed
   notice comes back by itself within a minute).

## 6. Battery

1. A full day in each mode (off, on demand with 5 checks, periodic every 30 minutes all day):
   Settings > Battery > Belay's use, and the phone's total. Write all three down.

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 0.2 | Location not allowed and controlled, with location off | pending | |
| 1.1 | Android's notice when location is granted (words) | pending | |
| 1.3 | Outdoor fix: time, accuracy, distance; the kid's notice; the status bar icon | pending | |
| 1.4 | Indoor GPS: fixes found of 3, times, accuracy | pending | |
| 1.5 | The kid's notice names the AI app | pending | |
| 2.1 | Quick Settings tile and Settings with keep_on (words) | pending | |
| 2.3 | Android's notice when Belay turns location on (words) | pending | |
| 3.1 | Periodic fixes within the hours | pending | |
| 3.2 | Left and arrived, once each, and how soon | pending | |
| 3.3 | No flapping at the edge | pending | |
| 3.4 | Packages serving "network" and "fused"; GPS assistance | pending | |
| 4.1 | Fused indoors: times, accuracy | pending | |
| 4.2 | Fallback to fused | pending | |
| 5.1 | Lost mode: lock, message, fixes every 5 minutes | pending | |
| 5.2 | Lost mode off: all of it back, one restart | pending | |
| 6.1 | Battery per mode for a day | pending | |
