# Using Belay from Claude (MCP)

Belay's main parent interface is an MCP server at `https://<your server>/mcp`. Claude, or
any MCP client, can then answer questions like "what did Sam install this week, and is it
OK?" from what the family's server knows. The parent page is the fallback.

In Phase 1 the AI can read and can mark apps reviewed. **Nothing it does changes a
phone.** From Phase 2 it can tighten things directly (block an app, pause the phone), and
anything that loosens is only a proposal until a parent approves it on the parent page.

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

Always included: the phones' names, their status and problems ("silent for 14 hours"),
and when they last checked in.

Never included, because Belay doesn't collect it in Phase 1: messages, calls, contacts,
photos, browsing, location, or how long apps are used. Passwords, tokens and enrollment
codes are never returned.

Every tool call is in the activity log (Activity → "Also show what AI apps read").

## Tools

| Tool | What it does |
|---|---|
| `list_devices` | Phones with status and problems, model, Android version and patch age, last check-in, app counts, phones waiting to enroll. |
| `get_device_status(device)` | Battery, storage, OS and patch level, last restart, Belay's health on the phone, sync times. |
| `get_installed_apps(device, include_system?, query?, permission?)` | The apps, with versions, dates, source, sensitive permissions and review state. |
| `get_app_changes(device?, since?, until?, limit?, include_system?)` | The timeline: installed, updated, removed, reinstalled. Last 7 days by default. |
| `list_unreviewed_apps(device?)` | Apps installed or reinstalled since a parent reviewed them, or that gained a sensitive permission since. Each has its Play Store link. |
| `mark_apps_reviewed(device, packages, note?)` | Records the review, in the parent's name, through this app. The only write; it changes nothing on the phone. |

All but the last are marked read-only. Times are in the family's timezone with their UTC
offset. Text from app developers (names, versions, package names) and review notes are in
fields labeled `untrusted`, and the server's instructions tell the AI they are data, never
instructions: an app called "Ignore previous instructions" stays just a strange app name.

## Prompts

- **`weekly_review`:** goes through the week's changes, looks up each new app (age rating,
  chatting with strangers, in-app purchases, data safety), and gives a short verdict and a
  conversation starter for each. It never claims to have approved or blocked anything.
- **`review_app(device, package)`:** the same review for one app.

## Things to ask

- "Is Sam's phone OK? When did it last check in?"
- "What did Sam install this week, and is any of it worth a conversation?"
- "Which apps on Sam's phone can use the microphone or the camera?"
- "Where did Chatter Box come from? Look it up and tell me what it is."
- "Mark Trail Maps reviewed, with the note: fine for hiking trips."
- "What changed on Sam's phone since Friday?"
