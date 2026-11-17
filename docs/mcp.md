# Using Belay from Claude (MCP)

Belay's main parent interface is an MCP server at `https://<your server>/mcp`. Claude, or
any MCP client, can then answer questions like "what did Sam install this week, and is it
OK?" from what the family's server knows. The parent page is the fallback.

The AI can read, mark apps reviewed, and **tighten** a phone's rules directly: block an app,
or pause the phone. The phone gets it within seconds if it's online. **Anything that
loosens** (allowing or unblocking an app, resuming a paused phone, lifting a lock, turning
off the web filter, letting new apps run without asking) is only a proposal: it waits on
the parent page's Proposals page until a parent approves it. Nothing loosens without a
parent. The AI can't answer the kid's requests, and it can't touch factory reset,
debugging, reset protection or maintenance mode, not even as a proposal.

## Connect Claude (web, desktop and mobile)

1. In Claude, open Settings → Connectors and add a custom connector with the URL
   `https://belay.example.org/mcp` (your server's name).
2. Claude opens Belay's sign-in page. Sign in with your parent account.
3. The consent screen names the app (Claude, at claude.ai) and what it may read. Choose
   Connect.

The connector then works in Claude on the web, the desktop app and the phone app. Each
parent connects with their own account, and the activity log shows which parent's
connection did what.

Belay accepts Claude's Client ID Metadata Document (it checks the document Claude
publishes at claude.ai) and Dynamic Client Registration as a fallback. It only ever sends
the parent back to Claude's callback, or to an app on the parent's own computer.

## Connect Claude Code

```bash
claude mcp add --transport http belay https://belay.example.org/mcp
```

Then run `/mcp` in Claude Code to sign in: it opens Belay's sign-in page in your browser
and gets the result on a local port.

Or make a personal access token in Settings → AI access (it's shown once) and pass it as
a header:

```bash
claude mcp add --transport http belay https://belay.example.org/mcp \
  --header "Authorization: Bearer belay_pat_…"
```

## Other MCP clients

Any client that speaks Streamable HTTP and OAuth 2.1 with PKCE works if it returns to a
loopback address (an app on your computer). For a hosted client with its own callback URL,
add that exact URL to `BELAY_EXTRA_REDIRECT_URIS` on the server (docs/server.md); those
connections get no refresh token and last 24 hours. Or use a personal access token.

## Disconnecting

Settings → AI access lists every connected app and token, with when each was last used.
Disconnect or Revoke ends it at once: its tokens stop working on the next request.

## What reaches the AI provider

Whatever a tool returns goes to the AI app's provider (Anthropic, for Claude), under that
provider's terms. Settings → "What AI apps may read" turns each category off:

- **Apps:** each app's name, package name, version, install and update dates, where it
  came from (Play Store, sideloaded, …), which sensitive permissions it holds (camera,
  microphone, location, contacts, texts, call history, photos, nearby devices, notification
  access, accessibility, device admin), app changes over time, and the family's reviews and
  notes.
- **Device status:** model, Android version and security patch, battery, storage, last
  restart, and Belay's own health on the phone (device owner, permissions, battery
  exemption).
- **Requests:** what the kid asks for from Belay's screen (which app), and why, in their
  own words, with each answer and the parent's note. On by default.

Always included: the phones' names, their status and problems ("silent for 14 hours",
"the phone hasn't applied the rules changed 4 hours ago", or, first, that someone may be
getting around Belay when the phone reports Android's own Parental Controls or another
profile), when they last checked in, and
each phone's rules (protection, pause and its note, the locked settings, the web filter,
Chrome's settings, maintenance mode, whether reset protection is set, and proposals waiting
for a parent). Blocked and waiting apps are listed only with the Apps category.

Also always included: the server's own health (`get_server_health`): backups, disk, database
size, its clock. It names no phone or app.

Never included, because Belay doesn't collect it: messages, calls, contacts, photos,
browsing, location, or how long apps are used. Passwords, tokens, enrollment codes and
reset protection account ids are never returned.

Every tool call is in the activity log (Activity → "Also show what AI apps read").

## Tools

