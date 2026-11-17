import type { DB } from "./db.js";
import { isValidTimeZone } from "./time.js";

/** Data categories AI clients may read, decided on the Settings page. Phase 1 has two. */
export const AI_SCOPES = {
  apps: "Apps: installed apps, their permissions, app changes and reviews",
  device_status: "Device status: model, Android version, battery, storage and Belay's health on the phone",
} as const;
export type AiScope = keyof typeof AI_SCOPES;

export interface Settings {
  /** IANA zone: how times are shown on the parent pages and over MCP. */
  timezone: string;
  /** A phone that hasn't checked in for this long is reported as silent. */
  silentHours: number;
  aiScopes: Record<AiScope, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: "UTC",
  silentHours: 12,
  aiScopes: { apps: true, device_status: true },
};

function read(db: DB, key: string): unknown {
  const row = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

function write(db: DB, key: string, value: unknown): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

export function getSettings(db: DB): Settings {
  const timezone = read(db, "timezone");
  const silentHours = read(db, "silent_hours");
  const scopes = read(db, "ai_scopes") as Partial<Record<AiScope, unknown>> | undefined;
  return {
    timezone: typeof timezone === "string" && isValidTimeZone(timezone) ? timezone : DEFAULT_SETTINGS.timezone,
    silentHours: typeof silentHours === "number" && silentHours >= 1 ? silentHours : DEFAULT_SETTINGS.silentHours,
    aiScopes: {
      apps: typeof scopes?.apps === "boolean" ? scopes.apps : DEFAULT_SETTINGS.aiScopes.apps,
      device_status: typeof scopes?.device_status === "boolean" ? scopes.device_status : DEFAULT_SETTINGS.aiScopes.device_status,
    },
  };
}

export function updateSettings(db: DB, change: Partial<Settings>): Settings {
  if (change.timezone !== undefined) {
    if (!isValidTimeZone(change.timezone)) throw new Error(`Unknown timezone: ${change.timezone}`);
    write(db, "timezone", change.timezone);
  }
  if (change.silentHours !== undefined) write(db, "silent_hours", change.silentHours);
  if (change.aiScopes !== undefined) write(db, "ai_scopes", change.aiScopes);
  return getSettings(db);
}
