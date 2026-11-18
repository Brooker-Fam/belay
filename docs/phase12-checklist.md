# Phase 12 checklist: caregivers on the Pixel 8

The server's side is tested in CI: every capability on and off, every refusal (another phone, a
choice a parent didn't make, ended or expired access, a used link, a form without its CSRF token
or from another site), a walk of every other route with a caregiver's session, access ending at
its time and at once, the activity log, push to caregivers only, and the policy's `caregivers`,
`pause.caregiver` and `commands[].caregiver` ([design](design/phase12-caregivers.md)). The
phone's words come from `:core` (`kid/Caregivers.kt`, `DataCategories.caregiver`), tested on the
JVM. CI's emulator job (`ci-emulator-test.sh`) runs one caregiver end to end on the Android 17
emulator: the server's command line adds them with status, pause and help, and the phone's debug
state lists them with exactly that and their end, by its own clock; they join with the one-time
link and pause the phone from their page over HTTP (curl, with their cookie, the form's CSRF token
and a browser's Origin; one from another site is refused); the phone has the pause as theirs and
holds the fixture app for it; ending their access takes them off the phone's list and signs them
out, and a parent resumes their pause.

This checklist is for what only a real phone and real browsers show: the kid's screens with a
caregiver (the emulator checks what the phone lists, not the words on its screens, the largest
font or the pause notice), a caregiver acting from another phone's browser (pausing, locking the
screen, checking where the phone is), help notices on Android and iOS, and access ending at its
time by the phone's own clock.

Use made-up names ("Grandma", "Coach Lee"), a made-up kid and test phones. Record what you see in
the table at the end: no screenshots in the repository, and no names, numbers or serial numbers.

## 0. Before

1. The Pixel runs Belay as device owner (debug or release), connected to the server, with the
   kid's number set on its Location and help tab and location on demand.
2. A second phone (Android, Chrome) and, if you have one, an iPhone or iPad (iOS 16.4 or later),
   for the caregiver. Neither signs in as a parent.

## 1. Add a caregiver

1. On the parent page, Caregivers: add "Grandma" for the Pixel with the recommended choices
   (status, pause and lock, help requests), ending in 3 days. Copy the link; it shows once.
2. On the Pixel, within seconds: Home has "Your parent gave Grandma some access to this phone
   until …" and "What they can see and do"; What your parent can see has "Caregivers your parent
   added" with Grandma's lines; Help says "Grandma gets your help requests too, …". Read each
   aloud with a 12-year-old in mind; write down anything unclear.
3. Settings > Display size and text: the largest font and display size. Every caregiver line
   still reads whole, nothing cut off. Back to normal.

## 2. The caregiver, from another phone

1. On the second phone, open the link: it names the Pixel and what Grandma may do. Choose a
   username and a password; the caregiver page opens. The link doesn't work a second time.
2. The page shows the Pixel online, its battery and "Paused: No". Turn the Pixel's screen off
   for 10 minutes: the page says when it was last heard from.
3. Pause for 15 minutes. On the Pixel within seconds: Home's line, the pause banner and the pause
   notice say "Paused by Grandma"; apps are paused; calls, texts, 911 and 988 still work. Write
   down each wording.
4. "Pause and lock the screen now": the Pixel's screen locks once. Pausing for less than the
   pause on says nothing changed. There's no Resume for Grandma; resume it on the parent page.
5. On the parent page, Activity lists "Grandma (caregiver)" for the sign-in, the pauses and the
   lock.

## 3. Checking where it is

1. On the parent page, change Grandma: turn on "Check where the phone is now". The Pixel's card
   for Grandma gains "Can check where this phone is right now".
2. From the second phone, "Check where Alex's phone is now": the answer shows within a minute.
   On the Pixel, the notice reads "Grandma checked where this phone is (…)", and What Belay told
   your parent lists it under her name. Write down both wordings.
3. Turn location off for the Pixel: within seconds the Pixel's card no longer says Grandma can
   check, and the caregiver page says location is off.

## 4. Help requests

1. On the second phone, turn on notifications on the caregiver page. On the Pixel, tap "I need
   help" and add a few words: the second phone shows the notice at once (with the screen off
   too), and tapping it opens the caregiver page at its help requests, with the words and Call.
2. On the iPhone or iPad, sign in as Grandma in Safari: the page explains notifications need the
   Home Screen. Add it to the Home Screen, open it from there, turn notifications on, and repeat
   1. Write down what iOS asked and whether the notice came.
3. The request stays at the top of the parents' Requests page until a parent marks it seen; the
   caregiver page then says "A parent saw it".

## 5. Ending access

1. On the parent page, "End access now": the caregiver page signs out at its next load, the
   second phone gets no more help notices, and within seconds the Pixel's Home, Help and What your
   parent can see no longer list Grandma.
2. "Give access again", ending in an hour. Wait past the hour without opening the parent page:
   at that moment the caregiver page stops working, and the Pixel stops listing Grandma by its
   own clock, before the server's hourly clean-up (the Activity page shows that later).

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 1.2 | Home, What your parent can see and Help name Grandma; words read aloud | pending | |
| 1.3 | Caregiver lines at the largest font | pending | |
| 2.1 | The link works once; the join page says what Grandma may do | pending | |
| 2.3 | "Paused by Grandma" on Home, the banner and the notice (wordings) | pending | |
| 2.4 | Pause and lock locks once; shorter changes nothing; no resume | pending | |
| 2.5 | Activity lists Grandma's sign-in, pauses and lock | pending | |
| 3.2 | The check's notice and What Belay told your parent name Grandma | pending | |
| 3.3 | Location off: no check on the card or the page | pending | |
| 4.1 | Help notice on Android Chrome, screen off too; opens the request | pending | |
| 4.2 | Help notice on iOS from the Home Screen (what iOS asked) | pending | |
| 5.1 | Ended: signed out, no notices, the Pixel stops listing her | pending | |
| 5.2 | Access ends at its time by the Pixel's own clock | pending | |
