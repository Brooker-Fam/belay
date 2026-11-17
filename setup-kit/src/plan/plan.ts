// The provisioning plan: android/scripts/provision-plan.json, the steps provision.sh and the
// setup kit both run. Its format is in docs/setup-kit.md; android/scripts/lib.sh has the other
// interpreter. This file only describes and checks it.

export const PLAN_FORMAT = 1;

export type Level = "say" | "info" | "warn" | "err";

export interface Conditions {
  /** Every condition must hold. */
  when?: string[];
  /** Skipped when every condition holds. */
  unless?: string[];
}

interface Base extends Conditions {
  /** Shown as progress; with "page", a line in the page's checklist. */
  id?: string;
  page?: string;
  note?: string;
}

/** What a command's output (or a value) is checked against: exactly one of these. */
export interface Matcher {
  contains?: string;
  matches?: string;
  equals?: string;
}

export type Stderr = "drop" | "merge" | undefined;

export interface Failure {
  contains?: string;
  steps: Step[];
}

export type Step =
  | (Base & { kind: "group"; steps: Step[] })
  | (Base & { kind: "say"; text: string; level?: Level; prefix?: string })
  | (Base & { kind: "stop"; message: string[] })
  | (Base & { kind: "set"; var: string; value: string })
  | (Base & { kind: "read"; run: string[]; stderr?: Stderr; into: string; count?: string; lines?: string; indent?: string; tally?: string })
  | (Base & Matcher & { kind: "check"; run?: string[]; stderr?: Stderr; value?: string; into?: string; pass?: Step[]; fail?: Step[] })
  | (Base & Matcher & { kind: "wait"; run: string[]; stderr?: Stderr; tries: number; every: number; into?: string })
  | (Base & { kind: "run"; run: string[]; quiet?: boolean })
  | (Base & { kind: "change"; run: string[]; success: string; failures: Failure[] })
  | (Base & { kind: "install"; args: (Conditions & { arg: string })[]; success: string; failures: Failure[] })
  | (Base & { kind: "confirm"; text: string; no: string[] })
  | (Base & { kind: "sleep"; seconds: number })
  | (Base & { kind: "reboot" })
  | (Base & {
      kind: "broadcast";
      run: string[];
      retry?: { contains: string; tries: number; every: number; first?: string; note?: string };
      outcomes: { prefix?: string; contains?: string; into?: string; steps: Step[] }[];
    })
  | (Base & { kind: "apk" })
  | (Base & { kind: "device" })
  | (Base & { kind: "exit"; code: number });

export type StepKind = Step["kind"];

export interface DeviceMessages {
  notConnected: string[];
  unauthorized: string[];
  none: string[];
  several: string[];
}

export interface Plan {
  format: typeof PLAN_FORMAT;
  note?: string;
  package: string;
  admin: string;
  /** Required when a step is "device". */
  device?: { note?: string; messages: DeviceMessages };
  steps: Step[];
}

export class PlanError extends Error {}

// What each kind of step may have, beyond kind, id, page, note, when and unless. "!" marks a
// required field; the letter says its type: s string, n number, b boolean, l list of strings,
// p a list of steps, f failures, a install arguments, r retry, o broadcast outcomes, m a matcher.
const FIELDS: Record<StepKind, Record<string, string>> = {
  group: { steps: "p!" },
  say: { text: "s!", level: "s", prefix: "s" },
  stop: { message: "l!" },
  set: { var: "s!", value: "s!" },
  read: { run: "l!", stderr: "s", into: "s!", count: "s", lines: "s", indent: "s", tally: "s" },
  check: { run: "l", stderr: "s", value: "s", into: "s", pass: "p", fail: "p", contains: "s", matches: "s", equals: "s" },
  wait: { run: "l!", stderr: "s", tries: "n!", every: "n!", into: "s", contains: "s", matches: "s", equals: "s" },
  run: { run: "l!", quiet: "b" },
  change: { run: "l!", success: "s!", failures: "f!" },
  install: { args: "a!", success: "s!", failures: "f!" },
  confirm: { text: "s!", no: "l!" },
  sleep: { seconds: "n!" },
  reboot: {},
  broadcast: { run: "l!", retry: "r", outcomes: "o!" },
  apk: {},
  device: {},
  exit: { code: "n!" },
};
const COMMON = new Set(["kind", "id", "page", "note", "when", "unless"]);
const LEVELS = new Set(["say", "info", "warn", "err"]);
// lib.sh reads keys made of letters, digits and single underscores.
const KEY = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/;
const CONDITION = /^!?(\{[a-z_][a-z0-9_]*\})+((!=|=|~|<).*)?$/s;
const VARIABLE = /^[a-z_][a-z0-9_]*$/;

