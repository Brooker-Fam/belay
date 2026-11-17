# Phase 1 checklist: the Pixel 8 talking to the family's server

CI proves Phase 1 on the Android 17 emulator: the phone enrolls with a real server, sends
its app list, and the server gets a test app's install, update and removal. This checklist
proves the same on the real phone, over cellular, with a real certificate, and with Claude.

Do [phase0-checklist.md](phase0-checklist.md) first. Record what you see in the table at
the end, or paste it to Claude. Write messages word for word. No screenshots in the
repository, and no account names, phone numbers or serial numbers.

## What you need

- The server running at a public HTTPS name ([server.md](server.md)), with the first
  parent account made.
- The Pixel 8, provisioned with the release build ([pixel.md](pixel.md)), with the
  parent-owned Google account added.
- Claude on the web and on your phone.

## 1. Connect the phone

1. On the parent page, Add a phone, and name it.
2. Run the command the page shows, with the phone on USB:
   `android/scripts/provision.sh --server https://<your server> --code <code>`.
   On a phone that's already provisioned, the same command installs Belay again as an
   update and then connects it.
3. Expect `Belay: enrolled: "<name>" on <your server>` at the end.
4. On the phone, Belay's screen shows the server and "Last sent" within a minute.
5. On the parent page, the phone is **OK**, with its apps listed as new.

Also try the phone's own screen once, on a phone that isn't connected (or after
Disconnect, below): Connect to a Belay server → scan the QR code. Allow the camera when
asked. Afterwards, Settings > Apps > Belay > Permissions shows the camera as not allowed.

## 2. Changes reach the server

1. Install a free app from the Play Store with the parent-owned account.
2. Within a minute, the timeline shows **Installed**, "noticed right away", and the app's
   page shows "from Play Store" and its permissions.
3. Update or remove it, and see that too.
4. Turn on airplane mode, remove another app, wait 10 minutes, and turn airplane mode off.
   The removal arrives within a few minutes.
5. Restart the phone. After a few minutes, Belay is back, and "Last app list" on the
   phone's page is from after the restart.

## 3. Silence is a signal

1. Settings → set "Report a phone as silent after" to 1 hour.
2. Turn the phone off (or airplane mode) for over an hour.
3. The phone shows as **Silent for 1 hour**. Turn it back on: it returns to OK at the next
   check-in (at most 2 hours, sooner after a restart).
4. Set the threshold back to 12 hours.

## 4. Claude

1. In Claude on the web: Settings → Connectors → add a custom connector with
   `https://<your server>/mcp`. Sign in with your parent account and approve.
2. Ask: "Is my kid's phone OK?" and "What was installed today, and is any of it worth a
   conversation?" Claude names the phone and the app, with times in your timezone.
3. Open the same connector in the Claude app on your phone and ask again.
4. Ask Claude to mark the app reviewed with a short note. The app's page shows the
   review "via Claude", and Activity shows Claude's reads and the review.
5. Settings → turn off "Apps" for AI, ask again: Claude says a parent turned it off.
   Turn it back on.

## 5. Disconnect and reconnect

1. On the phone's page, Disconnect this phone.
2. At the next sync (at most 2 hours; a restart makes it sooner), Belay's screen says the
   phone was disconnected and stops sending.
3. Make a reconnect code on the phone's page, and run `provision.sh --server … --code …`
   again. The phone is back under the same name, with its history.

## Results

| Step | Check | Result | Android build |
|---|---|---|---|
| 1 | `provision.sh` printed "enrolled" | pending | |
| 1 | Phone OK on the parent page, apps listed | pending | |
| 1 | QR scan from the phone's screen; camera not allowed afterwards | pending | |
| 2 | Play install seen within a minute, "from Play Store", permissions shown | pending | |
| 2 | Update and removal seen | pending | |
| 2 | Removal made offline arrived after airplane mode | pending | |
| 2 | After a restart: Belay back, new app list | pending | |
| 3 | "Silent for 1 hour", then OK again | pending | |
| 4 | Claude (web) connected, answered with names and local times | pending | |
| 4 | Claude (phone app) answered | pending | |
| 4 | Review "via Claude"; reads in Activity | pending | |
| 4 | AI access to apps turned off: Claude said so | pending | |
| 5 | Phone showed "disconnected"; reconnected under the same name | pending | |
