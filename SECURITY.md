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
- From Phase 1, the server: the device API, parent login, OAuth and MCP.

Phase 0 doesn't restrict the phone yet: a kid can still factory reset it, install anything
or browse anything. That's known and planned for Phase 2 (ROADMAP.md), not a vulnerability.

## Secrets this project never holds

- **The release signing key** stays on the family's computer (docs/signing.md). CI builds
  release APKs unsigned.
- From Phase 1, **device tokens** are stored on the server as SHA-256 hashes only, and
  **parent passwords** as argon2id hashes.
- No analytics, telemetry or crash reporting: nothing about a family leaves its own server.
