# Phase 7 checklist: the kid's side on the Pixel 8

CI proves the phone's side on the Android 17 emulator: a help request reaches the server at once
and a parent's "seen" comes back to the phone; with location off, a kid's shared fix still gets in
the help request and the permission goes again afterwards; a request can be changed and taken
back; and while a pause holds every other app, the dialer, the texting app and the emergency
information app stay open. This checklist is for the real Pixel 8 with the **release** build: the
kid's screens at the largest font, the emergency card while paused, Android's own emergency
information, and the words read aloud. Do [phase4-checklist.md](phase4-checklist.md) first.

Record what you see in the table at the end. **Never call or text 911 or 988 for a test**: stop at
the dialer or the texting app with the number filled in. No screenshots in the repository, and no
account names, phone numbers or serial numbers.

## 1. Home

1. Open Belay from the managed notice: Home shows the phone's state in one line. Write down the
   line in each state: nothing going on ("Everything's normal"), paused with an end ("Paused by
   your parent until …"), bedtime ("Bedtime until …"), a limit used up ("Time's up for … today"),
   and lost mode ("This phone is in lost mode"). Each shows what works now, ending with "You can
   always call or text 911 and 988."
2. Each of My requests, My stage, This phone's rules, What your parent can see, What Belay told
   your parent, Help and About Belay opens, and Back (and the back gesture) returns to Home.

## 2. The emergency card while paused

1. Pause the phone from the parent page. On Home: "Call 911" opens the phone app with 911 filled
   in (don't call), "Text 988" opens the texting app with 988 (don't send), and a parent number's
   buttons do the same for it. Write down which apps opened.
2. "Medical information and emergency contacts" opens Android's own emergency information. Which
   app (`adb shell cmd role get-role-holders android.app.role.EMERGENCY` in maintenance mode, and
   the screen's title)? Does it show over the lock screen too?
3. The same during bedtime, and with a daily total used up.

## 3. "I need help"

1. On Home, tap "I need help" once: the Help screen says "Your parents will get this right away.",
   "If you're in danger right now, call 911." with its button, and the 988 line. On the parent
   page the help request is at the top within seconds, and the parents' push arrives (time it).
2. Add a few words and send them: the parent page shows the words.
3. On the parent page, mark it seen: the phone shows "Your parent saw this at …" within seconds.
4. From the pause notice, the bedtime notice and a time's-up notice: each has "I need help", which
   opens the Help screen.
5. With location off: tap "Share where this phone is, this once". Write down Android's notices
   (location access, and location turned on if it was off). The parent page shows the help request
   with where the phone is. Leave Belay: within a minute Settings shows Belay without location
   again, location is back off if it was off, and the managed notice is still there (Belay
   restarted once).

## 4. My requests and "Talk to my parent"

1. "Talk to my parent" with a few words: the parent page shows it.
2. Change the words of a waiting request, then take another back: the parent page shows the new
   words, and the taken-back one leaves the inbox. An answered one has neither button.

## 5. What your parent can see

1. With location on and the AI scopes "apps" and "screen time" on in Settings: "Where this phone
   is" is listed, and "Your parent's AI app can read this." shows under exactly those categories.
   "Your parent's AI app can always read these:" lists five lines (the phone's name, problems and
   last check-in; the rules; time limits, schedules and the last screen lock; whether it shares
   where it is; calls' rules and contacts' names); with every scope off they're still there, and
   the last line says "Your parent hasn't let their AI app read anything else here." (the sixth
   review's G4).
2. The line about where it goes names the family's server.

## 6. Words and the largest font

1. Settings > Display > Font size and Display size at their largest: every screen reads without
   text cut off; write down any that doesn't.
2. Read every new sentence aloud with a 12-year-old in mind (strings.xml's Phase 4 and 7 parts):
   write down any that's unclear, scolds, or claims more than Belay does.

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 1.1 | Home's line in each state (words) | pending | |
| 1.2 | Each screen opens; Back returns | pending | |
| 2.1 | 911, 988 and a parent's number while paused: which apps opened | pending | |
| 2.2 | Emergency information: which app; over the lock screen? | pending | |
| 2.3 | The same during bedtime and with the day's time used up | pending | |
| 3.1 | Help request at the top of the parent page; push time | pending | |
| 3.3 | "Your parent saw this at …" | pending | |
| 3.4 | "I need help" on the pause, bedtime and time's-up notices | pending | |
| 3.5 | Sharing with location off: Android's notices; access gone again after | pending | |
| 4.2 | Changing and taking back requests | pending | |
| 5.1 | AI app lines under the right categories | pending | |
| 6.1 | Largest font: anything cut off | pending | |
| 6.2 | Words read aloud: anything to change | pending | |
