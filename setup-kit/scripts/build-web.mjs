// Builds the page into dist/web: src/web/main.ts and everything it imports (the plan's
// interpreter, the APK reader, Tango) bundled into one app.js, next to index.html and style.css.
// Nothing is loaded from the internet when the page runs. Not minified, so it can be read.

import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const out = new URL("../dist/web/", import.meta.url);
await mkdir(out, { recursive: true });
await build({
  entryPoints: [new URL("../src/web/main.ts", import.meta.url).pathname],
  outfile: new URL("app.js", out).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  legalComments: "eof",
  banner: {
    js: "// Belay setup kit, the page (Apache-2.0). Bundles Tango (ya-webadb), Copyright (c) 2020-2025 Simon Chan, and\n// @yume-chan/async, Copyright (c) 2019 Simon Chan, both under the MIT License (see NOTICE).",
  },
  logLevel: "warning",
});
for (const file of ["index.html", "style.css"]) await copyFile(new URL(`../src/web/${file}`, import.meta.url), new URL(file, out));
console.log(`built ${out.pathname}`);