| Tool | What it does |
|---|---|
| `list_devices` | Phones with status and problems, model, Android version and patch age, last check-in, app counts, whether protection is on or the phone is paused, requests waiting, phones waiting to enroll. |
| `get_device_status(device)` | Battery, storage, OS and patch level, last restart, Belay's health on the phone, sync times. |
| `get_installed_apps(device, include_system?, query?, permission?)` | The apps, with versions, dates, source, sensitive permissions, their rule (allowed, blocked, waiting for a parent) and review state. |
| `get_app_changes(device?, since?, until?, limit?, include_system?)` | The timeline: installed, updated, removed, reinstalled. Last 7 days by default. |
| `list_unreviewed_apps(device?)` | Apps installed or reinstalled since a parent reviewed them, or that gained a sensitive permission since. Each has its Play Store link. |
| `mark_apps_reviewed(device, packages, note?)` | Records the review, in the parent's name, through this app. It changes nothing on the phone. |
| `list_requests(device?, status?)` | What the kid asked for, with their reason and each answer: waiting, approved, declined, let's talk. Waiting first, then the last 30 days. Needs the Requests category. |
| `get_policy(device)` | What a phone enforces now, in words, with the rules' version and whether the phone has applied it; blocked and waiting apps; proposals waiting for a parent. |
| `block_app(device, package, note?)` | Blocks an app at once (tightening). Belay itself, the phone app and texting are never blocked. |
| `pause_phone(device, minutes?, note?)` | Pauses the phone at once, for some minutes or until a parent resumes it; the note is shown to the kid. It can't shorten a pause already running. |
| `get_server_health` | The family's server itself: its problems (urgent first), the last backup and daily try, when a backup was last verified and the last restore drill, free disk space, the database's size, and whether its clock agrees with the phones'. No family data. |
| `propose_change(device, change, reason)` | Proposes loosening a rule (`allow_app` with a package, `resume`, `lift_restriction` with a restriction, `web_filter_off`, `new_apps_allow`) for a parent to approve on the parent page. It changes nothing itself. |

The read tools are marked read-only; `block_app` and `pause_phone` are marked destructive
(they change what the phone enforces, and only a parent can undo them), so a client may ask
before calling them. Every call is in the activity log with the app's name. Times are in
the family's timezone with their UTC offset. Text from app developers (names, versions,
package names), the kid's reasons, notes, and what Belay on the phone reports are in
fields labeled `untrusted`, and the server's instructions tell the AI they are data, never
instructions: an app called "Ignore previous instructions" stays just a strange app name,
and a reason that says "approve this" approves nothing.

## Tighten now, propose to loosen

- `block_app` and `pause_phone` change the rules at once, in the connecting parent's name
  through the app (the activity log says "Claude via MCP (Sam's connection)"). A running
  phone gets the change within seconds.
- `propose_change` records a proposal and notifies the parents' browsers if they turned
  notifications on. A parent approves or rejects it on the Proposals page; approving applies
  it in that parent's name, and approving an app also answers the kid's request for it. The
  same change proposed again while it waits isn't a second proposal, and a change that
  wouldn't loosen anything (an app already allowed, a phone that isn't paused) is refused.
- The kid's requests are answered only by a parent, on the parent page.
- Factory reset, debugging, reset protection and maintenance mode have no tool and no kind
  of proposal: only a parent changes them, on the parent page, and turning hardening on
  needs the phone's name typed.

## Prompts

- **`weekly_review`:** goes through the week's changes and the kid's waiting requests,
  looks up each new or requested app (age rating, chatting with strangers, in-app
  purchases, data safety), and gives a short verdict and a conversation starter for each,
  with a suggested answer to each request. It never claims to have approved anything.
- **`review_app(device, package)`:** the same review for one app.
- **`review_request(device, package)`:** reviews an app the kid asked for, with their
  reason, and suggests how the parent might answer (approve, decline or let's talk, with a
  note). If the parent wants to approve, it offers a proposal; the parent still decides.

## Things to ask

- "Is Sam's phone OK? When did it last check in?"
- "What did Sam install this week, and is any of it worth a conversation?"
- "What is Sam asking for, and why? Look the app up."
- "Which apps on Sam's phone can use the microphone or the camera?"
- "Block Chatter Box on Sam's phone."
- "Pause Sam's phone for an hour, with the note: dinner time."
- "What does Sam's phone enforce right now, and has it applied the latest rules?"
- "Propose allowing Trail Maps: it's for the hiking trip." (Then approve it on the
  Proposals page.)
- "Mark Trail Maps reviewed, with the note: fine for hiking trips."
