// tsc only emits JavaScript: copy the SQL migrations and static files next to it.
import { cpSync } from "node:fs";
import { URL } from "node:url";

for (const dir of ["migrations", "static"]) {
  cpSync(new URL(`../src/${dir}`, import.meta.url), new URL(`../dist/${dir}`, import.meta.url), { recursive: true });
}
