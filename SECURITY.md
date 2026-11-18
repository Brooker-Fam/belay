# Security

Belay runs as device owner on a kid's phone, so a bug in it can matter more than a bug in
an ordinary app. Please report anything you find.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security** tab >
**Report a vulnerability**. If that isn't available, open an issue that asks for a private
contact, without the details. Please don't post details publicly before a fix.

Only the `main` branch is supported.

## What's in scope

- The Android agent (`android/`): anything that lets another app, or someone holding the
  phone, read what Belay collects, change what it does, or switch it off without a factory
  reset; anything that makes it collect more than its screen says.
- The provisioning scripts (`android/scripts/`).
- The server (`server/`): the device API, parent sign-in and pages, OAuth and MCP,
  including prompt injection that gets an AI client to do something a parent didn't ask
  for, and anything that sends family data anywhere but the family's server.

What Belay restricts is the family's choice: until a parent turns protection on, new apps and
the web aren't restricted, and until a parent locks factory reset (off by default), a kid can
reset the phone from Settings. What a kid can still do with all of it on is in
[docs/threat-model.md](docs/threat-model.md). Those are known, not vulnerabilities.

## Secrets this project never holds

- **The release signing key** stays on the family's computer (docs/signing.md). CI builds
  release APKs unsigned.
- **Device tokens, session ids, OAuth tokens and enrollment codes** are stored on the
  server as SHA-256 hashes only, and **parent passwords** as argon2id hashes. On the phone,
  the device token is encrypted with a key in Android Keystore.
- No analytics, telemetry or crash reporting: nothing about a family leaves its own server.
