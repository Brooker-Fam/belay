// The plan's texts and conditions, as lib.sh's plan_expand and plan_cond read them.

import type { Conditions } from "./plan.js";

/** The plan's variables: {name} in its texts. Unset ones are empty. */
export type Vars = Map<string, string>;

const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/g;

/** The text with each {name} replaced by that variable, in one pass; other braces stay. */
export function expand(text: string, vars: Vars): string {
  return text.replace(PLACEHOLDER, (_, name: string) => vars.get(name) ?? "");
}

// [!]{a}[OP text]: the variables on the left, an operator, and a text that is a template too.
const CONDITION = /^(!?)((?:\{[a-z_][a-z0-9_]*\})+)(!=|=|~|<)?(.*)$/s;
const WHOLE_NUMBER = /^-?[0-9]+$/;

/**
 * Whether a condition holds. "{a}" alone: the variable isn't empty. "=", "!=", "~" (contains)
 * and "<" (a whole number below; empty counts as 0) compare it with the text after them. A
 * leading "!" turns the answer around.
 */
export function holds(condition: string, vars: Vars): boolean {
  const m = CONDITION.exec(condition);
  if (m === null) throw new Error(`can't read the condition "${condition}"`);
  const [, not = "", left = "", op = "", right = ""] = m;
  if (op === "" && right !== "") throw new Error(`can't read the condition "${condition}"`);
  let a = expand(left, vars);
  const b = expand(right, vars);
  let yes: boolean;
  switch (op) {
    case "":
      yes = a !== "";
      break;
    case "=":
      yes = a === b;
      break;
    case "!=":
      yes = a !== b;
      break;
    case "~":
      yes = a.includes(b);
      break;
    default:
      a = a === "" ? "0" : a;
      yes = WHOLE_NUMBER.test(a) && WHOLE_NUMBER.test(b) && Number.parseInt(a, 10) < Number.parseInt(b, 10);
  }
  return not === "!" ? !yes : yes;
}

/** Whether a step runs: every "when" holds, and not every "unless". */
export function runs(step: Conditions, vars: Vars): boolean {
  if (step.when !== undefined && !step.when.every((c) => holds(c, vars))) return false;
  return step.unless === undefined || step.unless.length === 0 || !step.unless.every((c) => holds(c, vars));
}
