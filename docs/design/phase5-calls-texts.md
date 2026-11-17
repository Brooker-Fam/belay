# Phase 5: calls and texts

**Status: design.** Nothing here is built. Android facts cite
[platform-notes-drafts.md](platform-notes-drafts.md) by id. The texts half depends on a Pixel test
(T8) before it's decided.

## Goals

1. **Calls:** the family decides who can call the kid and whom the kid can call: everyone, or
   approved contacts only. Withheld and unknown numbers follow a family rule.
2. **Texts:** alerts, not transcripts. Belay looks for a few kinds of danger on the phone and tells
   the parents what kind of thing it found; it never sends the kid's conversations.
3. **911 and 988 always work,** for calls and texts, whatever the policy, the stage, the pause,
   bedtime, the network, or Belay's own health.
4. **The kid knows** exactly what's read and what's reported, and that 988 is private.

Not goals: recording calls, reading media, reading other messaging apps (app approval governs
those), or any cloud or ML service (no ML Kit, principle 5).

## What Android 17 allows

| Need | What Android 17 offers | Notes |
|---|---|---|
| Control calls | `setDefaultDialerApplication` (API 34, device owner) (T1) | Belay must be a real dialer: dial pad, incoming and ongoing call screens, an `InCallService`. The role grants it the phone, contacts and SMS permissions it declares. The default dialer can't be suspended (S1). |
| 911 | Telecom always uses the preloaded dialer for emergency calls, and falls back to it if the default dialer dies or returns no binding (T2) | So the preloaded dialer must never be hidden, suspended or disabled. |
| 988 | Nothing special: 988 is an ordinary number to Android (T3) | Belay must always allow it, in code. Texting 988 shows no premium-SMS warning (T3). |
| Screen incoming calls | `CallScreeningService` (T4) | Not for withheld, unknown, unavailable or payphone presentations: those only reach the dialer's `InCallService`. |
| Ring or not | `IN_CALL_SERVICE_RINGING` (T5) | The dialer plays the ringtone itself, so a call Belay refuses never rings. |
| Block a number | `BlockedNumberContract`, writable by the default dialer (T6) | The platform blocks calls and texts from listed numbers; blocking pauses for 2 hours after any emergency contact (carrier default). A deny list only. |
| Read texts | `READ_SMS`: hard-restricted, but adb installs allowlist it (I4) | The provider hides drafts, RCS rows marked restricted, and one-time codes for 3 hours from apps like Belay (T7). |
| RCS too | Google Messages' RCS archival, for fully managed devices (T8) | A device owner names an "archival app" in Google Messages' managed configuration; Google Messages writes RCS, SMS and MMS to the Telephony provider and tells that app; Android grants it the restricted-messages app-op. Users "are clearly informed". Untested on an adb-provisioned controller. |
| Own the texts | `setDefaultSmsApplication` (T9) | Belay as the SMS app sees and controls everything, but SMS and MMS only: no RCS. |

## Calls

### Design

Belay becomes the default dialer. The role needs a full dialer, so Phase 5 builds a small,
large-print one: a dial pad, the approved contacts, recent calls, an incoming-call screen and an
in-call screen (mute, speaker, keypad, hang up). It places every call with
`TelecomManager.placeCall` (T2).

**Who rings (incoming):**

1. **Always allowed:** 911, any number Android reports as an emergency number
   (`TelephonyManager.isEmergencyNumber`) and 988 are in code (`:core` `AlwaysAllowed`), not in the
   policy, so no policy or server bug can remove them; contacts marked `parent` in the policy ring
   in every mode too.
2. **After an emergency contact:** for 2 hours after Belay sees a call to an emergency number or
   to 988, or a text to 988, every incoming call and text is allowed. This matches Android's own
   default for its block list (T6), and covers a 911 dispatcher or the 988 line calling back from
   an unfamiliar or withheld number. Telecom also marks such calls
   (`EXTRA_LAST_EMERGENCY_CALLBACK_TIME_MILLIS`).
3. **The policy:** `mode: "open"` lets everyone ring. `mode: "contacts"` lets approved contacts with
   `calls: true` ring; other callers follow `unknown` and withheld ones follow `withheld`
   (`reject`, `voicemail` or `ring`).
