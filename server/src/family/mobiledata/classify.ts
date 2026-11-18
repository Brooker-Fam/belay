/**
 * Whether a change to a phone's Wi-Fi-only apps tightens or loosens its rules
 * (docs/design/phase13-mobile-data.md, "Tighten or loosen"). Adding an app tightens: it may not use
 * mobile data any more. Taking one off loosens: it may again. A change that does both loosens. An
 * AI app may apply a change only when every part of it tightens; anything else is a proposal for a
 * parent (Phase 2's rule). Measuring is neither, and not here: collecting is a parent's alone.
 */

export type Effect = "tightens" | "loosens";

export interface WifiOnlyChange {
  kind: "added" | "removed";
  /** Sorted. */
  packages: string[];
  effect: Effect;
}

export interface WifiOnlyClassification {
  /** Added first, then removed. */
  changes: WifiOnlyChange[];
  /** Nothing changes. */
  none: boolean;
  /** Every part tightens (and something does): an AI app may apply it. */
  onlyTightens: boolean;
  /** "loosens" when any part does, "tightens" when every part does; "none" for no change. */
  effect: Effect | "none";
}

const minus = (a: readonly string[], b: readonly string[]): string[] => {
  const drop = new Set(b);
  return [...new Set(a)].filter((x) => !drop.has(x)).sort();
};

/** Compares the Wi-Fi-only apps before and after a change: see the top of this file. */
export function classifyWifiOnlyChange(before: readonly string[], after: readonly string[]): WifiOnlyClassification {
  const added = minus(after, before);
  const removed = minus(before, after);
  const changes: WifiOnlyChange[] = [
    ...(added.length ? [{ kind: "added" as const, packages: added, effect: "tightens" as const }] : []),
    ...(removed.length ? [{ kind: "removed" as const, packages: removed, effect: "loosens" as const }] : []),
  ];
  const none = changes.length === 0;
  const onlyTightens = !none && removed.length === 0;
  return { changes, none, onlyTightens, effect: none ? "none" : onlyTightens ? "tightens" : "loosens" };
}
