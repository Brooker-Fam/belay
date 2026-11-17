import type { DB } from "./db.js";
import { isValidTimeZone } from "./time.js";

/** Data categories AI clients may read, decided on the Settings page. All on by default. */
export const AI_SCOPES = {
  apps: "Apps: installed apps, their permissions, app changes and reviews",
  device_status: "Device status: model, Android version, battery, storage and Belay's health on the phone",
  requests: "Requests: what the kid asks for, and why, in their words",
} as const;
export type AiScope = keyof typeof AI_SCOPES;

export interface Settings {
  /** IANA zone: how times are shown on the parent pages and over MCP. */
  timezone: string;
  /** A phone that hasn't checked in for this long is reported as silent. */
  silentHours: number;
  aiScopes: Record<AiScope, boolean>;
  /**
   * Categories added since the family last saved its choices (none if they never did). Each is
   * off if the family had turned any category off, else on, like the rest.
   */
  newAiScopes: AiScope[];
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: "UTC",
  silentHours: 12,
  aiScopes: { apps: true, device_status: true, requests: true },
  newAiScopes: [],
};

const SCOPE_KEYS = Object.keys(AI_SCOPES) as AiScope[];

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
  const stored = read(db, "ai_scopes");
  const scopes = stored && typeof stored === "object" ? (stored as Partial<Record<AiScope, unknown>>) : undefined;
  // A family that turned any category off chose what AI apps see: a category added since starts off.
  const optedOut = scopes !== undefined && Object.values(scopes).some((v) => v === false);
  const scope = (key: AiScope): boolean => {
    const value = scopes?.[key];
    if (typeof value === "boolean") return value;
    return optedOut ? false : DEFAULT_SETTINGS.aiScopes[key];
  };
  return {
    timezone: typeof timezone === "string" && isValidTimeZone(timezone) ? timezone : DEFAULT_SETTINGS.timezone,
    silentHours: typeof silentHours === "number" && silentHours >= 1 ? silentHours : DEFAULT_SETTINGS.silentHours,
    aiScopes: { apps: scope("apps"), device_status: scope("device_status"), requests: scope("requests") },
    newAiScopes: scopes ? SCOPE_KEYS.filter((key) => typeof scopes[key] !== "boolean") : [],
  };
}

/** A change to the settings; AI scopes left out keep their value. */
export interface SettingsChange {
  timezone?: string;
  silentHours?: number;
  aiScopes?: Partial<Record<AiScope, boolean>>;
}

export function updateSettings(db: DB, change: SettingsChange): Settings {
  if (change.timezone !== undefined) {
    if (!isValidTimeZone(change.timezone)) throw new Error(`Unknown timezone: ${change.timezone}`);
    write(db, "timezone", change.timezone);
  }
  if (change.silentHours !== undefined) write(db, "silent_hours", change.silentHours);
  if (change.aiScopes !== undefined) write(db, "ai_scopes", { ...getSettings(db).aiScopes, ...change.aiScopes });
  return getSettings(db);
}
