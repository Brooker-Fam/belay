/**
 * Admin commands, run where the server runs (same BELAY_DATA_DIR and BELAY_PUBLIC_URL):
 *
 *   node dist/cli.js setup-link                  a one-time link to create the first parent
 *   node dist/cli.js create-code <phone name>    an enrollment code for a phone
 *   node dist/cli.js reset-password <username>   a new password, read from the terminal
 *   node dist/cli.js backup <file>               a consistent copy of the database, while it runs
 *   node dist/cli.js status [--json]             each phone's status, apps, rules, requests and latest changes
 *   node dist/cli.js protect "<phone>"           and policy, decide, pause, resume: see admin.ts
 */
import { createInterface } from "node:readline";
import { runCommand } from "./admin.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

/** Reads one line; with a terminal, without echoing it. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    }
    rl.once("line", (line) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write("\n");
      resolve(line);
    });
  });
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const db = openDatabase(config.dataDir);
  try {
    return await runCommand(process.argv.slice(2), {
      db,
      config,
      now: Date.now(),
      out: (line) => {
        console.log(line);
      },
      err: (line) => {
        console.error(line);
      },
      readSecret,
      interactive: process.stdin.isTTY,
      stdin: process.stdin,
    });
  } finally {
    db.close();
  }
}

process.exitCode = await main();
