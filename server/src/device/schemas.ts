/**
 * The device API (docs/protocol.md), mirroring the agent's Protocol.kt. Every object is strict:
 * an unknown field is an error, not silence. Optional fields may be omitted or null.
 */
import { z } from "zod";

export const LIMITS = {
  enrollBytes: 16 * 1024,
  /** Phase 3 made check-ins bigger: never_blocked, and screen_time's report. */
  checkinBytes: 64 * 1024,
  inventoryBytes: 4 * 1024 * 1024,
  eventsBytes: 512 * 1024,
  maxPackages: 5000,
  maxEvents: 1000,
  maxLabel: 200,
  requestsBytes: 128 * 1024,
  maxRequests: 100,
  maxReason: 500,
  maxProblems: 20,
  maxProblem: 200,
  /** Longest a policy long-poll is held, in seconds. */
  maxWaitSeconds: 55,
  maxCommandResults: 20,
  maxNeverBlocked: 100,
  maxForeignRestrictions: 20,
  maxRestrictionKey: 64,
  /** Phase 6: the largest APK of Belay the server stores and serves. */
  maxAgentBytes: 100 * 1024 * 1024,
  /** Phase 3: `POST /api/v1/usage`. */
  usageBytes: 256 * 1024,
  maxUsageDays: 31,
  maxUsageApps: 500,
  /** Phase 4: `POST /api/v1/locations`. */
  locationsBytes: 64 * 1024,
  maxFixes: 200,
  maxPlaceEvents: 200,
  maxPlaces: 20,
  /** Phase 7. */
  maxParentNumbers: 4,
  /** Phase 5: `POST /api/v1/calls`, and the approved contacts. */
  callsBytes: 128 * 1024,
  maxCalls: 500,
  maxContacts: 500,
} as const;

const time = z.int().min(0);
/** Android version codes are 64-bit (versionCodeMajor << 32 | versionCode): any integer. */
const versionCode = z.number().refine(Number.isInteger, "not an integer");
const text = (max = 200) => z.string().max(max);
/** Java-style package names only: nothing in them can be markup or a sentence. */
export const packageName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "not a package name");
/** A SHA-256, lowercase hex. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "not a lowercase hex SHA-256");
const clientId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "use letters, digits, '-' and '_'");
/** Phase 7: a phone number in E.164, like +15555550100. */
export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "not E.164");

export const Version = z.strictObject({ name: text().nullish(), code: versionCode });

// ── Phase 3 building blocks ─────────────────────────────────────────────
/** An id the server makes for a rule (limit, schedule, extra time): short, letters, digits, '-' and '_'. */
export const ruleId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "use letters, digits, '-' and '_'");
/** A limit's id, or "*" for every limit: extra time only (self-serve takes and more-time requests name a real limit). */
const limitRef = ruleId.or(z.literal("*"));
/** "HH:MM", 00:00 to 23:59. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "not HH:MM");
/** "YYYY-MM-DD". */
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "not YYYY-MM-DD");
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const dayMinutes = z.int().min(0).max(1440);

export const ChangeKind = z.enum(["installed", "updated", "removed", "reinstalled"]);
export const Detection = z.enum(["broadcast", "changed_packages", "snapshot"]);
export const Source = z.enum(["play_store", "other_store", "other_app", "sideloaded", "adb", "preinstalled", "unknown"]);
export const PermissionCategory = z.enum([
  "camera",
  "microphone",
  "location",
  "contacts",
  "sms",
  "call_log",
  "photos_media",
  "nearby_devices",
  "notification_access",
  "accessibility",
  "device_admin",
]);
export type PermissionCategory = z.infer<typeof PermissionCategory>;

export const Installer = z.strictObject({
  installing: packageName.nullish(),
  initiating: packageName.nullish(),
  originating: packageName.nullish(),
  update_owner: packageName.nullish(),
  package_source: z.int().nullish(),
});

export const Package = z.strictObject({
  package: packageName,
  label: text(LIMITS.maxLabel),
  version_name: text(LIMITS.maxLabel).nullish(),
  version_code: versionCode,
  first_install_time: time,
  last_update_time: time,
  system: z.boolean(),
  updated_system: z.boolean(),
  enabled: z.boolean(),
  launchable: z.boolean(),
  target_sdk: z.int(),
  category: z.int(),
  source: Source,
  installer: Installer,
  permissions: z.array(PermissionCategory).max(20),
});
export type Package = z.infer<typeof Package>;

