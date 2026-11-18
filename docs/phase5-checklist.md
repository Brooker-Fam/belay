# Phase 5 checklist: calls on the Pixel 8

CI proves the phone's side on the Android 17 emulator: when a parent turns calls on, Belay becomes
the default dialer and its call permissions are granted by policy; a call from a contact's number
rings Belay's own screen; a call from a number that isn't a contact is rejected without ringing,
and its record (with the number) reaches the server, while the contact's record carries only the
contact's id; a blocked number goes onto Android's own block list and comes off again; and when
calls goes off, the dialer is given back and Belay holds no call permission. It also shows that a
spoofed 988 caller ID is refused and recorded as a stranger's, that a call Telecom marks as
emergency callback mode rings, that a slow decision rings, and that a lock-now sent while a call
rings waits for the call to end (the third security review's fixes), and that a call before the
first unlock after a restart, which Belay can't decide, reaches the server once afterwards, from
Android's call log (the fourth's). The emulator has no
call audio and (on the ATD image) no preloaded dialer. This checklist is for the real Pixel 8, with
the **release** build and a SIM: real calls, Google's Phone app next to Belay, the incoming-call
screen over the lock screen, Bluetooth, Do Not Disturb, and what happens when Belay breaks. Do
[phase7-checklist.md](phase7-checklist.md) first.

Record what you see in the table at the end, word for word where Android or the carrier says
something. No screenshots in the repository, and no account names, phone numbers or serial
numbers: write "the second phone", not its number. Contacts get made-up names.

**Never call or text 911 or 988 for a test.** Stop at Belay's dial pad with the number typed, or
at the 988 dialog, and back out. If the family wants to be sure 911 itself works through Belay,
plan that with your local 911 center first, on its non-emergency number, and do what they say;
nothing in this checklist needs it. Belay's own code for 911 and 988 is covered by JVM tests.
Step 11 makes the second phone's number a test emergency number, which Android dials as a normal
call to that phone; it never dials 911.

