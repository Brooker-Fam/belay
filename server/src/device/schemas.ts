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
});
export type Health = z.infer<typeof Health>;

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
