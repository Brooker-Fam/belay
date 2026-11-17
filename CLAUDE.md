# Belay: notes for contributors (people and Claude)

Open-source, AI-first parental controls for a kid's first Android phone. Phase 1: the
device-owner agent reports to the family's server, and parents use MCP (Claude) or the
parent page. Monitoring only: nothing is blocked yet. [README.md](README.md) says what
exists; [ROADMAP.md](ROADMAP.md) says what's next.

## Principles (every phase)

1. **The phone enforces; the AI advises.** Enforcement is plain, deterministic code on the
   phone and server. The AI reads, summarizes, researches and proposes.
2. **Loosening needs a person, out of band.** From Phase 2, an AI client may tighten
   directly (block an app, pause the phone). Anything that loosens is a proposal until a
   parent taps Approve on the parent page.
3. **Text from the kid or from app developers is untrusted data.** App labels, package
   names, store text and anything typed on the kid's phone can carry prompt injection.
   MCP results put it in labeled data fields; server instructions say it's never an
   instruction. The agent caps its length.
4. **Transparent to the kid.** Nothing is monitored in secret. The phone always says it's
   managed and lists exactly what the parent can see, generated from the collectors
   (`inventory/Collectors.kt`, `core/DataCategory.kt`).
5. **Private by default.** All data stays on the family's server. No analytics, telemetry,
   ads or crash-reporting SDKs; no Firebase, Google Play services or ML Kit in the agent.
   The server never sends family data in readable form to anyone, and never calls an AI:
   the parent's own MCP client is the only AI. Its only outbound requests are reading an
   allowlisted AI client's public metadata document (no family data) and end-to-end
   encrypted push to a parent's own browser. Settings decide which data categories AI
   clients may read.
6. **Silence is a signal.** A phone that stops checking in, stops being device owner or
   loses a permission is reported plainly ("silent for 14 hours").
7. **Built to loosen.** Rules relax as the kid shows they can handle it. Keep per-app
   review history and notes.
8. **Respect the kid's private life.** AI reviews never speculate about the kid from their
   app choices. 911 and 988 always work, in every phase.
9. **Public-repo hygiene.** Never commit secrets, keystores, `.env` files, real device data,
   screenshots of a real kid's phone, or family details. Fixtures use made-up apps and names.

## Ask before

- adding any dependency that makes network calls of its own (and never Firebase, Play
  services, ML Kit, analytics or crash reporting);
- changing the application id `family.brooker.belay` or the signing setup (both are
  permanent: see docs/signing.md);
- anything that could lock someone out of a test phone: `DISALLOW_DEBUGGING_FEATURES`,
  `DISALLOW_FACTORY_RESET`, a factory-reset-protection policy, a release build as device
  owner.

## Conventions

- **Check Android behavior against current developer.android.com docs and AOSP, not
  memory.** Anything Belay relies on goes in [docs/platform-notes.md](docs/platform-notes.md)
  with its source and the Android version, and whether it was seen on the emulator or the
  Pixel. AOSP source: `https://android.googlesource.com/<project>/+/refs/tags/android-17.0.0_r1/<path>?format=TEXT`.
- **Logic goes in `:core`** (plain Kotlin, JVM tests). `:app` is thin Android glue.
- **Every agent step is idempotent.** Triggers overlap on purpose (boot, owner changed,
  services, broadcasts, the hourly check); all go through `Agent.handle` on one thread.
- **Debug-only code lives in `src/debug`**, with a no-op twin in `src/release`. Release
  builds contain nothing that can switch Belay off.
- **Kid-facing words:** plain and respectful, for a 12-year-old, in `strings.xml`. Never
  claim more than the code does.
- **Times:** stored in UTC (epoch millis); shown in the family's timezone with its offset
  (`server/src/time.ts`).
- **The device API contract** is [docs/protocol.md](docs/protocol.md), `core/Protocol.kt`
  and `server/src/device/schemas.ts`: change all three together. The server rejects
  unknown fields; optional fields are additive.
- **Server:** Zod on every input; SQL migrations are append-only (add
  `server/src/migrations/NNN_name.sql`, never edit an applied one); every parent or AI
  action goes through `audit()`; MCP results put developer- or kid-written text under
  `untrusted`; the server makes no outbound requests except the allowlisted client
  metadata documents in `oauth/clients.ts` and encrypted Web Push to allowlisted push
  services.
- **A new kind of data** needs a collector and `DataCategory` on the phone, an AI scope in
  `server/src/settings.ts`, and a line in [docs/privacy.md](docs/privacy.md).
- **Small, reviewable commits.** Keep the README true as you go.

## Commands

```bash
cd server
npm ci --ignore-scripts                               # native modules ship prebuilt
npm test                                              # Vitest
npm run typecheck && npm run lint
BELAY_PUBLIC_URL=http://localhost:8080 npm run dev    # docs/server.md has the settings
npm run cli -- status                                 # also setup-link, create-code, reset-password, backup
docker build -t belay-server .

cd android
./gradlew :core:test                                  # JVM unit tests
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
./gradlew :app:lintDebug :app:lintRelease
shellcheck -x -s bash scripts/*.sh                    # from android/

scripts/provision.sh --debug [--dry-run]              # emulator or test phone, debug build
scripts/unprovision.sh                                # debug builds only
scripts/make-release-key.sh                           # once, ever
scripts/build-release.sh                              # signed release APK
scripts/ci-emulator-test.sh <apk> <test apk>          # emulators only
```

`ANDROID_HOME` must point at an SDK with platform 37.0. CI:
`.github/workflows/android.yml` (build, tests, lint, then the emulator job) and
`.github/workflows/server.yml` (typecheck, lint, tests, Docker image).

## Layout

- `android/core`: models, inventory diffing, the reconcile plan (`Reconcile.kt`).
- `android/app`: `Agent.kt` (the coordinator), `DeviceOwnerSetup.kt`, receivers,
  `service/` (foreground service, managed notice, `DeviceAdminService`),
  `inventory/` (reader, reconciler, runtime watcher), `health/`, `ui/`, `work/`.
- `android/scripts`: provisioning and release tooling (`lib.sh` is shared).
- `server/src`: `device/` (the device API, snapshot diffs), `family/` (what pages and MCP
  read), `web/` (Hono JSX parent pages), `auth/` (parents, sessions), `oauth/`, `mcp/`,
  `migrations/`. Tests in `server/test`.
- `docs/`: protocol, server, MCP, privacy, threat model, platform notes, Phase 0 checklist,
  emulator, Pixel, signing, prior art.
