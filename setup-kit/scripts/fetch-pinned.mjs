// node scripts/fetch-pinned.mjs URL SHA256 FILE: downloads URL to FILE only if its SHA-256 is
// SHA256. The setup kit's Dockerfile uses it for the Android SDK's command-line tools, so the
// image needs no download tool of its own.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const [url, sha256, file] = process.argv.slice(2);
if (url === undefined || sha256 === undefined || file === undefined) {
  console.error("Usage: node fetch-pinned.mjs URL SHA256 FILE");
  process.exit(2);
}
const response = await fetch(url);
if (!response.ok) {
  console.error(`${url}: HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const got = createHash("sha256").update(bytes).digest("hex");
if (got !== sha256.toLowerCase()) {
  console.error(`${url}: its SHA-256 is ${got}, not ${sha256}. Not using it.`);
  process.exit(1);
}
await writeFile(file, bytes);
console.log(`${file}: ${bytes.length} bytes, SHA-256 checked`);
