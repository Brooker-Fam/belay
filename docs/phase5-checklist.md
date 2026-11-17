# Phase 5 checklist: calls on the Pixel 8

CI proves the phone's side on the Android 17 emulator: when a parent turns calls on, Belay becomes
the default dialer and its call permissions are granted by policy; a call from a contact's number
rings Belay's own screen; a call from a number that isn't a contact is rejected without ringing,
and its record (with the number) reaches the server, while the contact's record carries only the
contact's id; a blocked number goes onto Android's own block list and comes off again; and when
calls goes off, the dialer is given back and Belay holds no call permission. The emulator has no
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