export const Event = z.strictObject({
  id: clientId,
  kind: ChangeKind,
  package: packageName,
  label: text(LIMITS.maxLabel),
  from: Version.nullish(),
  to: Version.nullish(),
  happened_at: time.nullish(),
  detected_at: time,
  detection: Detection,
  /** The app as it is after the change (installed, updated, reinstalled), so its details arrive at once. */
  app: Package.nullish(),
});
export type Event = z.infer<typeof Event>;

export const Permission = z.strictObject({ name: text(), granted: z.boolean(), fixed_by_policy: z.boolean() });

export const Health = z.strictObject({
  device_owner: z.boolean(),
  uninstall_blocked: z.boolean().nullish(),
  battery_exempt: z.boolean(),
  usage_access: z.boolean(),
  notifications_shown: z.boolean(),
  permissions: z.array(Permission).max(100),
  standby_bucket: z.int(),
  background_restricted: z.boolean(),
  service_running: z.boolean(),
  test_only: z.boolean(),
  /** Phase 10: users or profiles other than the kid's own; null when not device owner. */
  other_users: z.int().min(0).nullish(),
  /** Phase 10: user restrictions in force that Belay didn't set. */
  foreign_restrictions: z.array(text(LIMITS.maxRestrictionKey)).max(LIMITS.maxForeignRestrictions).optional(),
});
export type Health = z.infer<typeof Health>;

/** Phase 2: which policy the phone enforces, and what it couldn't (Belay's own words). */
export const Enforcement = z.strictObject({
  policy_version: z.int().min(0),
  applied_at: time.nullish(),
  suspended_count: z.int().min(0).optional(),
  problems: z.array(text(LIMITS.maxProblem)).max(LIMITS.maxProblems).optional(),
  /** Phase 6: how the update the policy offers is going. */
  agent_update: z
    .strictObject({
      version_code: versionCode,
      state: z.enum(["downloading", "checking", "installing", "failed", "done"]),
      problem: text(LIMITS.maxProblem).nullish(),
      at: time,
    })
    .nullish(),
  /** Phase 6: the last use of the recovery key on the phone. */
  recovery: z.strictObject({ version: z.int().min(1), used_at: time, until: time }).nullish(),
  /** The results of the last one-shot commands, newest first. */
  commands: z
    .array(
      z.strictObject({
        id: clientId,
        result: z.enum(["done", "failed", "expired"]),
        at: time,
        problem: text(LIMITS.maxProblem).nullish(),
      }),
    )
    .max(LIMITS.maxCommandResults)
    .optional(),
  /** The apps this phone never blocks (Belay, the dialer, the SMS app, the keyboard…): the server refuses to block them. */
  never_blocked: z.array(packageName).max(LIMITS.maxNeverBlocked).optional(),
  /** Phase 3: the phone's view of screen time now; minutes left out when the policy doesn't measure. */
  screen_time: z
    .strictObject({
      day: ymd,
      measured: z.boolean(),
      used_minutes: z.int().min(0).max(1500).nullish(),
      limits: z
        .array(
          z.strictObject({
            id: ruleId,
            used: z.int().min(0).max(1500).nullish(),
            left: z.int().min(0).max(1500).nullish(),
            state: z.enum(["open", "used_up", "extra"]),
          }),
        )
        .max(50),
      schedule: z.strictObject({ id: ruleId, until: time }).nullish(),
      self_serve: z
        .array(
          z.strictObject({
            /** Always a limit's own id, never "*". */
            limit_id: ruleId,
            package: packageName.nullish(),
            minutes: z.int().min(1).max(240),
            at: time,
          }),
        )
        .max(20)
        .optional(),
    })
    .nullish(),
  /** Phase 3 (later): network logging; `paused` when Android paused it. */
  network_log: z.strictObject({ enabled: z.boolean(), paused: z.boolean() }).nullish(),
  /** Phase 4: whether Belay can take a fix; null while location is off. */
  location: z
    .strictObject({
      permission: z.boolean(),
      location_on: z.boolean(),
      last_fix_at: time.nullish(),
      problem: text(LIMITS.maxProblem).nullish(),
    })
    .nullish(),
  /** Phase 5: whether Belay is the default dialer; null while the policy's calls is null. */
  calls: z.strictObject({ dialer: z.boolean(), problem: text(LIMITS.maxProblem).nullish() }).nullish(),
});
export type Enforcement = z.infer<typeof Enforcement>;