You need: the Pixel 8 with Belay as device owner and a working SIM; a second phone to call from
and to call (a parent's is fine); the parent page; adb over USB for the steps marked "maintenance"
(the debugging lock off). Optional: a Bluetooth headset or car, and a second SIM or an eSIM.

## 1. Turning calls on

1. Before turning calls on, in maintenance: `adb shell telecom get-system-dialer` and
   `adb shell telecom get-default-dialer`. Write down both packages (the preloaded dialer is
   expected to be Google's Phone app).
2. On the parent page, turn calls on: contacts only, callers who aren't contacts rejected, no
   caller ID to voicemail, calls recorded. Within a minute: `telecom get-default-dialer` says
   `family.brooker.belay`, and Settings > Apps > Default apps > Phone app shows Belay. Write down
   anything Android showed while it changed, and whether that setting is greyed out.
3. The parent page doesn't say "Calls are going through the phone's own app". On the phone, Belay's
   "Calls" icon is in the launcher, Home has a "Calls" row, "This phone's rules" lists the calls
   rules, and "What your parent can see" lists "Your calls".
4. Google's Phone app is still in the launcher (Belay never hides it). Open it: write down what it
   says now that it isn't the phone app.

## 2. A call from a contact

1. On the parent page, add the second phone as a contact with calls on (a made-up name). Call the
   Pixel from it, three times: with the Pixel unlocked, locked, and with the screen off. Each time
   Belay's incoming-call screen comes up (over the lock screen too) with the contact's name, and
   the ringtone and vibration follow the ring volume and the vibrate and silent modes.
2. Answer: Belay's call screen. Try Mute, Speaker, Keypad (press a few digits), Hold and End call;
   the screen goes dark when the phone is at your ear. Write down anything that looked or sounded
   wrong, and whether the call quality is the same as in Google's Phone app.
3. Call again and tap Decline: what the second phone hears (voicemail, or busy).
4. Call again and let it ring out: Android's own missed-call notification appears, and Belay's
   Recent tab says "Missed".
5. The parent page has a record of each of those calls, under the contact's name, with how long
   each lasted.

## 3. A refused call

1. Call from a phone that isn't a contact (or remove the contact first). The Pixel doesn't ring,
   vibrate or light up, and there's no missed-call notification. What does the caller hear
   (busy, voicemail, a message from the carrier)? Belay's Recent tab says "Missed: number not in
   your contacts", and the parent page has the record with that number.
2. On the parent page, block that number. In maintenance, within a minute,
   `adb shell content query --uri content://com.android.blockednumber/blocked` lists it. Call from
   it again: what the caller hears now. Unblock it: it's gone from that list.

## 4. A caller with no caller ID

1. From the second phone (still a contact), hide its caller ID for one call (in the US, dial `*67`
   before the number) and call. With "no caller ID: voicemail", the Pixel doesn't ring and the call
   goes to voicemail; Belay's Recent tab says "Missed: the number was hidden".
2. Set no caller ID to ring, and call the same way: it rings, as "Hidden number".

## 5. Calling out

1. From Belay's dial pad, call the contact: it connects. Type a number that isn't a contact: Belay
   says "Your parent hasn't allowed calls to …" with "Ask to add this number". Ask: the request is
   on the parent page with the name, the number and why.
2. Type 911 on Belay's dial pad and stop: don't press Call. Tap "988: Call or text for crisis
   support": write down the dialog's words, then go back without calling or texting.
3. Open Google's Phone app from the launcher and call a number that isn't a contact. Belay ends it
   before it connects. Does the other phone ring at all, or show a missed call? Write down what
   Google's Phone app showed.
4. In Google Messages, open a conversation with a number that isn't a contact and tap its call
   button: write down what happens.
5. Set whom the kid can call to any number. From Belay's dial pad, call the second phone's number
   without its area code (7 digits), and hang up after a few seconds. Write down whether the
   carrier connected it. Either way, Belay's Recent tab lists the call with the digits as dialed,
   and the parent page has an outgoing record of it with no number (the fourth review's N2).
   Set whom the kid can call back to only contacts.

## 6. Quiet times

1. Turn on "quiet during bedtime and school", and start a bedtime schedule now. A call from the
   contact goes to voicemail without ringing; Belay's Recent tab says "Missed during quiet time".
   Add the second phone as a parent contact instead: its call rings.

## 7. When Belay breaks

1. In maintenance, `adb shell am force-stop family.brooker.belay`: Android is expected to ignore it
   for the device owner (platform notes B5). Write down whether the managed notice stays and
   whether the next call still rings Belay's screen.
2. During an answered call from the contact, `adb shell am crash family.brooker.belay`. Write down
   whether the call carries on, and in which app's screen (T2 expects Google's Phone app), and
   whether Belay comes back by itself (the managed notice returns) and takes the next call.
3. The same while a call is ringing: does Google's Phone app take over the ringing call?
4. `adb shell telecom get-default-dialer` after each: still Belay?

## 8. The emergency card and the lock screen

1. Home's emergency card lists the parent contacts (from the contacts marked parent), and
   "Medical information and emergency contacts" still opens Android's own app.
2. On the lock screen, "Emergency call" opens Android's emergency dialer, not Belay. Don't call.

## 9. Audio, Bluetooth, two SIMs, Do Not Disturb

1. With a Bluetooth headset or car connected, call the contact: the Bluetooth button moves the
   audio to it and back; write down what the Speaker button does meanwhile.
2. Turn on Do Not Disturb with calls allowed from starred contacts only, and call from the contact.
   Does Belay's ringtone play? (Belay doesn't get Do Not Disturb's verdict on a caller, T5.) Write
   down what happens, and the same with Do Not Disturb allowing no calls.
3. With two SIMs (or a SIM and an eSIM) and "ask every time" for calls, call the contact from
   Belay's dial pad: which SIM does the call use?

## 10. Turning calls off

1. Turn calls off on the parent page. Within a minute: `adb shell telecom get-default-dialer`
   (maintenance) names the dialer from step 1.1 again, Belay's "Calls" icon and Home row are gone,
   Belay restarted once (the managed notice comes back), `adb shell dumpsys package
   family.brooker.belay | grep CALL_PHONE` shows it isn't granted, and Belay's blocked numbers are
   off Android's block list.
2. A call from a number that isn't a contact rings in Google's Phone app again.

## 11. The callback window, without 911: a test emergency number

Belay lets every caller ring for 2 hours after the kid calls 911, even from the lock screen before
the first unlock after a restart (platform notes T19), and lets 911 and 988 through when the kid
dials a caller-ID code before them (T17). Android can treat one number as an emergency number for
testing: `cmd phone emergency-number-test-mode` (T19). Use **only the second phone's own number,
always with `:normal`**, and only with full signal (not "Emergency calls only"): Android then
tells the modem it's a test call that must not reach emergency services, and places it as a normal
call to that phone. If the second phone doesn't ring within a few seconds, or either phone says
anything about an emergency, hang up at once, clear the test number (`-c`) and stop. A restart
clears it too. Every step here is in maintenance (adb on).

1. Calls on, only contacts, callers who aren't contacts rejected, calls recorded, and the second
   phone not a contact. Call the Pixel from it: refused, as in 3.1 (if it rings, a window from an
   earlier step is still open: wait for its 2 hours to end). Write down the carrier's settings: `adb shell cmd phone cc get-value <key>` for
   `imsemergency.emergency_callback_mode_supported_bool`, `emergency_number_prefix_string_array`,
   `carrier_supports_caller_id_vertical_service_codes_bool` and
   `allow_emergency_numbers_in_call_log_bool` (T17, T18, T11).
2. Restart the Pixel and don't unlock it. Call it from the second phone: write down which app rings
   (Google's Phone app is expected: Belay decides nothing before the first unlock, T19). Decline.
3. Still locked: `adb shell cmd phone emergency-number-test-mode -a <the second phone's
   number>:normal`, then `adb shell cmd phone emergency-number-test-mode -p`: the entry says
   `routing=NORMAL`. If adb doesn't answer before the first unlock, write that down and go to step
   6. If the entry says anything else, `-c` and stop.
4. On the lock screen, tap Emergency call, type the second phone's number and call: the second
   phone rings with the Pixel's number. Answer, and hang up after a few seconds. Then
   `adb shell cmd phone emergency-number-test-mode -c`, and `-p` lists nothing (a call from a test
   emergency number would ring as an emergency call, whatever Belay decides: T17).
5. Unlock the Pixel. Call it from the second phone: Belay's incoming-call screen rings, though the
   rules refuse that number (the 2-hour window, from the call before the unlock). While it rings,
   `adb shell dumpsys telecom | grep -i ecbm`: write down whether the call shows `ecbm` (emergency
   callback mode; not expected after a call routed as a normal one, and only with step 1's first
   setting true; Belay rings such a call whatever its rules, T18). Decline. Belay's Recent tab
   lists the call; the parent page has no record of it. Belay's Recent tab lists step 2's call
   too, declined, taken from the phone's call history (platform notes T22); the parent page has
   no record of it either: it rang within 2 hours of the emergency call.
6. Caller-ID codes (T17). Set whom the kid can call to only contacts. Make the second phone's number
   a test emergency number again (`-a <the second phone's number>:normal`, `-p` says
   `routing=NORMAL`). From Belay's dial pad, call `*67` then the second phone's number: Belay
   places it (no "Your parent hasn't allowed calls to …"), and the second phone rings. Write down
   what it shows as the caller (a US carrier hides the number for `*67`). Hang up. The same with
   `#31#` before the number. Then `-c`. Neither call is on the parent page, and for the next 2
   hours every caller rings (the window those calls opened).
7. `adb shell cmd phone emergency-number-test-mode -p` lists nothing.
8. A restart without the callback window (the fourth review's N1). At least 2 hours after step 4,
   restart the Pixel and leave it locked for 10 minutes. Call it from the second phone (still not
   a contact): Google's Phone app rings on the lock screen (write down what it shows); let it ring
   out. Unlock the Pixel. Within a minute Belay's Recent tab lists the missed call, and the parent
   page has its record: missed, with the second phone's number, and no reason. The phone's Calls
   page (and its status) says "Belay on the phone says: The phone restarted and stayed locked for
   N minutes. …", with N about the time from the restart to the unlock; it's gone a day later.
   Restart once more and unlock at once: no such note.
9. Calls while a call from before the unlock is still on (the fifth review's plausible P1,
   platform notes T22). You need a third phone you can answer, not a contact. At least 2 hours
   after step 6, with only contacts for both directions, restart the Pixel and leave it locked.
   Call it from the second phone and answer on the lock screen, then unlock the Pixel with the
   call still on. In the in-call screen that has the call (write down whose: Google's Phone app
   is expected), put it on hold, tap Add call and call the third phone. Write down whether Belay
   ends that call ("Your parent hasn't allowed calls to …") or the third phone rings. Hang up
   that call, then call the Pixel from the third phone while the second phone's call is still
   on: write down which app shows the waiting call, and whether it rings past only contacts.
   Hang up everything. Within a minute, write down what Belay's Recent tab and the parent page
   list of the three calls (the second phone's, from before the unlock, is expected in both;
   the other two aren't read: T22).

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 1.1 | The system dialer's and the default dialer's packages before calls | pending | |
| 1.2 | Belay the default dialer within a minute; what Android showed; setting greyed out? | pending | |
| 1.3 | Calls icon, Home row, rules, "Your calls" | pending | |
| 1.4 | What Google's Phone app says when it isn't the phone app | pending | |
| 2.1 | Belay's incoming-call screen unlocked, locked, screen off; ring volume and modes | pending | |
| 2.2 | In-call buttons; the screen dark at the ear; call quality | pending | |
| 2.3 | Decline: what the caller hears | pending | |
| 2.4 | Rang out: Android's missed-call notification; "Missed" | pending | |
| 2.5 | The records on the parent page | pending | |
| 3.1 | Refused call: no ring, no notification; what the caller hears; the record | pending | |
| 3.2 | Blocked number on Android's list within a minute, and off again | pending | |
| 4.1 | No caller ID, voicemail: no ring; "Missed: the number was hidden" | pending | |
| 4.2 | No caller ID, ring: "Hidden number" | pending | |
| 5.1 | Calling a contact; "Ask to add this number" reaches the parent page | pending | |
| 5.2 | The 988 dialog's words (nothing called) | pending | |
| 5.3 | Google's Phone app calling a number that isn't a contact: does the other phone ring? | pending | |
| 5.4 | Google Messages' call button | pending | |
| 5.5 | 7 digits with any number allowed: connected?; Recent tab shows the digits; the parent page's record has no number | pending | |
| 6.1 | Quiet time: voicemail; a parent rings | pending | |
| 7.1 | `am force-stop` ignored? | pending | |
| 7.2 | `am crash` during a call: which app, did it drop, did Belay come back | pending | |
| 7.3 | `am crash` while ringing | pending | |
| 7.4 | Belay still the default dialer afterwards | pending | |
| 8.1 | Emergency card: parent contacts; Android's emergency information | pending | |
| 8.2 | Lock screen's emergency dialer isn't Belay | pending | |
| 9.1 | Bluetooth | pending | |
| 9.2 | Do Not Disturb (starred only, and no calls) | pending | |
| 9.3 | Two SIMs: which one | pending | |
| 10.1 | Calls off: dialer back, icon gone, restarted once, no CALL_PHONE, block list clean | pending | |
| 10.2 | A stranger rings in Google's Phone app again | pending | |
| 11.1 | Refused before; the four carrier settings | pending | |
| 11.2 | Before the first unlock: which app rings for a stranger | pending | |
| 11.3 | adb before the first unlock; the test number with `routing=NORMAL` | pending | |
| 11.4 | Emergency call to the test number from the lock screen: the second phone rings | pending | |
| 11.5 | After the unlock: the stranger rings Belay's screen; `ecbm` or not; no record | pending | |
| 11.6 | `*67` and `#31#` before a test emergency number: placed under only contacts; what the second phone shows; no record | pending | |
| 11.7 | The test number cleared | pending | |
| 11.8 | A restart, 10 minutes locked: Google's Phone app rings; after the unlock the missed call in Recent and on the parent page, no reason; the Calls page's note, and none after a quick restart | pending | |
| 11.9 | A call from before the unlock still on: which app has it; Add call to a stranger ended or not; a stranger's waiting call rings or not; what Recent and the parent page list | pending | |
