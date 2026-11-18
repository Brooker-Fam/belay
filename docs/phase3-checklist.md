# Phase 3 checklist: screen time on the Pixel 8

CI proves the phone's side on the Android 17 emulator: opening the fixture app shows up in
Belay's count, a 0-minute limit suspends it and removing it lets it run, a schedule on now
suspends it but not Belay or the dialer, usage reaches the server, `lock-now` turns the screen
off and is reported done, turning usage access off and on is noticed by itself, and network
logging turns Android's logging on and off and gets an app's lookup to the server. This
checklist is for the real Pixel 8 with the **release** build: what only a real phone, a real
kid's apps and a night of Doze can show. Do [phase2-checklist.md](phase2-checklist.md) first.

Record what you see in the table at the end. Write Android's and Belay's words word for word.
No screenshots in the repository, and no account names, phone numbers, serial numbers or the
kid's real apps or times.

## 0. The update, and one restart

1. Update Belay to the Phase 3 version (the parent page's update, or `provision.sh` in
   maintenance mode), then **restart the phone once**. Android reads Belay's new permission to
   lock the screen (`force-lock`) only when the phone starts (platform notes S5). Before that
   restart (the sixth review's G2): the phone's page says "Belay on the phone says: Android lets
   Belay lock the screen only after the phone restarts once with this version of Belay.", and
   "lock now" says the phone couldn't lock, in those words, also when you tap it during a call
   (call a contact first); the screen doesn't lock when that call ends. After the restart the
   problem is gone.
2. With adb (maintenance mode): `adb shell dumpsys device_policy` lists `force-lock` under
   Belay's admin, below `policies:`.
3. Write down whether this Android has the flag that makes the restart unnecessary:
   `adb shell aflags list | grep lock_now_coexistence` (enabled or disabled, read-only or not).
   Also `deprecate_old_query_events_api`, `policy_transparency_refactor_enabled` and
   `enable_supervision_package_usage_apis`, the other open questions from the design.

## 1. Counting

1. On the parent page, turn screen time on for the phone, with measuring on and no limits.
   On the phone, "What your parent can see" now lists "How long you use apps"; Today says
   "Your parent hasn't set any time limits or schedules."
2. Use an app for 5 minutes by a stopwatch, then lock the screen. On the parent page (the
   phone sends today's usage every 15 minutes or so while it's used), today's minutes for that
   app, rounded to the minute, match the stopwatch.
3. Play a video in picture-in-picture over another app for 3 minutes, and two apps in split
   screen for 3 minutes: each app counts its time; the screen minutes count the 3 minutes once.
4. Turn the screen off in the middle of a video and on again 2 minutes later: those 2 minutes
   don't count.
5. Restart the phone in the middle of using an app: the time it was off is a gap ("the phone
   was off") on the parent page, not "unused".

## 2. A limit, time's up, and more time

1. Add a 5-minute limit on a game. Play it. Write down the warning notifications' words at 5
   minutes and at 1 minute left ("… left today for …").
2. When it runs out: the game closes. Write down Belay's notification word for word ("Time's up
   for … today. It comes back …") and what Android shows when the kid taps the game (its dialog's
   title and text, platform notes C2). Does the launcher grey out the icon? Does the game's
   music stop (it should lose audio focus, S2)?
3. Tap "Ask for more time" in the notification: Belay opens with the dialog. Ask for 15 minutes
   with a reason. On the parent page, approve it: within seconds the game opens again, Today
   says "Your parent gave you 15 minutes more for …", and the limit shows extra time.
4. With self-serve on (say 10 minutes, twice a day): once the limit is used up again, Today
   offers "Take 10 minutes more"; take it twice, then it's gone. The parent page lists both.

## 3. Schedules and lock

1. Add a bedtime schedule that starts in 10 minutes, with "lock" on. Five minutes before, the
   warning ("Bedtime starts in 5 minutes"); at the start, the screen locks, and the bedtime
   notification says what still works. Write both down.
2. During bedtime: the phone app, the texting app, Belay and Settings open; other apps show
   Android's "can't open" screen. An alarm set in the clock app rings. Call and text work.
3. The parent page's "lock now": the screen locks within seconds, with and without a screen
   lock (PIN) set on the phone. Write down what happens without one (the screen only turns off).
4. A lock waits for a call (platform notes T20). Call a contact from the phone app, and during the
   call tap "lock now" on the parent page: within seconds the page says "the phone has it: its
   screen locks at once, or as soon as a call ends", the same words as without a call, and no
   time beside them (the fifth review's F2), and the screen doesn't lock while the call is on.
   Keep the call on past the 10 minutes, then end it: the screen locks within a minute, and the
   page still says the same. Do it once more with a bedtime schedule (with "lock" on) that
   starts during a call: the apps pause at the start, and the screen locks only once the call
   ends. If calls aren't on
   for this phone, the call goes through Google's Phone app, and Belay sees it by the audio mode
   (`MODE_IN_CALL`): write down which it was. Without calls on, the wait lasts at most 30 minutes:
   a call that goes on longer is locked behind the lock screen then, and carries on.
5. Only a call an app can't make up holds a lock (the fourth review's N5, the fifth's F3). With
   a voice or video call open in an approved app, check in maintenance whether Android's own call
   system has it (`adb shell dumpsys telecom` lists the call while it's on, as self-managed), then
   tap "lock now". Either way the screen locks within seconds and the app's call carries on: an
   app's own call never holds a lock off, with calls on or off (platform notes T20). Write down
   the app, whether `dumpsys telecom` listed its call, and whether the screen locked.

## 4. Usage access off

1. Settings > Apps > Special app access > Usage access > Belay: turn it off. Within seconds,
   Belay's notification says it can't count, and apps with a limit are paused (the default).
   The parent page says usage access is off.
2. Tap "Turn usage access back on": does it open Belay's own switch, or the list of apps
   (platform notes U9)? Turn it back on: the apps open again, and the parent page's day shows
   the gap.

## 5. Stage and agreement

1. With a stage that has a next stage: "Your stage" lists what the next stage changes, in
   sentences that read well (write down any that don't), and "How to get there" in the
   family's words.
2. With an agreement: the sections show in full. Tap "I want to talk about it" with a reason:
   the parent page shows it.

## 6. A night of Doze

1. Leave the phone idle overnight with a daily limit used up. In the morning, the app opened
   again at the day's start (the parent page's report says the limit is open), and yesterday's
   usage is on the parent page as complete.
2. Check the battery use Android reports for Belay over the day (Settings > Battery): write it
   down. Belay reads screen time every minute only while the screen is on.

## 7. Network logging

1. On the parent page, under Web on the phone's page, turn network logging on. On the phone,
   "What your parent can see" now lists "Which websites and services apps look up, per day", with
   the note about Android's words. Write down Android's own notification word for word (title and
   text: in AOSP, "Device is managed" and "Your organization manages this device and may monitor
   network traffic. Tap for details.", at most twice, at most once a day), and what Quick
   Settings' device-management dialog says about network logging (platform notes W1).
2. Open a browser and two other apps for a few minutes each. Within about 90 minutes (Android
   finishes a batch then, or at 1200 lookups; with adb in maintenance mode, `adb shell dpm
   force-network-logs` finishes it now), the phone's Network tab lists each app with names like
   `example.com`, never a page. Write down how long the first batch took, and roughly how many
   names a browser looked up in a few minutes.
3. Call and text from the phone app and the texting app, and open 988lifeline.org in the
   browser: none of the phone app's or the texting app's lookups, and no 988 name, shows on the
   Network tab. Then, under the switch, add a website the browser looked up in step 2 to Private
   websites (`example.org` works, once the browser has opened it): what the tab showed of it goes
   at once. Open it again in the browser: it never shows again, and "What your parent can see"
   says other websites your parent made private are never noted, without naming it. Remove it
   afterwards.
4. Leave it on for a day: write down how many pairs the busiest day had, whether any were left out
   (the tab says "And … more"), and Belay's battery use (Settings > Battery) against step 6.2.
5. Turn network logging off: within seconds Android's notification goes, the phone's list drops
   the entry, and with adb (maintenance mode) `adb shell dpm force-network-logs` says
   "logging is not available". The Network tab goes; the phone's page says how many days the
   server still keeps.
6. 988's chat (the third review's plausible H), with logging back on. In Chrome, open the 988
   Lifeline's chat page (988lifeline.org, its "Chat" link) and let it load for a minute. **Don't
   start a chat: type nothing, send nothing.** Close the tab, and finish the batch (`adb shell dpm
   force-network-logs` in maintenance mode, or wait). On the Network tab, under Chrome, write down
   every name that showed up for that minute that isn't one of 988's own (`988lifeline.org`,
   `988lineadevida.org`, `suicidepreventionlifeline.org`, `988.ca`, `veteranscrisisline.net`, or a
   name under one). A chat provider's domain there would need adding to 988's list on both sides
   (`core/network/Domains.kt` and the server's `family/network/store.ts`), so it's never kept.

## 8. What a pause never closes

1. Emergency SOS and car crash detection (the third review's plausible D). In maintenance mode,
   write down which app takes Android's emergency assistance (`adb shell cmd role get-role-holders
   android.app.role.EMERGENCY`; on a Pixel, Personal Safety, `com.google.android.apps.safetyhub`,
   is expected) and which app Settings > Safety & emergency > Emergency SOS and Car crash detection
   belong to (the page's title and the app's info). Pause the phone from the parent page. Then
   `adb shell dumpsys package <each package> | grep -i suspended`: none is suspended. On the
   parent page, the phone's app list says the phone never blocks each of them. **Don't trigger
   Emergency SOS** (pressing the power button five times calls emergency services); only look.
2. A third-party keyboard (plausible G). Install an approved keyboard app that isn't the phone's
   own, and make it the keyboard in use. Pause the phone: it still opens in the texting app (the
   keyboard in use stays open through a pause). Then add a limit of 0 minutes for that keyboard on
   the parent page (or block it), and open a conversation with a parent in the texting app: write
   down whether Android falls back to its own keyboard (Gboard) and you can still type, or there's
   no keyboard at all. Type a few words to that parent only; don't text 988. Remove the limit, and
   set the phone's own keyboard back.

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 0.1 | Before the restart: the problem in the phone's status, and lock now "couldn't lock" in its words, during a call too | pending | |
| 0.2 | `force-lock` under Belay's admin after the restart | pending | |
| 0.3 | `lock_now_coexistence` and the other flags | pending | |
| 1.2 | Minutes match a stopwatch | pending | |
| 1.3 | Picture-in-picture and split screen | pending | |
| 1.5 | Restart shows as a gap | pending | |
| 2.1 | Warning words | pending | |
| 2.2 | Time's up words; Android's dialog; icon greyed?; music stops? | pending | |
| 2.3 | More time approved: opens within seconds | pending | |
| 2.4 | Self-serve | pending | |
| 3.1 | Bedtime warning and notice words; screen locks at the start | pending | |
| 3.2 | What works during bedtime; the alarm rings | pending | |
| 3.3 | Lock now, with and without a PIN | pending | |
| 3.4 | Lock now and a bedtime's lock during a call: done at once in the usual words, no time; no lock until the call ends, past 10 minutes too; Belay's call or Google's Phone app | pending | |
| 3.5 | Lock now during an app's call: does `dumpsys telecom` list it; locks at once either way, and the app's call goes on | pending | |
| 4.1 | Usage access off: noticed within seconds, limited apps paused | pending | |
| 4.2 | "Turn usage access back on" opens Belay's switch or the list | pending | |
| 5.1 | Next stage sentences | pending | |
| 6.1 | The limit opens at the day's start after a night of Doze | pending | |
| 6.2 | Belay's battery use for a day | pending | |
| 7.1 | Android's network logging notice and Quick Settings' words | pending | |
| 7.2 | An app's names on the Network tab; time to the first batch | pending | |
| 7.3 | No phone app, texting or 988 names; a private website never shows, nor is named on the phone | pending | |
| 7.4 | A day's pairs, left out, battery | pending | |
| 7.5 | Off: Android's notice goes, dpm refuses | pending | |
| 7.6 | 988's chat page: any name that isn't 988's own (nothing typed) | pending | |
| 8.1 | Emergency SOS's and car crash detection's apps; none suspended during a pause; never paused on the parent page | pending | |
| 8.2 | A third-party keyboard with a 0-minute limit: Android falls back to its own keyboard, or none | pending | |
