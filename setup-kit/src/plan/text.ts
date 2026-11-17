// The plan's events as text, exactly as provision.sh prints them (lib.sh's say, info, warn, die
// and run), so the command-line runner and provision.sh say the same, byte for byte.

import type { PlanEvent } from "./interpreter.js";

export interface TextOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

const eachLine = (text: string, prefix: string): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}\n`)
    .join("");

export function printer(out: TextOutput): (event: PlanEvent) => void {
  return (event) => {
    switch (event.type) {
      case "say":
        if (event.prefix !== undefined && event.prefix !== "") {
          out[event.level === "err" ? "stderr" : "stdout"](eachLine(event.text, event.prefix));
        } else if (event.level === "say") out.stdout(`${event.text}\n`);
        else if (event.level === "info") out.stdout(`  ${event.text}\n`);
        else if (event.level === "warn") out.stderr(`WARNING: ${event.text}\n`);
        else out.stderr(`${event.text}\n`);
        return;
      case "stop": {
        const [first = "", ...rest] = event.lines;
        out.stderr(`\nSTOPPED: ${first}\n${rest.map((line) => eachLine(line, "  ")).join("")}`);
        return;
      }
      case "dryRun":
        out.stdout(`  [dry run] ${event.command}\n`);
        return;
      case "output":
        out.stdout(eachLine(event.text, "  "));
        return;
      case "stream":
        out[event.stream](event.text);
        return;
      case "step":
      case "command":
        return;
    }
  };
}
