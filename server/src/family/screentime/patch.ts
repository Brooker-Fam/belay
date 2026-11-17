/**
 * A change to a phone's screen-time rules as an AI app's proposal keeps it: each part it changes,
 * with what that part was when it was proposed. When a parent approves, the parts must still be
 * as they were (otherwise the proposal is out of date and nothing is applied); the rest of the
 * rules may have changed meanwhile and stay as they are.
 */
import { type RulesSide } from "./classify.js";
import type { IfUnmeasured, Limit, RuleSet, Schedule, SelfServe } from "./rules.js";
import { canonical } from "./rules.js";

export interface RulesPatch {
  limits: { id: string; before: Limit | null; after: Limit | null }[];
  schedules: { id: string; before: Schedule | null; after: Schedule | null }[];
  exempt?: { before: string[]; after: string[] };
  if_unmeasured?: { before: IfUnmeasured; after: IfUnmeasured };
  self_serve?: { before: SelfServe | null; after: SelfServe | null };
  warn_before?: { before: number; after: number };
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sorted = (list: string[]) => [...new Set(list)].sort();

function items<T extends { id: string }>(before: T[], after: T[]): { id: string; before: T | null; after: T | null }[] {
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const out: { id: string; before: T | null; after: T | null }[] = [];
  for (const r of before) {
    const next = now.get(r.id) ?? null;
    if (!next || !same(next, r)) out.push({ id: r.id, before: r, after: next });
  }
  for (const r of after) if (!was.has(r.id)) out.push({ id: r.id, before: null, after: r });
  return out;
}

/** The parts that differ from `before` to `after`. */
export function patchOf(before: RuleSet, after: RuleSet): RulesPatch {
  const patch: RulesPatch = { limits: items(before.limits, after.limits), schedules: items(before.schedules, after.schedules) };
  if (!same(sorted(before.exempt), sorted(after.exempt))) patch.exempt = { before: sorted(before.exempt), after: sorted(after.exempt) };
  if (before.if_unmeasured !== after.if_unmeasured) patch.if_unmeasured = { before: before.if_unmeasured, after: after.if_unmeasured };
  if (!same(before.self_serve, after.self_serve)) patch.self_serve = { before: before.self_serve, after: after.self_serve };
  if (before.warn_before !== after.warn_before) patch.warn_before = { before: before.warn_before, after: after.warn_before };
  return patch;
}

export const emptyPatch = (p: RulesPatch) =>
  !p.limits.length && !p.schedules.length && !p.exempt && !p.if_unmeasured && !p.self_serve && p.warn_before === undefined;

function applyItems<T extends { id: string; name: string }>(list: T[], changes: RulesPatch["limits" | "schedules"], what: string): T[] | string {
  const out = [...list];
  for (const change of changes as { id: string; before: T | null; after: T | null }[]) {
    const index = out.findIndex((r) => r.id === change.id);
    const current = index < 0 ? null : (out[index] ?? null);
    if (!same(current, change.before)) {
      const name = change.before?.name ?? change.after?.name ?? "";
      return `The ${what} ${name} changed after this was proposed.`;
    }
    if (change.after === null) out.splice(index, 1);
    else if (index < 0) out.push(change.after);
    else out[index] = change.after;
  }
  return out;
}

/**
 * The rules with the patch applied, or why it's out of date: a part it changes isn't as it was
 * when it was proposed.
 */
export function applyPatch(current: RuleSet, patch: RulesPatch): { rules: RuleSet } | { outdated: string } {
  const limits = applyItems(current.limits, patch.limits, "limit");
  if (typeof limits === "string") return { outdated: limits };
  const schedules = applyItems(current.schedules, patch.schedules, "schedule");
  if (typeof schedules === "string") return { outdated: schedules };
  if (patch.exempt && !same(sorted(current.exempt), patch.exempt.before)) return { outdated: "The exempt apps changed after this was proposed." };
  if (patch.if_unmeasured && current.if_unmeasured !== patch.if_unmeasured.before) return { outdated: `What happens when Belay can't count changed after this was proposed.` };
  if (patch.self_serve && !same(current.self_serve, patch.self_serve.before)) return { outdated: "Self-serve changed after this was proposed." };
  if (patch.warn_before && current.warn_before !== patch.warn_before.before) return { outdated: "The warning changed after this was proposed." };
  return {
    rules: {
      limits,
      schedules,
      exempt: patch.exempt ? [...patch.exempt.after] : current.exempt,
      if_unmeasured: patch.if_unmeasured?.after ?? current.if_unmeasured,
      self_serve: patch.self_serve ? patch.self_serve.after : current.self_serve,
      warn_before: patch.warn_before?.after ?? current.warn_before,
    },
  };
}

/** The patch's parts alone, as the two sides of a change, for its words. */
export function patchSides(patch: RulesPatch): { before: RulesSide; after: RulesSide } {
  const pick = <T>(list: { before: T | null; after: T | null }[], side: "before" | "after") => list.flatMap((c) => (c[side] ? [c[side]] : []));
  return {
    before: {
      limits: pick(patch.limits, "before"),
      schedules: pick(patch.schedules, "before"),
      ...(patch.exempt ? { exempt: patch.exempt.before } : {}),
      ...(patch.if_unmeasured ? { if_unmeasured: patch.if_unmeasured.before } : {}),
      ...(patch.self_serve ? { self_serve: patch.self_serve.before } : {}),
      ...(patch.warn_before ? { warn_before: patch.warn_before.before } : {}),
    },
    after: {
      limits: pick(patch.limits, "after"),
      schedules: pick(patch.schedules, "after"),
      ...(patch.exempt ? { exempt: patch.exempt.after } : {}),
      ...(patch.if_unmeasured ? { if_unmeasured: patch.if_unmeasured.after } : {}),
      ...(patch.self_serve ? { self_serve: patch.self_serve.after } : {}),
      ...(patch.warn_before ? { warn_before: patch.warn_before.after } : {}),
    },
  };
}