export const Device = z.strictObject({
  manufacturer: text(),
  model: text(),
  android_release: text(50),
  sdk: z.int(),
  sdk_full: text(50),
  security_patch: text(50),
  agent_version_name: text(50),
  agent_version_code: versionCode,
  boot_count: z.int().nullish(),
  last_boot_at: time,
  timezone: text(64),
  device_time: time,
  battery_percent: z.int().min(0).max(100).nullish(),
  charging: z.boolean().nullish(),
  storage_free_bytes: z.int().min(0).nullish(),
  storage_total_bytes: z.int().min(0).nullish(),
  health: Health,
  enforcement: Enforcement.nullish(),
  /** Phase 6: SHA-256 of the certificate Belay is signed with. The server pins the first. */
  agent_signing_sha256: sha256Hex.nullish(),
});
export type Device = z.infer<typeof Device>;

export const EnrollRequest = z.strictObject({ code: z.string().max(64), device: Device });
export const CheckinRequest = z.strictObject({ status: Device });
export const InventoryRequest = z.strictObject({
  snapshot_id: clientId,
  taken_at: time,
  boot_count: z.int().nullish(),
  device: Device,
  packages: z.array(Package).max(LIMITS.maxPackages),
});
export type InventoryRequest = z.infer<typeof InventoryRequest>;
export const EventsRequest = z.strictObject({ events: z.array(Event).max(LIMITS.maxEvents) });

// ── Phase 2 ─────────────────────────────────────────────────────────────

/** Let me use this app (a new one waiting, or a blocked one). */
export const AppRequest = z.strictObject({
  id: clientId,
  kind: z.literal("app"),
  package: packageName,
  label: text(LIMITS.maxLabel),
  reason: text(LIMITS.maxReason).nullish(),
  asked_at: time,
  /** Phase 7: sent again with this, a pending request is withdrawn. */
  withdrawn_at: time.nullish(),
});
/** Phase 3: more minutes for a limit today, from the app the kid was in. */
export const MoreTimeRequest = z.strictObject({
  id: clientId,
  kind: z.literal("more_time"),
  limit_id: ruleId,
  minutes: z.int().min(5).max(240),
  package: packageName.nullish(),
  reason: text(LIMITS.maxReason).nullish(),
  asked_at: time,
  withdrawn_at: time.nullish(),
});
/** Phase 3: the kid's answer to a version of the family agreement. */
export const AgreementRequest = z.strictObject({
  id: clientId,
  kind: z.literal("agreement"),
  version: z.int().min(1),
  answer: z.enum(["agree", "talk"]),
  reason: text(LIMITS.maxReason).nullish(),
  asked_at: time,
  withdrawn_at: time.nullish(),
});
// ── Phase 4 and 7 (docs/protocol.md) ─────────────────────────────────────

/** Phase 4: one fix, 5 decimal places. */
export const Fix = z.strictObject({
  id: clientId,
  at: time,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.int().min(0).max(100_000),
  provider: z.enum(["gps", "fused"]),
  reason: z.enum(["on_demand", "periodic", "place", "lost", "help"]),
  command_id: clientId.nullish(),
  mock: z.boolean(),
});
export type Fix = z.infer<typeof Fix>;
export const PlaceEvent = z.strictObject({
  id: clientId,
  place_id: ruleId,
  kind: z.enum(["arrived", "left"]),
  at: time,
  fix_id: clientId,
});
export const LocationsRequest = z.strictObject({
  fixes: z.array(Fix).max(LIMITS.maxFixes),
  place_events: z.array(PlaceEvent).max(LIMITS.maxPlaceEvents),
});
/** Phase 7: "I need help": urgent; `location` only when the kid chose to share it. */
export const HelpRequest = z.strictObject({
  id: clientId,
  kind: z.literal("help"),
  reason: text(LIMITS.maxReason).nullish(),
  location: Fix.nullish(),
  asked_at: time,
  withdrawn_at: time.nullish(),
});
/** Phase 7: "I'd like to talk about…". */
export const TalkRequest = z.strictObject({
  id: clientId,
  kind: z.literal("talk"),
  reason: text(LIMITS.maxReason).min(1),
  asked_at: time,
  withdrawn_at: time.nullish(),
});

