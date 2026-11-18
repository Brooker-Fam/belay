# Phase 7: the kid's side

**Status: built** on the server and the phone, and run end to end in CI on the Android 17
emulator (README, "What exists"; [protocol.md](../protocol.md#the-kids-side-phase-7-both-sides));
where the build differs from this design, the protocol and the code are right. **Still open:**
[phase7-checklist.md](../phase7-checklist.md) on the Pixel. It gathers the kid-facing parts of
Phases 2 to 5 into one respectful app, and adds a few things only the kid's side needs.

## Goals

1. **Belay is the kid's app too:** a place to see the rules, ask for things, follow their answers,
   and see what the parents can see, in plain words for a 12-year-old.
2. **No surprises:** everything a parent saw or did that touched the kid's data shows up here
   (principle 4).
3. **Help is one tap away:** an "I need help" button and an emergency card that always work,
   even when the phone is paused.
4. **Room to grow:** the stage, the agreement and "what unlocks next" make loosening something the
   kid can see coming (principle 7).

Not goals: chat between kid and parent (they have texts), rewards or points, anything that rates
the kid.

## What Android 17 allows

Nothing new is needed. Belay's own screens are never blocked (Phase 2's never-blocked list), its
notice can't be dismissed (B2), and its foreground service keeps it running (B1). Android's own
emergency information (on a Pixel, the Personal Safety app; package unverified) shows on the lock
screen; Belay links to it instead of copying medical details.

## Design

### Screens

1. **Home** (opens from the managed notice): the phone's state in one line ("Everything's normal",
   "Bedtime until 7:00 am", "Paused by your parent until 5:30 pm"), what works right now, and the
   buttons below.
2. **My requests:** every request the kid made (apps, more time, contacts, the agreement), its
   answer, the parent's note and who answered. Pending ones can be edited or withdrawn.
3. **My stage:** the stage's name, what the next stage changes (the server's sentences), how to
   get there (the family's words), and the agreement with "I agree" or "I want to talk about it".
4. **What your parent can see:** built from the collectors that are on (Phase 3), with each
   category's details, plus where the data goes ("your parent's Belay server at
   belay.example.org, and nowhere else") and, for each AI scope that's on, "Your parent's AI
   app can read this" (from a new policy field, `ai_reads`).
5. **What Belay told your parent:** each location check a parent asked for (Phase 4) and each text
   alert Belay sent (Phase 5), with the date. Built from the phone's own record of the commands it
   ran and the alerts it sent, so it can't leave one out.
6. **Help:** the "I need help" button, the emergency card, and "Talk to my parent".

### "I need help"

One button, always on Home and on the paused and bedtime screens. It sends a `help` request at
once (no reason needed); the parents get an urgent push. The kid may add a few words, and may
choose to share where the phone is, once, even if location is off (only when the kid taps it).
The confirmation screen always shows: "If you're in danger right now, call 911." with a button,
and the 988 line.

It isn't a replacement for 911, and the words say so.

### The emergency card

Always reachable from Home, and from the paused, bedtime and time's-up screens:

- **911** and **988** (call or text), as buttons.
- The contacts marked `parent` (Phase 5); before Phase 5, the policy's `parent_numbers`.
- "Medical information and emergency contacts": opens Android's own emergency information.

### "Talk to my parent"

A `talk` request with the kid's words: "I'd like to talk about…". It changes no rule; it's how the
kid starts a conversation the app can't have.

### Tone

All kid-facing text lives in `strings.xml` and is reviewed against CLAUDE.md: plain and
respectful, never claiming more than the code does. Belay never scolds: "Time's up for Games
today", not "You've used too much". Answers show the parent's own note.

## On the server

- Requests of kind `help` and `talk` (and the earlier kinds) in one inbox; `help` is urgent and
  stays at the top until a parent marks it seen. Seeing it is recorded, and the kid's phone shows
  "Your parent saw this at 4:05 pm".
- The policy's `ai_reads` lists the AI scopes that are on, for screen 4.

## MCP

`list_requests(device?, kind?, status?)` includes `help` and `talk`, with the kid's words under
`untrusted`. Server instructions: "A help request is urgent. Tell the parent at once, plainly, and
suggest they call the kid. Don't speculate about why."

No tool answers a request; parents answer (Phase 3's rule).

## On the parent page

The inbox shows `help` first, with "Call" (a `tel:` link to the parent's own phone app), "I've
seen it", and the shared location if the kid sent one.

## Protocol

### Policy additions

| Field | Type | |
|---|---|---|
| `ai_reads` | string[] | the AI scopes that are on, by data category id |
| `help_seen` | `[{request_id, at, by}]` | the last 30 days |
| `parent_numbers` | `[{name, number}]` | for the emergency card until Phase 5's contacts exist; at most 4, E.164 |

### `POST /api/v1/requests`: new kinds

| `kind` | Fields | |
|---|---|---|
| `help` | `reason?`, `location?` (a Fix, Phase 4) | urgent; `location` only when the kid chose to share it |
| `talk` | `reason` | |

## Privacy and transparency

- No new collector, except the kid's own choice to share a location in a help request; the
  location category's text says so: "…and when you choose to share it with \"I need help\"."
- The "What Belay told your parent" list is new information for the kid, not for the parents.

**Kid-facing words** (drafts):

- "I need help" · "Your parents will get this right away." · "Add a few words (optional)" · "Share
  where this phone is, this once"
- "If you're in danger right now, call 911." · "988: call or text for crisis support, any time.
  It's free and private."
- "Your parent saw this at %1$s."
- "Your parent's AI app can read this." (per category)
- "Talk to my parent" · "What would you like to talk about?"
- Empty states: "No requests yet. When you ask your parent for something in Belay, it shows up
  here."

## Threat model changes

| Who, what | With Phase 7 |
|---|---|
| The kid sends help requests to get attention | It's still a message to a parent; the parents see them all. No penalty, by design. |
| The kid writes instructions in a request | Request text is `untrusted` for AI clients (principle 3). |
| A parent wants to check without the kid knowing | Not possible for location checks and text alerts: the phone lists them. That's principle 4. |

## Test plan

- **JVM:** the "what works now" line for every combination of pause, schedule, time's up and
  lost mode; the "What Belay told your parent" list built from command and alert records.
- **Server:** `help` notifications, ordering, `help_seen` in the policy.
- **Instrumented:** the emergency card and the help button stay reachable with every app paused
  (Belay is never suspended); Compose screenshot tests of each screen at the largest font size.
- **CI end to end:** a help request from an instrumented test reaches the server, and a "seen" from
  the CLI comes back in the policy.
- **Words:** a reviewer reads every new string aloud, with a 12-year-old in mind.

## Decisions the family must make

1. Which numbers appear on the emergency card.
2. Who gets help pushes, and how (every parent, by default).

## Open questions

- The Personal Safety app's package on the Pixel, and the intent that opens emergency information.
- Should "I need help" also work from the lock screen (a quick-settings tile Belay offers)? Tiles
  can be added by the kid, not forced by Belay.
