/**
 * The device API (docs/protocol.md), mirroring the agent's Protocol.kt. Every object is strict:
 * an unknown field is an error, not silence. Optional fields may be omitted or null.
 */
import { z } from "zod";

export const LIMITS = {
  enrollBytes: 16 * 1024,
  checkinBytes: 32 * 1024,
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

export const Version = z.strictObject({ name: text().nullish(), code: versionCode });

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

/** Something the kid asks a parent for. Sending the same id again updates a pending request's reason. */
export const Request = z.strictObject({
  id: clientId,
  kind: z.enum(["app"]),
  package: packageName,
  label: text(LIMITS.maxLabel),
  reason: text(LIMITS.maxReason).nullish(),
  asked_at: time,
});
export type Request = z.infer<typeof Request>;
export const RequestsRequest = z.strictObject({ requests: z.array(Request).min(1).max(LIMITS.maxRequests) });

export const PolicyQuery = z.strictObject({
  /** The version the phone has; the server answers at once if it has a different one. */
  have: z.coerce.number().int().min(-1).optional(),
  /** Seconds to hold the request open for a change (long-poll); 0 answers at once. */
  wait: z.coerce.number().int().min(0).max(LIMITS.maxWaitSeconds).optional(),
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
    z.strictObject({ id: clientId, kind: z.enum(["remove_other_users"]), issued_at: time, expires_at: time.nullable() }),
  ),
});
export type Policy = z.infer<typeof Policy>;
