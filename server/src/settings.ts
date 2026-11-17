import type { DB } from "./db.js";
import { isValidTimeZone } from "./time.js";

/** Data categories AI clients may read, decided on the Settings page. All on by default. */
export const AI_SCOPES = {
  apps: "Apps: installed apps, their permissions, app changes and reviews",
  device_status: "Device status: model, Android version, battery, storage and Belay's health on the phone",
  requests: "Requests: what the kid asks for, and why, in their words",
  screen_time: "Screen time: how long each app is used each day, when the phone is used, and the time left today",
  agreement: "Stage and agreement: the phone's stage, the family agreement, and the kid's answers to it",
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
  /** Phase 3: how many months of screen time the server keeps; older days are deleted. */
  usageMonths: number;
}

export const USAGE_MONTHS = { default: 13, min: 1, max: 36 } as const;

export const DEFAULT_SETTINGS: Settings = {
  timezone: "UTC",
  silentHours: 12,
  aiScopes: { apps: true, device_status: true, requests: true, screen_time: true, agreement: true },
  newAiScopes: [],
  usageMonths: USAGE_MONTHS.default,
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

const validMonths = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= USAGE_MONTHS.min && n <= USAGE_MONTHS.max;

export function getSettings(db: DB): Settings {
  const timezone = read(db, "timezone");
  const silentHours = read(db, "silent_hours");
  const usageMonths = read(db, "usage_months");
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
    aiScopes: Object.fromEntries(SCOPE_KEYS.map((key) => [key, scope(key)])) as Record<AiScope, boolean>,
    newAiScopes: scopes ? SCOPE_KEYS.filter((key) => typeof scopes[key] !== "boolean") : [],
    usageMonths: validMonths(usageMonths) ? usageMonths : DEFAULT_SETTINGS.usageMonths,
  };
}

/** A change to the settings; AI scopes left out keep their value. */
export interface SettingsChange {
  timezone?: string;
  silentHours?: number;
  aiScopes?: Partial<Record<AiScope, boolean>>;
  usageMonths?: number;
}

export function updateSettings(db: DB, change: SettingsChange): Settings {
  if (change.timezone !== undefined) {
    if (!isValidTimeZone(change.timezone)) throw new Error(`Unknown timezone: ${change.timezone}`);
    write(db, "timezone", change.timezone);
  }
  if (change.silentHours !== undefined) write(db, "silent_hours", change.silentHours);
  if (change.usageMonths !== undefined) {
    if (!validMonths(change.usageMonths)) throw new Error(`Keep screen time ${USAGE_MONTHS.min} to ${USAGE_MONTHS.max} months`);
    write(db, "usage_months", change.usageMonths);
  }
  if (change.aiScopes !== undefined) write(db, "ai_scopes", { ...getSettings(db).aiScopes, ...change.aiScopes });
  return getSettings(db);
}