/**
 * Reads and checks a plan. The text must also be one lib.sh can read: no \u escapes, and keys
 * of letters, digits and single underscores.
 */
export function parsePlan(text: string): Plan {
  if (/\\u[0-9a-fA-F]{4}/.test(text)) throw new PlanError("the plan uses a \\u escape, which lib.sh can't read");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PlanError(`the plan isn't JSON: ${(e as Error).message}`);
  }
  checkKeys(raw, "plan");
  const plan = object(raw, "plan");
  if (plan.format !== PLAN_FORMAT) throw new PlanError(`the plan is format ${String(plan.format)}; this kit reads format ${PLAN_FORMAT}`);
  string(plan.package, "plan.package");
  string(plan.admin, "plan.admin");
  steps(plan.steps, "plan.steps");
  // Finding the phone's messages: needed by a plan with a device step.
  if (plan.device !== undefined || hasKind(plan.steps as Step[], "device")) {
    const device = object(plan.device, "plan.device");
    const messages = object(device.messages, "plan.device.messages");
    for (const key of ["notConnected", "unauthorized", "none", "several"]) strings(messages[key], `plan.device.messages.${key}`);
  }
  return raw as Plan;
}

function hasKind(list: Step[], kind: StepKind): boolean {
  return list.some((s) => {
    if (s.kind === kind) return true;
    const nested: Step[][] = [];
    if (s.kind === "group") nested.push(s.steps);
    if (s.kind === "check") nested.push(s.pass ?? [], s.fail ?? []);
    if (s.kind === "change" || s.kind === "install") nested.push(...s.failures.map((f) => f.steps));
    if (s.kind === "broadcast") nested.push(...s.outcomes.map((o) => o.steps));
    return nested.some((n) => hasKind(n, kind));
  });
}

function checkKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      checkKeys(item, `${where}[${i}]`);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!KEY.test(key)) throw new PlanError(`${where}: the key "${key}" isn't letters, digits and single underscores`);
      checkKeys(item, `${where}.${key}`);
    }
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PlanError(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, where: string): void {
  if (typeof value !== "string") throw new PlanError(`${where} must be a string`);
}
function strings(value: unknown, where: string, nonEmpty = true): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || (nonEmpty && value.length === 0)) {
    throw new PlanError(`${where} must be a list of strings`);
  }
}
function conditions(step: Record<string, unknown>, where: string): void {
  for (const key of ["when", "unless"] as const) {
    if (step[key] === undefined) continue;
    strings(step[key], `${where}.${key}`, false);
    for (const condition of step[key] as string[]) {
      if (!CONDITION.test(condition)) throw new PlanError(`${where}.${key}: can't read the condition "${condition}"`);
    }
  }
}

function steps(value: unknown, where: string): void {
  if (!Array.isArray(value)) throw new PlanError(`${where} must be a list of steps`);
  value.forEach((item, i) => {
    step(item, `${where}[${i}]`);
  });
}