// ── Phase 5, calls (docs/protocol.md): not accepted by the routes yet ───────

/** One call's metadata; `number` only for a caller who isn't a contact. */
export const CallRecord = z.strictObject({
  id: clientId,
  at: time,
  direction: z.enum(["in", "out"]),
  contact_id: ruleId.nullish(),
  number: e164.nullish(),
  duration_s: z.int().min(0).max(86_400),
  outcome: z.enum(["answered", "missed", "rejected", "voicemail", "not_placed"]),
  reason: z.enum(["unknown", "withheld", "quiet", "not_allowed"]).nullish(),
});
export const CallsRequest = z.strictObject({ calls: z.array(CallRecord).min(1).max(LIMITS.maxCalls) });
/** Phase 5: "Please add this contact". The name and the reason are the kid's words. */
export const ContactRequest = z.strictObject({
  id: clientId,
  kind: z.literal("contact"),
  contact_name: text(60).min(1),
  contact_number: e164,
  reason: text(LIMITS.maxReason).nullish(),
  asked_at: time,
  withdrawn_at: time.nullish(),
});

/**
 * Something the kid asks a parent for: a union on `kind`. Sending the same id again updates a
 * pending request's reason (and a help request's shared fix); with `withdrawn_at`, it withdraws
 * a pending one (Phase 7).
 */
export const Request = z.discriminatedUnion("kind", [AppRequest, MoreTimeRequest, AgreementRequest, HelpRequest, TalkRequest]);
export type Request = z.infer<typeof Request>;
export type AppRequest = z.infer<typeof AppRequest>;
export type MoreTimeRequest = z.infer<typeof MoreTimeRequest>;
export type AgreementRequest = z.infer<typeof AgreementRequest>;
export type HelpRequest = z.infer<typeof HelpRequest>;
export type TalkRequest = z.infer<typeof TalkRequest>;
export type PlaceEvent = z.infer<typeof PlaceEvent>;
export type LocationsRequest = z.infer<typeof LocationsRequest>;
export const RequestsRequest = z.strictObject({ requests: z.array(Request).min(1).max(LIMITS.maxRequests) });

/**
 * Phase 3: one local day of usage. Idempotent by (day, zone): a day sent again replaces the stored
 * one when its `as_of` is the same or newer (a complete day re-sent after the phone's clock moved
 * has the same `as_of`, its end, and must replace it).
 */
export const UsageDay = z.strictObject({
  day: ymd,
  zone: text(64),
  as_of: time,
  complete: z.boolean(),
  /** A day with a clock change can have 25 hours. */
  screen_minutes: z.int().min(0).max(1500),
  unlocks: z.int().min(0).max(100_000),
  /** On the day clocks go back, both 1 a.m. hours add up in one entry. */
  by_hour: z.array(z.int().min(0).max(120)).length(24),
  apps: z
    .array(z.strictObject({ package: packageName, minutes: z.int().min(1).max(1500), opens: z.int().min(0).max(100_000) }))
    .max(LIMITS.maxUsageApps),
  gaps: z
    .array(z.strictObject({ from: time, to: time, reason: z.enum(["no_usage_access", "phone_off", "unknown"]) }))
    .max(200),
});
export type UsageDay = z.infer<typeof UsageDay>;
export const UsageRequest = z.strictObject({ days: z.array(UsageDay).min(1).max(LIMITS.maxUsageDays) });

export const PolicyQuery = z.strictObject({
  /** The version the phone has; the server answers at once if it has a different one. */
  have: z.coerce.number().int().min(-1).optional(),
  /** Seconds to hold the request open for a change (long-poll); 0 answers at once. */
  wait: z.coerce.number().int().min(0).max(LIMITS.maxWaitSeconds).optional(),
});