4. **Quiet times:** with `quiet: true`, only rule 1 and 2 ring during a bedtime or school schedule
   (Phase 3); others go to voicemail.

Numbers with a visible caller id are decided by Belay's `CallScreeningService` before ringing
(within Telecom's 5 seconds, T4). A call whose caller id failed carrier verification
(`getCallerNumberVerificationStatus() == VERIFICATION_STATUS_FAILED`) is treated as unknown, even if
the number matches a contact. Withheld, unknown and payphone presentations never reach call
screening (T4), so Belay's `InCallService` decides them in `onCallAdded`, rejecting or silencing
before it posts any incoming-call notification. Because Belay declares `IN_CALL_SERVICE_RINGING`
(T5), a refused call never rings.

**Who the kid can call (outgoing):** `outgoing: "contacts"` limits the dial pad and the contact list
to approved contacts with `calls: true`, plus rule 1 numbers; `"any"` allows any number. Emergency
numbers dialed in Belay go to `placeCall`, and Telecom hands them to the preloaded dialer (T2).
Other apps that place carrier calls need `CALL_PHONE`; Belay denies it to every app but itself and
the preloaded dialer by policy (`setPermissionGrantState`). A call Belay didn't place to a number
it doesn't allow is disconnected in `onCallAdded` before it connects (to verify: whether the
carrier sees a short attempt).

**Never blocked:** Belay as dialer can't be suspended anyway (S1). The preloaded dialer, the
emergency-information app and Telecom stay on Phase 2's never-blocked list.

**If Belay breaks:** if Belay's `InCallService` dies or returns no binding, Telecom continues with
the preloaded dialer (T2), with no filtering. This fails open on purpose: a phone that can't take
calls is worse than one that takes an unapproved call. Belay reports "Calls are going through the
phone's own app" as a problem.

**Records:** with `log: true`, Belay sends each call's metadata: when, direction, duration,
outcome, and the contact, or the number for an unknown caller so a parent can approve or block it.
Calls with emergency numbers, 988 or the family's private numbers are never recorded or sent.

**Blocking a number:** a parent can block an unknown caller from the parent page; Belay, as the
default dialer, adds it to the platform's block list (T6), which also blocks its texts.

**Contacts:** the approved list comes from the policy and lives in Belay's own storage. Belay
doesn't write it into Android's Contacts (that would need an account, and accounts are locked
down). The kid's own Contacts app keeps whatever the kid stores there; Belay's rules use only the
policy's list.

### Kid's screens

- The dialer itself, with the contacts the parents approved, and two buttons that are always there:
  "Emergency (911)" and "988: Call or text for crisis support".
- "Ask to add a contact": name, number and why (a `contact` request).
- A refused call shows nothing at the moment it happens; Belay's recent calls list says "Missed:
  number not in your contacts".

## Texts

### Option A (recommended to try first): keep Google Messages, Belay as the archival app

Belay keeps Google Messages as the SMS and RCS app and names itself the archival app
(`messages_archival = <Belay's package>` in Google Messages' managed configuration, set with
`setApplicationRestrictions`). Then (T8):

- Google Messages writes RCS, SMS and MMS messages to Android's Telephony provider on each event
  (sent, received, edited, deleted) and starts Belay's archival service with
  `GOOGLE_MESSAGES_ARCHIVAL_UPDATE`.