function step(value: unknown, where: string): void {
  const s = object(value, where);
  const kind = s.kind;
  if (typeof kind !== "string" || !(kind in FIELDS)) throw new PlanError(`${where}: unknown kind "${String(kind)}"`);
  const fields = FIELDS[kind as StepKind];
  where = `${where} (${kind})`;
  for (const key of ["id", "page", "note"]) if (s[key] !== undefined) string(s[key], `${where}.${key}`);
  conditions(s, where);
  for (const key of Object.keys(s)) {
    if (!COMMON.has(key) && !(key in fields)) throw new PlanError(`${where}: unknown field "${key}"`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    const item = s[key];
    if (item === undefined) {
      if (spec.endsWith("!")) throw new PlanError(`${where}: "${key}" is missing`);
      continue;
    }
    const at = `${where}.${key}`;
    switch (spec[0]) {
      case "s":
        string(item, at);
        break;
      case "n":
        if (typeof item !== "number" || !Number.isInteger(item) || item < 0) throw new PlanError(`${at} must be a whole number`);
        break;
      case "b":
        if (typeof item !== "boolean") throw new PlanError(`${at} must be true or false`);
        break;
      case "l":
        strings(item, at);
        break;
      case "p":
        steps(item, at);
        break;
      case "f":
        if (!Array.isArray(item)) throw new PlanError(`${at} must be a list`);
        item.forEach((failure, i) => {
          const f = object(failure, `${at}[${i}]`);
          if (f.contains !== undefined) string(f.contains, `${at}[${i}].contains`);
          steps(f.steps, `${at}[${i}].steps`);
        });
        break;
      case "a":
        if (!Array.isArray(item)) throw new PlanError(`${at} must be a list`);
        item.forEach((arg, i) => {
          const a = object(arg, `${at}[${i}]`);
          string(a.arg, `${at}[${i}].arg`);
          conditions(a, `${at}[${i}]`);
        });
        break;
      case "r": {
        const r = object(item, at);
        string(r.contains, `${at}.contains`);
        if (!Number.isInteger(r.tries) || !Number.isInteger(r.every)) throw new PlanError(`${at}: tries and every must be whole numbers`);
        if (r.first !== undefined) string(r.first, `${at}.first`);
        break;
      }
      case "o":
        if (!Array.isArray(item)) throw new PlanError(`${at} must be a list`);
        item.forEach((outcome, i) => {
          const o = object(outcome, `${at}[${i}]`);
          for (const key of ["prefix", "contains", "into"]) if (o[key] !== undefined) string(o[key], `${at}[${i}].${key}`);
          steps(o.steps, `${at}[${i}].steps`);
        });
        break;
    }
  }
  if (kind === "say") {
    if (s.level !== undefined && !LEVELS.has(s.level as string)) throw new PlanError(`${where}: unknown level ${JSON.stringify(s.level)}`);
    if (s.prefix !== undefined && (s.level === "info" || s.level === "warn")) throw new PlanError(`${where}: a prefix goes with say or err only`);
  }
  if (kind === "check" || kind === "wait") {
    const matchers = ["contains", "matches", "equals"].filter((key) => s[key] !== undefined);
    if (matchers.length !== 1) throw new PlanError(`${where}: needs exactly one of contains, matches or equals`);
  }
  if (kind === "check" && (s.run === undefined) === (s.value === undefined)) throw new PlanError(`${where}: needs run or value`);
  if (kind === "read" && ["count", "lines", "tally"].filter((key) => s[key] !== undefined).length > 1) {
    throw new PlanError(`${where}: one of count, lines and tally at most`);
  }
  if (s.stderr !== undefined && s.stderr !== "drop" && s.stderr !== "merge") throw new PlanError(`${where}: stderr is "drop" or "merge"`);
  for (const key of ["into", "var"]) {
    if (s[key] !== undefined && !VARIABLE.test(s[key] as string)) throw new PlanError(`${where}: ${JSON.stringify(s[key])} isn't a variable name`);
  }
}

/** The plan's top-level steps that have a title for the page, in order. */
export function pageSteps(plan: Plan): { id: string; page: string }[] {
  return plan.steps.flatMap((s) => (s.id !== undefined && s.page !== undefined ? [{ id: s.id, page: s.page }] : []));
}