/** Phase 3: the policy's `screen_time` (docs/protocol.md, "ScreenTime"). */
export const ScreenTime = z.strictObject({
  measure: z.boolean(),
  /** An IANA zone, or "phone". */
  zone: text(64),
  day_starts: hhmm,
  limits: z
    .array(
      z.strictObject({
        id: ruleId,
        name: text(60),
        /** ["*"]: every app that isn't exempt. */
        packages: z.array(packageName.or(z.literal("*"))).max(500),
        minutes: dayMinutes,
        by_day: z
          .strictObject({
            mon: dayMinutes.optional(),
            tue: dayMinutes.optional(),
            wed: dayMinutes.optional(),
            thu: dayMinutes.optional(),
            fri: dayMinutes.optional(),
            sat: dayMinutes.optional(),
            sun: dayMinutes.optional(),
          })
          .nullable(),
      }),
    )
    .max(50),
  schedules: z
    .array(
      z.strictObject({
        id: ruleId,
        kind: z.enum(["school", "bedtime", "custom"]),
        name: text(60),
        days: z.array(weekday).max(7),
        start: hhmm,
        /** At or before `start`: ends the next day. */
        end: hhmm,
        allow: z.array(packageName).max(500),
        lock: z.boolean(),
        skip: z.array(ymd).max(366),
      }),
    )
    .max(20),
  exempt: z.array(packageName).max(500),
  if_unmeasured: z.enum(["pause_limited", "keep_open"]),
  extra: z
    .array(
      z.strictObject({
        id: ruleId,
        /** "*": every limit. */
        limit_id: limitRef,
        minutes: z.int().min(1).max(1440),
        day: ymd,
        request_id: clientId.nullable(),
        /** Only this app may use the minutes. */
        package: packageName.nullable(),
      }),
    )
    .max(100),
  self_serve: z.strictObject({ minutes: z.int().min(1).max(240), times: z.int().min(1).max(10) }).nullable(),
  warn_before: z.int().min(0).max(60),
});
export type ScreenTime = z.infer<typeof ScreenTime>;

/** Phase 4: the policy's `location` (docs/protocol.md, "Location rules"). */
export const Location = z.strictObject({
  mode: z.enum(["off", "on_demand", "periodic"]),
  every_minutes: z.int().min(15).max(120).nullable(),
  hours: z.strictObject({ start: hhmm, end: hhmm }).nullable(),
  provider: z.enum(["gps", "fused"]),
  fallback_fused: z.boolean(),
  places: z
    .array(
      z.strictObject({
        id: ruleId,
        name: text(40),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radius_m: z.int().min(50).max(1000),
        notify: z.array(z.enum(["arrive", "leave"])).max(2),
      }),
    )
    .max(LIMITS.maxPlaces),
  keep_on: z.boolean(),
  lost: z.strictObject({ since: time, message: text(120) }).nullable(),
});
export type Location = z.infer<typeof Location>;

/** Phase 3: the stage, for the kid's screen. `unlocks` and `how` are the family's words. */
export const Stage = z.strictObject({
  name: text(60),
  number: z.int().min(0),
  since: time,
  next: z
    .strictObject({
      name: text(60),
      unlocks: z.array(text(300)).max(30),
      how: text(1000).nullable(),
      screen_time: ScreenTime.nullable(),
    })
    .nullable(),
});
export const Agreement = z.strictObject({
  version: z.int().min(1),
  sections: z.array(z.strictObject({ title: text(200), text: text(2000) })).max(20),
  kid_agreed_at: time.nullable(),
  parents_agreed_at: time.nullable(),
});

/**
 * The policy the server sends (docs/protocol.md, "Policy"). The agent's Protocol.kt mirrors
 * it; every field has a default there that enforces nothing.
 */