- Android grants Belay the restricted-messages app-op, so Belay can read RCS rows (T7, T8).
- Belay already holds `READ_SMS`: allowlisted by the adb install (I4), granted by policy only
  while texts are on (Phase 4's permission rule).
- Google Messages tells the kid that archiving is on (exact words untested).
- Recommended by Google and done by Belay: `setUserControlDisabledPackages` for Google Messages
  and Belay, so neither can be force-stopped or cleared.

What Option A keeps: RCS (group chats and iPhone conversations), and Google Messages' own
protections (Google describes spam and scam detection and on-device warnings for sensitive
images; not checked in this design). What it can't do: stop a stranger's text from arriving. Belay alerts on a new unknown sender, and a parent can block that
number (T6).

### Option B: Belay as the default SMS app

Belay becomes the SMS app (T9): it receives and sends SMS and MMS, and shows only conversations
with approved contacts (`texts: true`), rule 1 numbers and, per `unknown`, others. Everything is
under Belay's control. But RCS is gone: chats fall back to SMS and MMS, group chats with iPhones
degrade, and Google's spam protection and image warnings are lost. Building a reliable SMS and MMS
app is also a large job (MMS especially).

### Recommendation

Start with Option A, after a Pixel test of the archival path (open question 1). Offer Option B
later for families who want "approved contacts only" for texts, like Gabb. Under Option A, the
dialer half still gives "approved contacts only" for calls.

### Flagging on the phone

`TextFlags` (`:core`, pure, versioned, JVM-tested on made-up messages) runs deterministic rules
over each new message: word and phrase lists and patterns, in English first. No cloud service, no
ML model. Categories:

| Category | Looks for | Severity |
|---|---|---|
| `unknown_contact` | The first message from a number not in the approved list | info |
| `meet_up` | Someone the kid doesn't know asking to meet, or for an address | concern |
| `secrecy` | "Don't tell your parents", "delete this" | concern |
| `explicit_request` | Requests for photos or sexual content | urgent |
| `personal_info` | The kid's address, school or phone number sent to an unknown contact | concern |
| `scam` | Gift cards, codes, crypto, "you won" | concern |
| `bullying` | Insults and threats aimed at the kid, from a list | concern |
| `self_harm` | Phrases about hurting oneself | urgent |

**Tiers** (the family picks one):

1. **Who and when:** message counts per contact per day, and new unknown senders. No content.
2. **Alerts:** tier 1, plus each flag's category, severity, contact and time. No text.
3. **Alerts with the flagged line:** tier 2, plus the single message that matched, at most 280
   characters. Never the conversation around it.

**Never read or reported, in code:** conversations with 911, any emergency number, 988, and the
family's `private_numbers` (crisis lines the family adds, such as the Crisis Text Line). Parents
can add numbers to that list; nobody can remove 988.

**On the kid's side, at once:** a `self_harm` match shows the kid a gentle card: "If you're
thinking about hurting yourself, you can call or text 988 any time. It's free and it's private."
That card never waits for a parent. Whether the parents also get an alert is a family decision
(suggested: yes, category only).

**Accuracy:** word rules make mistakes both ways. Alerts say "possible" and show the category's
plain description; the parent page has "This was a mistake", which only marks the alert (the
rules change only with a Belay update, tested on fixtures).

## On the server

- **Tables:** `contacts` (per phone: name, numbers, calls, texts, parent), `call_records`,
  `text_alerts`, `text_stats` (tier 1 counts).
- **Kept:** call records 90 days, alerts 1 year, stats 90 days (settings).
- **Tighten or loosen:** adding a contact, allowing a direction, `mode: "open"`, changing
  `unknown` or `withheld` toward `ring`, `outgoing: "any"`, turning `quiet` off and removing a
  blocked number loosen; the reverse tightens. The tier, `log`, `self_harm_alerts`, private
  numbers and turning texts on or off are collection decisions: parents only, either way.
- **Notifications:** `urgent` alerts notify the parents at once (Phase 2's push); others are in the
  daily digest.

## MCP

| Tool | What it does |
|---|---|
| `get_contacts(device)` | The approved contacts and the call rules. Names are the family's words, `untrusted`. Always available. |
| `get_calls(device, from?, to?)` | Call records. Scope `calls`, off by default. |
| `get_text_alerts(device, from?, to?)` | Alerts with category, severity, time and contact; the flagged line only at tier 3, under `untrusted`. Scope `text_alerts`, off by default. |
| `change_call_rules(device, change)` | **Write.** Tightening applies; loosening becomes a proposal. |
| `block_number(device, number)` | **Write, tightens.** Adds a number to the platform block list. |

No tool adds a contact directly (that loosens), and none answers the kid's `contact` requests.

Server instructions gain: "A text alert is a possible concern found by simple rules on the phone,
not a fact about the kid. Never quote a flagged line back as if it were the kid's whole
conversation, and never guess at what the kid meant. 988 conversations are private: Belay never
sees them."

## On the parent page

- **Calls:** the rules; approved contacts (add, edit, mark `parent`); recent calls with "Add as a
  contact" and "Block"; the kid's `contact` requests.
- **Texts:** the option in use, the tier, the private numbers, alerts with "This was a mistake",
  and the exact words the kid sees about what Belay reads.

## Protocol

### Policy additions

| Field | Type | |
|---|---|---|
| `calls` | Calls? | null: Belay isn't the dialer; nothing changes |
| `contacts` | Contact[] | the approved list; at most 500 |
| `texts` | Texts? | null: Belay reads no texts |

**Calls**

| Field | Type | |
|---|---|---|
| `mode` | `"open"` \| `"contacts"` | who can ring |
| `unknown` | `"reject"` \| `"voicemail"` \| `"ring"` | callers not in the list, with `mode: "contacts"` |
| `withheld` | `"reject"` \| `"voicemail"` \| `"ring"` | no caller id |
| `outgoing` | `"contacts"` \| `"any"` | |
| `quiet` | bool | during Phase 3 bedtime and school schedules, only always-allowed numbers ring |
| `log` | bool | send call records |

**Contact**

| Field | Type | |
|---|---|---|
| `id` | string | |
| `name` | string | the family's words, at most 60 characters |
| `numbers` | string[] | E.164, at most 5 |
| `calls`, `texts` | bool | what this contact may do |
| `parent` | bool | always rings; shown on the emergency card (Phase 7) |

**Texts**

| Field | Type | |
|---|---|---|
| `via` | `"archival"` \| `"sms_app"` | Option A or B |
| `tier` | 1 \| 2 \| 3 | |
| `unknown` | `"allow"` \| `"block"` | Option B only |
| `self_harm_alerts` | bool | tell the parents about `self_harm` matches |
| `private_numbers` | string[] | E.164 numbers Belay never reads, beyond 988 and emergency numbers |

### Enforcement additions

`calls: {dialer: bool, problem?}` (whether Belay is the default dialer, and its problem, like
"Calls are going through the phone's own app"); `texts: {reading: bool, via, problem?}`.

### `POST /api/v1/calls`

128 KB, at most 500 records. Idempotent by `id`.

**CallRecord**: `{id, at, direction: "in" | "out", contact_id?, number?, duration_s, outcome:
"answered" | "missed" | "rejected" | "voicemail", reason?: "unknown" | "withheld" | "quiet" |
"not_allowed"}`. `number` (E.164) only when `contact_id` is null; never for emergency, 988 or
private numbers, which are never recorded at all.

### `POST /api/v1/texts`

128 KB. Idempotent by each item's `id`.

```json
{ "stats": [ { …TextStat… } ], "alerts": [ { …TextAlert… } ] }
```

**TextStat** (tier 1+): `{day, contact_id?, number?, sent, received}`.

**TextAlert** (tier 2+): `{id, at, category, severity: "info" | "concern" | "urgent", direction,
contact_id?, number?, rules_version, line?}`; `line` (tier 3 only) is at most 280 characters, the
single matching message: untrusted.

### `POST /api/v1/requests`: new kind

`contact`: `{name, number, reason?}`, all untrusted. Approving it adds a contact.

## Privacy and transparency

**`DataCategory` entries** (only while on):

| id | Title | Details |
|---|---|---|
| `calls` | Your calls | "Who you call and who calls you, when, and for how long. Not what anyone says. Calls with 911 and 988 are never recorded." |
| `text_alerts` | Possible dangers in texts | Tier 1: "How many texts you send and get with each contact, and when someone new texts you." Tier 2 adds: "When Belay finds a possible danger, like a stranger asking to meet, it tells your parent what kind it was. Not your messages." Tier 3 adds: "…and the one message where it found it." Always: "Texts with 988 are never read." |

**AI scopes:** `calls` and `text_alerts`, **both off by default**: they're about the kid's
relationships, and about other people (friends' numbers and words).

**Kid-facing words** (drafts):

- "Your parent decides who can call you. These people can: …"
- "Emergency (911)" · "988: Call or text for crisis support. It's free and private, and Belay
  never tells anyone you called or texted."
- "Belay reads your texts on this phone to look for a few kinds of danger, like a stranger asking to
  meet you. Your messages stay on this phone. If Belay finds one, it tells your parent what kind of
  thing it found." (tier 2)
- "Belay told your parent about a possible danger in a text on %1$s: %2$s." (shown on the phone for
  every alert, so nothing is reported in secret)
- "Google Messages may say your messages are archived. That's Belay: it reads them on this phone
  and doesn't send them."

**Other people:** friends' numbers and words reach the server only as an unknown caller's number,
an unknown sender's number, or a tier-3 line. The parent page says so.

## Threat model changes

| What the kid could do | With Phase 5 |
|---|---|
| Change the default dialer or SMS app back | Phase 2's `config_default_apps` blocks it. |
| Install another dialer or calling app | Phase 2's app approval; `CALL_PHONE` denied to other apps. |
| Use WhatsApp or another messenger | Not covered by Phase 5; the app is approved or not like any app. |
| A stranger spoofs a contact's number | Calls failing carrier verification count as unknown; texts can't be checked. |
| A stranger texts the kid (Option A) | It arrives; Belay alerts and a parent can block the number. Option B refuses it. |
| Belay's dialer crashes | Calls continue through the preloaded dialer, unfiltered, and the problem is reported. |
| Write around the word rules | Possible: the rules are simple and public. They're a safety net, not a guarantee. |
| A flagged line is quoted to the AI | Only at tier 3 and with the scope on; under `untrusted`, never an instruction. |
| An unsafe adult in the home reads 988 contact | Belay never records 988 calls or texts, by design. |

## Test plan

**JVM (`:core`)**
- `AlwaysAllowed`: 911, emergency numbers, 988, parents; the 2-hour window after an emergency
  contact; nothing in the policy can remove them.
- Call decisions for every mode, unknown and withheld rule, quiet times, verification failures.
- Number normalization to E.164: Android's own `PhoneNumberUtils` on the phone; for `:core`'s JVM
  tests, either a small normalizer in `:core` or Google's `libphonenumber` (a new dependency, though
  it makes no network calls of its own).
- `TextFlags`: each category on made-up positive and negative fixtures; private numbers skipped;
  tiers strip what they must.

**Server (Vitest)**
- Classification of every call and text rule change; tier and on/off changes refused to AI
  clients.
- `/calls` and `/texts`: idempotency, limits, `line` only at tier 3, no records for private
  numbers accepted.

**Instrumented (emulator)**
- `setDefaultDialerApplication(Belay)` succeeds; with a broken manifest it throws (T1).
- `cmd phone emergency-number-test-mode -a 5550911` (`packages/services/Telephony`,
  `TelephonyShellCommand`): placing a call to that test number from Belay's dial pad brings up the
  preloaded dialer, not Belay (T2), without dialing a real emergency number. (Check that the image
  has a preloaded dialer: the ATD image may not.)
- Belay's ring decisions on `adb emu gsm call <number>`: a contact rings, an unknown number goes to
  the policy's outcome.

**CI end to end**
- The server's CLI sets `mode: "contacts"` with one contact; `adb emu gsm call` from that contact
  rings, from another number doesn't, and the server gets both records.
- Option B only (Option A needs Google Messages, not on the emulator images): `adb emu sms send`
  from an unknown number under `unknown: "block"` never shows, and tier 1 stats arrive.

**On the Pixel** (a Phase 5 checklist): the archival path end to end, with an RCS chat; what Google
Messages shows the kid; a withheld call; 988 by call and text through Belay's dialer; a crash of
Belay's `InCallService` mid-call.

## Decisions the family must make

1. Calls: everyone or approved contacts; the unknown and withheld rules; quiet times; outgoing.
2. Texts: off, Option A (keep Google Messages) or Option B (approved contacts only, no RCS).
3. The tier: who and when, alerts, or alerts with the flagged line.
4. Whether self-harm matches alert the parents (the kid's 988 card shows either way).
5. Extra private numbers.
6. Confirm Belay's rule: calls and texts with emergency numbers and 988 are never recorded or
   reported.
7. What AI clients may read (both off by default), and retention.

## Open questions

1. Does Google Messages honor `messages_archival` set by an adb-provisioned device owner without
   managed Google Play, and what exactly does it show the kid? Does it archive RCS group chats?
2. Does Google Messages honor the platform block list for RCS chats, or only for SMS?
3. With `IN_CALL_SERVICE_RINGING`, is there truly no ring for a rejected withheld call on the Pixel?
4. Does disconnecting a non-allowed outgoing call in `onCallAdded` stop it before the network sees
   it?
5. What else must a dialer support well: Wi-Fi calling, RTT, Bluetooth headsets and cars, visual
   voicemail, a Wear watch?
6. Which languages does `TextFlags` need first, and who maintains the lists?
