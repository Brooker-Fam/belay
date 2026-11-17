import type { DB } from "./db.js";
import { e164 } from "./device/schemas.js";
import { isValidTimeZone } from "./time.js";

/**
 * Data categories AI clients may read, decided on the Settings page. Their ids are the phone's
 * data categories (the policy's `ai_reads` lists the ones that are on, for the kid's screen). All
 * on by default except location, calls and network, which start off for every family.
 */
export const AI_SCOPES = {
  apps: "Apps: installed apps, their permissions, app changes and reviews",
  device_status: "Device status: model, Android version, battery, storage and Belay's health on the phone",
  requests: "Requests: what the kid asks for, and why, in their words, including \"I need help\" and \"Talk to my parent\"",
  screen_time: "Screen time: how long each app is used each day, when the phone is used, and the time left today",
  agreement: "Stage and agreement: the phone's stage, the family agreement, and the kid's answers to it",
  location: "Location: where the phone is (each check, and the fixes Belay shares), the family's places, and arrivals and departures",
  calls: "Calls: who the kid calls and who calls them, when and for how long, and the numbers of contacts and of callers who aren't one (never 911, 988 or private numbers)",
  network: "Network: which websites and online services each app looks up, by name, and how many times a day (never pages or what's typed, never 988's websites)",
} as const;
export type AiScope = keyof typeof AI_SCOPES;

/**
 * Off by default for every family, whatever it chose before: AI apps never see where the phone is,
 * who calls the kid (other people's numbers too), or which websites apps look up, unless a parent
 * says so.
 */
export const OFF_BY_DEFAULT: readonly AiScope[] = ["location", "calls", "network"];

/** Phase 4: how long the server keeps where the phone was, in days (the hourly clean-up deletes the rest). */
export interface LocationRetention {
  /** Periodic fixes (and the sooner ones near a place's edge). */
  periodic: number;
  /** A parent's (or their AI app's) checks: locate_now's fixes. */
  checks: number;
  /** Arrivals and departures. */
  placeEvents: number;
  /** Lost-mode fixes: this long after lost mode ends. */
  lostAfter: number;
}

export const LOCATION_DAYS: Record<keyof LocationRetention, { default: number; min: number; max: number }> = {
  periodic: { default: 7, min: 1, max: 30 },
  checks: { default: 30, min: 1, max: 90 },
  placeEvents: { default: 90, min: 1, max: 365 },
  lostAfter: { default: 7, min: 1, max: 30 },
};

/** Phase 4: the map site "Open in a map" links go to. Only the parent's browser follows one, when clicked. */
export const MAP_SITES = {
  openstreetmap: "OpenStreetMap",
  google: "Google Maps",
} as const;
export type MapSite = keyof typeof MAP_SITES;

/** Phase 7: a number on the emergency card. */
export interface ParentNumber {
  /** The family's words ("Mom"), at most 40 characters. */
  name: string;
  /** E.164. */
  number: string;
}
export const MAX_PARENT_NUMBERS = 4;

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
  /** Phase 4: how long where the phone was is kept. */
  locationDays: LocationRetention;
  /** Phase 4: where "Open in a map" goes. */
  mapSite: MapSite;
  /** Phase 7: the family's numbers for every phone's emergency card (a phone may have its own instead). */
  parentNumbers: ParentNumber[];
  /** Phase 5: how many days of call records the server keeps; older ones are deleted. */
  callDays: number;
  /** Phase 3, network logging: how many days of network activity the server keeps; older ones are deleted. */
  networkDays: number;
}

export const USAGE_MONTHS = { default: 13, min: 1, max: 36 } as const;
/** Phase 5: call records' retention, in days. */
export const CALL_DAYS = { default: 90, min: 1, max: 365 } as const;
/** Phase 3, network logging: network days' retention, in days. */
export const NETWORK_DAYS = { default: 30, min: 1, max: 90 } as const;