export const RequestStatus = z.enum(["pending", "approved", "declined", "talk"]);
export const Policy = z.strictObject({
  version: z.int().min(0),
  issued_at: time,
  apps: z.strictObject({
    new_apps: z.enum(["allow", "ask"]),
    decisions: z.array(z.strictObject({ package: packageName, state: z.enum(["allowed", "blocked"]) })),
  }),
  pause: z.strictObject({ until: time.nullable(), note: text(500).nullable() }).nullable(),
  restrictions: z.strictObject({
    safe_boot: z.boolean(),
    add_user: z.boolean(),
    unknown_sources: z.boolean(),
    config_vpn: z.boolean(),
    config_private_dns: z.boolean(),
    config_date_time: z.boolean(),
    config_default_apps: z.boolean(),
    modify_accounts: z.boolean(),
    sim: z.boolean(),
    factory_reset: z.boolean(),
    debugging: z.boolean(),
  }),
  web: z.strictObject({
    private_dns: text(253).nullable(),
    chrome: z
      .strictObject({
        incognito: z.boolean(),
        safe_search: z.boolean(),
        youtube_restrict: z.enum(["off", "moderate", "strict"]),
        safe_sites: z.boolean(),
        allow_downloads: z.boolean(),
        url_allowlist: z.array(text(500)).nullable(),
        url_blocklist: z.array(text(500)),
      })
      .nullable(),
    hide_browsers: z.boolean(),
  }),
  maintenance_until: time.nullable(),
  frp_accounts: z.array(text(64)),
  support_message: text(200).nullable(),
  requests: z.array(
    z.strictObject({
      id: clientId,
      status: RequestStatus,
      note: text(1000).nullable(),
      answered_at: time.nullable(),
      answered_by: text(60).nullable(),
      /** Phase 3: the minutes given, for an approved more_time request; null otherwise. */
      minutes: z.int().min(1).max(1440).nullable(),
    }),
  ),
  /** Phase 6: the version of Belay a parent approved for this phone, if any. */
  agent_update: z
    .strictObject({
      version_code: versionCode,
      version_name: text(50).nullable(),
      sha256: sha256Hex,
      size: z.int().min(1).max(LIMITS.maxAgentBytes),
    })
    .nullable(),
  /** Phase 6: the recovery key's check (family/recovery.ts); never the key. */
  recovery: z
    .strictObject({ version: z.int().min(1), salt: z.string().regex(/^[0-9a-f]{32}$/), hash: sha256Hex })
    .nullable(),
  /** One-shot commands the phone hasn't reported done. */
  commands: z.array(
    z.strictObject({
      id: clientId,
      kind: z.enum(["remove_other_users", "lock_now", "locate_now"]),
      issued_at: time,
      expires_at: time.nullable(),
      /** The AI app a parent used to ask (its name), for the kid's notice; null when a person asked. */
      via: text(60).nullable(),
    }),
  ),
  /** Phase 3: null measures nothing and limits nothing (family/screentime). */
  screen_time: ScreenTime.nullable(),
  /** Phase 3: the stage the phone is on, for the kid's screen. */
  stage: Stage.nullable(),
  /** Phase 3: the family agreement's current version, for the kid's screen. */
  agreement: Agreement.nullable(),
  /** Phase 3, later: the phone doesn't log yet, so the server always sends off. */
  network_log: z.strictObject({ enabled: z.boolean() }),
  /** Phase 4: null until a parent first sets location on the phone; mode off: no location at all. */
  location: Location.nullable(),
  /** Phase 7: the data categories (the AI scopes' ids) the parents' AI app may read, for "What your parent can see". */
  ai_reads: z.array(text(40)).max(20),
  /** Phase 7: when a parent saw each help request, the last 30 days, newest first. */
  help_seen: z.array(z.strictObject({ request_id: clientId, at: time, by: text(60).nullable() })).max(200),
  /** Phase 7: the numbers on the phone's emergency card. */
  parent_numbers: z.array(z.strictObject({ name: text(40), number: e164 })).max(LIMITS.maxParentNumbers),
  // Phase 5: optional until the server builds them; the phone reads a missing one as "leave calls alone".
  calls: z
    .strictObject({
      mode: z.enum(["open", "contacts"]),
      unknown: z.enum(["reject", "voicemail", "ring"]),
      withheld: z.enum(["reject", "voicemail", "ring"]),
      outgoing: z.enum(["contacts", "any"]),
      quiet: z.boolean(),
      log: z.boolean(),
    })
    .nullable()
    .optional(),
  contacts: z
    .array(
      z.strictObject({
        id: ruleId,
        name: text(60),
        numbers: z.array(e164).min(1).max(5),
        calls: z.boolean(),
        texts: z.boolean(),
        parent: z.boolean(),
      }),
    )
    .max(LIMITS.maxContacts)
    .optional(),
  /** Phase 5: numbers Belay never records or reads, beyond 988 and emergency numbers. */
  private_numbers: z.array(e164).max(50).optional(),
  /** Phase 5: numbers a parent blocked (Android's block list, set by Belay as the dialer). */
  blocked_numbers: z.array(e164).max(500).optional(),
});
export type Policy = z.infer<typeof Policy>;
