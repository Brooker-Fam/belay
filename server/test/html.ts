/**
 * Just enough of an HTML parser for the parent pages' structure tests: Hono's JSX writes
 * well-formed markup with double-quoted attributes and escaped text, so a tag-by-tag walk builds the
 * tree. Not for HTML from anywhere else.
 */
export interface El {
  tag: string;
  attrs: Map<string, string>;
  children: (El | string)[];
  parent: El | null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*"([^"]*)")?/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENTITIES[e] ?? "");

export function parseHtml(html: string): El {
  const root: El = { tag: "#document", attrs: new Map(), children: [], parent: null };
  let current = root;
  for (const m of html.matchAll(TOKEN)) {
    const [, closing, opening, attrText = "", selfClosing, text] = m;
    if (text !== undefined) {
      current.children.push(decode(text));
    } else if (opening) {
      const attrs = new Map<string, string>();
      for (const a of attrText.matchAll(ATTR)) if (a[1]) attrs.set(a[1].toLowerCase(), decode(a[2] ?? ""));
      const el: El = { tag: opening.toLowerCase(), attrs, children: [], parent: current };
      current.children.push(el);
      if (!selfClosing && !VOID.has(el.tag)) current = el;
    } else if (closing) {
      const tag = closing.toLowerCase();
      // Close up to the matching element; a stray closing tag is ignored.
      for (let el: El | null = current; el && el !== root; el = el.parent) {
        if (el.tag === tag) {
          current = el.parent ?? root;
          break;
        }
      }
    }
  }
  return root;
}

export function elements(root: El): El[] {
  const out: El[] = [];
  const walk = (el: El) => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

export function textOf(el: El): string {
  return el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

export function closest(el: El, tag: string): El | null {
  for (let p = el.parent; p; p = p.parent) if (p.tag === tag) return p;
  return null;
}

const describe = (el: El) => `<${el.tag}${[...el.attrs].map(([k, v]) => ` ${k}="${v.slice(0, 40)}"`).join("")}>`;

/**
 * What a screen reader or a phone would trip over on a page: no lang or viewport, not exactly one
 * h1, a skipped heading level, a duplicate id, a label for nothing, a field without a label, a
 * button or link without a name, an image without words.
 */
export function structureProblems(html: string): string[] {
  const doc = parseHtml(html);
  const all = elements(doc);
  const out: string[] = [];
  if (all.find((e) => e.tag === "html")?.attrs.get("lang") !== "en") out.push('no lang="en" on <html>');
  if (!all.some((e) => e.tag === "meta" && e.attrs.get("name") === "viewport" && (e.attrs.get("content") ?? "").includes("width=device-width"))) out.push("no viewport meta tag");
  const h1 = all.filter((e) => e.tag === "h1").length;
  if (h1 !== 1) out.push(`${h1} h1 elements`);
  let level = 0;
  for (const h of all.filter((e) => /^h[1-6]$/.test(e.tag))) {
    const n = Number(h.tag[1]);
    if (level && n > level + 1) out.push(`h${level} then ${h.tag}: "${textOf(h).trim()}"`);
    level = n;
  }
  const ids = new Map<string, number>();
  for (const e of all) {
    const id = e.attrs.get("id");
    if (id !== undefined) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  for (const [id, n] of ids) if (n > 1) out.push(`id "${id}" ${n} times`);
  for (const label of all.filter((e) => e.tag === "label" && e.attrs.has("for"))) {
    if (!ids.has(label.attrs.get("for") ?? "")) out.push(`label for a missing id: ${describe(label)}`);
  }
  const labelled = new Set(all.filter((e) => e.tag === "label").map((e) => e.attrs.get("for")));
  for (const e of all.filter((x) => x.tag === "input" || x.tag === "select" || x.tag === "textarea")) {
    if (e.tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(e.attrs.get("type") ?? "text")) continue;
    const id = e.attrs.get("id");
    const named = e.attrs.has("aria-label") || e.attrs.has("aria-labelledby") || (id !== undefined && labelled.has(id)) || closest(e, "label") !== null;
    if (!named) out.push(`field without a label: ${describe(e)}`);
  }
  for (const e of all.filter((x) => x.tag === "button" || (x.tag === "a" && x.attrs.has("href")) || x.tag === "summary")) {
    const name = (e.attrs.get("aria-label") ?? textOf(e)).trim();
    if (!name && !e.attrs.has("aria-labelledby")) out.push(`no name: ${describe(e)}`);
  }
  for (const e of all.filter((x) => x.tag === "img" || x.attrs.get("role") === "img")) {
    if (e.tag === "img" ? !e.attrs.has("alt") : !(e.attrs.get("aria-label") ?? "").trim()) out.push(`image without words: ${describe(e)}`);
  }
  return out;
}