export const DEFAULT_SETTINGS: Settings = {
  timezone: "UTC",
  silentHours: 12,
  aiScopes: { apps: true, device_status: true, requests: true, screen_time: true, agreement: true, location: false, calls: false, network: false },
  newAiScopes: [],
  usageMonths: USAGE_MONTHS.default,
  locationDays: { periodic: LOCATION_DAYS.periodic.default, checks: LOCATION_DAYS.checks.default, placeEvents: LOCATION_DAYS.placeEvents.default, lostAfter: LOCATION_DAYS.lostAfter.default },
  mapSite: "openstreetmap",
  parentNumbers: [],
  callDays: CALL_DAYS.default,
  networkDays: NETWORK_DAYS.default,
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
const validCallDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= CALL_DAYS.min && n <= CALL_DAYS.max;
const validNetworkDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= NETWORK_DAYS.min && n <= NETWORK_DAYS.max;
const validDays = (key: keyof LocationRetention, n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= LOCATION_DAYS[key].min && n <= LOCATION_DAYS[key].max;
const RETENTION_KEYS = Object.keys(LOCATION_DAYS) as (keyof LocationRetention)[];

/** A list of numbers as stored, each one checked: anything that isn't a name and an E.164 number is left out. */
export function parentNumbersFrom(value: unknown): ParentNumber[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((v: unknown) => {
      if (!v || typeof v !== "object") return [];
      const { name, number } = v as { name?: unknown; number?: unknown };
      return typeof name === "string" && name.trim() && name.length <= 40 && typeof number === "string" && e164.safeParse(number).success ? [{ name, number }] : [];
    })
    .slice(0, MAX_PARENT_NUMBERS);
}

/** Why a list of parent numbers won't do, or null: at most 4, each a name (1 to 40 characters) and an E.164 number. */
export function parentNumbersProblem(list: ParentNumber[]): string | null {
  if (list.length > MAX_PARENT_NUMBERS) return `The emergency card has room for ${MAX_PARENT_NUMBERS} numbers.`;
  for (const p of list) {
    if (!p.name.trim() || p.name.length > 40) return "Give each number a name of 1 to 40 characters, like Mom.";
    if (!e164.safeParse(p.number).success) return `${p.number || "A number"} isn't a phone number in international form: start with + and the country code, like +15555550100.`;
  }
  return null;
}

export function getSettings(db: DB): Settings {
  const timezone = read(db, "timezone");
  const silentHours = read(db, "silent_hours");
  const usageMonths = read(db, "usage_months");
  const locationDays = read(db, "location_days");
  const mapSite = read(db, "map_site");
  const callDays = read(db, "call_days");
  const networkDays = read(db, "network_days");
  const days = locationDays && typeof locationDays === "object" ? (locationDays as Partial<Record<keyof LocationRetention, unknown>>) : {};
  const stored = read(db, "ai_scopes");
  const scopes = stored && typeof stored === "object" ? (stored as Partial<Record<AiScope, unknown>>) : undefined;
  // A family that turned any category off chose what AI apps see: a category added since starts off.
  const optedOut = scopes !== undefined && Object.values(scopes).some((v) => v === false);
  const scope = (key: AiScope): boolean => {
    const value = scopes?.[key];
    if (typeof value === "boolean") return value;
    return optedOut || OFF_BY_DEFAULT.includes(key) ? false : DEFAULT_SETTINGS.aiScopes[key];
  };
  return {
    timezone: typeof timezone === "string" && isValidTimeZone(timezone) ? timezone : DEFAULT_SETTINGS.timezone,
    silentHours: typeof silentHours === "number" && silentHours >= 1 ? silentHours : DEFAULT_SETTINGS.silentHours,
    aiScopes: Object.fromEntries(SCOPE_KEYS.map((key) => [key, scope(key)])) as Record<AiScope, boolean>,
    newAiScopes: scopes ? SCOPE_KEYS.filter((key) => typeof scopes[key] !== "boolean") : [],
    usageMonths: validMonths(usageMonths) ? usageMonths : DEFAULT_SETTINGS.usageMonths,
    locationDays: Object.fromEntries(
      RETENTION_KEYS.map((key) => {
        const n = days[key];
        return [key, validDays(key, n) ? n : LOCATION_DAYS[key].default];
      }),
    ) as unknown as LocationRetention,
    mapSite: typeof mapSite === "string" && mapSite in MAP_SITES ? (mapSite as MapSite) : DEFAULT_SETTINGS.mapSite,
    parentNumbers: parentNumbersFrom(read(db, "parent_numbers")),
    callDays: validCallDays(callDays) ? callDays : DEFAULT_SETTINGS.callDays,
    networkDays: validNetworkDays(networkDays) ? networkDays : DEFAULT_SETTINGS.networkDays,
  };
}

/** The ids of the AI scopes that are on, in Settings' order: the policy's `ai_reads`. */
export function aiReads(settings: Pick<Settings, "aiScopes">): string[] {
  return SCOPE_KEYS.filter((key) => settings.aiScopes[key]);
}

/** A change to the settings; AI scopes left out keep their value. */
export interface SettingsChange {
  timezone?: string;
  silentHours?: number;
  aiScopes?: Partial<Record<AiScope, boolean>>;
  usageMonths?: number;
  locationDays?: Partial<LocationRetention>;
  mapSite?: MapSite;
  parentNumbers?: ParentNumber[];
  callDays?: number;
  networkDays?: number;
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
  if (change.locationDays !== undefined) {
    for (const [key, n] of Object.entries(change.locationDays) as [keyof LocationRetention, number | undefined][]) {
      if (n !== undefined && !validDays(key, n)) throw new Error(`Keep ${key} ${LOCATION_DAYS[key].min} to ${LOCATION_DAYS[key].max} days`);
    }
    write(db, "location_days", { ...getSettings(db).locationDays, ...change.locationDays });
  }
  if (change.mapSite !== undefined) {
    if (!(change.mapSite in MAP_SITES)) throw new Error(`Unknown map site: ${change.mapSite}`);
    write(db, "map_site", change.mapSite);
  }
  if (change.callDays !== undefined) {
    if (!validCallDays(change.callDays)) throw new Error(`Keep call records ${CALL_DAYS.min} to ${CALL_DAYS.max} days`);
    write(db, "call_days", change.callDays);
  }
  if (change.networkDays !== undefined) {
    if (!validNetworkDays(change.networkDays)) throw new Error(`Keep network activity ${NETWORK_DAYS.min} to ${NETWORK_DAYS.max} days`);
    write(db, "network_days", change.networkDays);
  }
  if (change.parentNumbers !== undefined) {
    const problem = parentNumbersProblem(change.parentNumbers);
    if (problem) throw new Error(problem);
    write(db, "parent_numbers", change.parentNumbers.map((p) => ({ name: p.name.trim(), number: p.number })));
  }
  if (change.aiScopes !== undefined) write(db, "ai_scopes", { ...getSettings(db).aiScopes, ...change.aiScopes });
  return getSettings(db);
}
