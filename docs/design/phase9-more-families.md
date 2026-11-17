# Phase 9: more families

**Status: design.** A new phase, from ROADMAP's "Later". Facts from the existing notes (D1) and
[docs/signing.md](../signing.md).

## Goals

1. **Another family can run Belay** with its own application id, its own release key, its own
   developer-verification registration and its own server, without changing `family.brooker.belay`.
2. **Later, one server for a few families** who trust the person running it (relatives, a small
   school group), with each family's data walled off from the others.

## What's fixed by Android and Google

- An application id and a signing key are permanent for a device owner: changing either means a
  factory reset (docs/signing.md). So each family's id and key are chosen once.
- A limited-distribution developer account registers package names "never seen before on
  Android", covers 20 or 50 phones, and needs the package registered before a release build reaches
  a Play-certified phone (D1). One family's account can't cover another family's phones without
  owning their package, so each family registers its own id.
- Developer verification ties the package to the key's certificate (D1): one key per id.

## Design

### A configurable application id

- Gradle reads `belay.applicationId` (a property, or `BELAY_APPLICATION_ID`); default and Brooker
  value `family.brooker.belay`. The Kotlin `namespace` stays `family.brooker.belay`, so source and
  `R` don't change.
- Everything derived from the id uses `${applicationId}` or reads it at run time: the enroll
  broadcast action (today `family.brooker.belay.ENROLL`), provider authorities, and the scripts,
  which read the id from the APK (`apkanalyzer manifest application-id`, or `aapt2 dump badging`)
  instead of hard-coding it.
- `build-release.sh` refuses to build if the id and the key don't match the pair recorded in
  `signing.properties` (new field `application_id`), so a family can't sign its id with another
  family's key by accident.
- CI builds two ids on the emulator (`family.brooker.belay` and a made-up
  `org.example.otherfamily.belay`) to catch anything still hard-coded.

### The family's own server

Unchanged: one server per family is the default, and the recommendation. The server doesn't care
about the application id.

### One server for several families (later)

Only for people who trust whoever runs the machine: the operator can read the database. The design
keeps families apart, not secret from the operator.

- A `families` table; every row of family data carries `family_id`, and every query goes through a
  scoped data layer that takes the family from the session, token or device, never from a request
  parameter.
- Each family has its own parents, phones, settings, AI scopes and activity log; device tokens and
  OAuth grants are family-scoped; MCP stays at `/mcp`, and the token decides the family.
- An operator account can create families and see their health, but not their data, on the parent
  page; the operator's access to the database is stated plainly in the docs and to each family.
- Tests: for every table and every endpoint, a request from family A can't read or change family B
  (generated from the route list, so a new route can't skip it).

## Protocol

No change to the device API: a phone's token already identifies it, and through it the family.

## Privacy and transparency

On a shared server, the kid's "What your parent can see" says where the data is in the same words
("your parent's Belay server at belay.example.org"), and privacy.md says the server may hold other
families' data, kept apart, and that its operator can read it.

## Threat model changes

| Who, what | With Phase 9 |
|---|---|
| Another family on a shared server | Walled off by family-scoped queries and tests. |
| The operator of a shared server | Can read everything. Only for people the family trusts; one server per family stays the default. |
| A family signs with another family's key | `build-release.sh` checks the id and key pair. |

## Test plan

- Gradle: builds with two ids; the APKs differ only in the id.
- Scripts: `provision.sh` provisions the second id on the emulator.
- Server: the cross-family tests above; migrations from a one-family database add a family.

## Decisions each new family makes

1. Its application id (a reversed domain it controls, or a made-up `org.example…`-style id it will
   never change) and its key, once.
2. Its own developer account, before the first release build reaches its phone (D1).
3. Its own server, or a trusted shared one.

## Open questions

- Should the project publish a template for other families (a fork with a setup checklist), or
  only these docs?
- Are 20 or 50 phones per limited-distribution account enough for a shared group? (Google's pages
  disagree, D1.)
