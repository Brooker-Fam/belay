/**
 * Phase 13's Wi-Fi-only changes in the parents' words, for proposals, the activity log and MCP.
 * App names come from their developers (untrusted); with no labels (an AI app without the Apps
 * category), the apps are only counted.
 */
import { oneLine } from "../../text.js";
import type { Labels } from "../screentime/words.js";
import type { WifiOnlyPatch } from "./changes.js";

/** "Video Tube", "Video Tube and Block Party", "A, B, C and 2 more"; with no labels, "2 apps". */
export function appList(packages: readonly string[], label: Labels | null, max = 3): string {
  if (label === null) return packages.length === 1 ? "an app" : `${packages.length} apps`;
  const names = packages.map((p) => oneLine(label(p), 40) || p);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > max + 1) return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export interface WifiOnlyWords {
  effect: "tightens" | "loosens";
  /** "Make Video Tube Wi-Fi only", "Let Video Tube use mobile data again". */
  words: string;
  /** "making Video Tube Wi-Fi only", "letting Video Tube use mobile data again". */
  gerund: string;
}

/** Each part of a change to the Wi-Fi-only apps, taking off first (it's what a parent decides). */
export function wifiOnlyWords(patch: WifiOnlyPatch, label: Labels | null): WifiOnlyWords[] {
  return [
    ...(patch.remove.length
      ? [
          {
            effect: "loosens" as const,
            words: `Let ${appList(patch.remove, label)} use mobile data again`,
            gerund: `letting ${appList(patch.remove, label)} use mobile data again`,
          },
        ]
      : []),
    ...(patch.add.length
      ? [{ effect: "tightens" as const, words: `Make ${appList(patch.add, label)} Wi-Fi only`, gerund: `making ${appList(patch.add, label)} Wi-Fi only` }]
      : []),
  ];
}

/** A change's title and gerund: its parts joined, the first capitalised. */
export function wifiOnlyTitle(patch: WifiOnlyPatch, label: Labels | null): { title: string; gerund: string } {
  const parts = wifiOnlyWords(patch, label);
  if (!parts.length) return { title: "Change nothing about Wi-Fi only", gerund: "changing nothing about Wi-Fi only" };
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  return {
    title: [parts[0]?.words ?? "", ...parts.slice(1).map((p) => lower(p.words))].join(", and "),
    gerund: parts.map((p) => p.gerund).join(", and "),
  };
}
