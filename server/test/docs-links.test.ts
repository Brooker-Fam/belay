/**
 * Every relative link in the repository's Markdown files reaches a file or folder that's there, and
 * every #anchor a heading in the file it names, as GitHub makes them: the heading's text in lower
 * case, without most punctuation, each space a hyphen, and "-1", "-2" after a heading's repeats.
 * External links aren't checked: tests make no network requests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
// Not the repository's own writing: dependencies and builds. Folders whose names start with a dot
// (git's, Gradle's, and other worktrees under .claude) are left out too, all but .github.
const SKIP = new Set(["node_modules", "build", "dist", "coverage"]);

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
      found.push(...markdownFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push(join(dir, entry.name));
    }
  }
  return found.sort();
}

/** A heading's anchor, as GitHub (github-slugger) makes it from the heading's text. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** What a heading reads as once GitHub renders it: code as its text, links as their text, no tags. */
function headingText(markdown: string): string {
  // split() with the pattern's two groups: text, the backticks, the code, text, …
  const parts = markdown.split(/(`+)([\s\S]*?[^`])\1(?!`)/);
  let text = "";
  parts.forEach((part, i) => {
    if (i % 3 === 2) {
      text += part.replace(/^ (.*) $/, "$1");
    } else if (i % 3 === 0) {
      text += part
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]*>/g, "")
        .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
        .replace(/\\(.)/g, "$1");
    }
  });
  return text.trim();
}

/** A document's anchors, numbering repeats as GitHub does: "results", "results-1", "results-2". */
function anchorMaker(): { anchors: Set<string>; add: (heading: string) => string } {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  return {
    anchors,
    add(heading) {
      const base = slug(headingText(heading));
      let anchor = base;
      while (seen.has(anchor)) {
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        anchor = `${base}-${n}`;
      }
      seen.set(anchor, 0);
      anchors.add(anchor);
      return anchor;
    },
  };
}

interface Doc {
  anchors: Set<string>;
  /** Each paragraph (or heading) outside code blocks, with the line it starts on. */
  paragraphs: { line: number; text: string }[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function parse(path: string): Doc {
  const lines = readFileSync(path, "utf8")
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
    .split("\n");
  const { anchors, add } = anchorMaker();
  const paragraphs: Doc["paragraphs"] = [];
  let fence: string | null = null;
  let start = 0;
  let current: string[] = [];
  const endParagraph = () => {
    if (current.length > 0) paragraphs.push({ line: start, text: current.join("\n") });
    current = [];
  };
  lines.forEach((line, index) => {
    const open = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (open?.startsWith(fence.charAt(0)) && open.length >= fence.length && line.trim() === open) fence = null;
      return;
    }
    if (open) {
      endParagraph();
      fence = open;
      return;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      endParagraph();
      add(atx[1] ?? "");
      paragraphs.push({ line: index + 1, text: atx[1] ?? "" });
      return;
    }
    // A setext heading: a paragraph's last line, underlined with = or - (not a list item's or a table's).
    const last = current.at(-1);
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line) && last !== undefined && !/^\s*([-*+]\s|\d+[.)]\s|\||>)/.test(last)) {
      add(last);
      endParagraph();
      return;
    }
    if (line.trim() === "") {
      endParagraph();
      return;
    }
    if (current.length === 0) start = index + 1;
    current.push(line);
  });
  endParagraph();
  return { anchors, paragraphs };
}

/** Code spans and backslash escapes blanked out, every other character kept where it was. */
function withoutCode(text: string): string {
  return text
    .replace(/(`+)[\s\S]*?[^`]\1(?!`)/g, (code) => code.replace(/[^\n]/g, " "))
    .replace(/\\[\\`*_{}[\]()#+.!<>|-]/g, "  ");
}

// [text](target), [text](<target>) and [text](target "title"), images too; and [name]: target.
const LINK = /!?\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*(<[^>\n]*>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/gm;

interface Link {
  file: string;
  line: number;
  target: string;
}

function linksIn(file: string, doc: Doc): Link[] {
  const links: Link[] = [];
  for (const { line, text } of doc.paragraphs) {
    const plain = withoutCode(text);
    for (const pattern of [LINK, DEFINITION]) {
      for (const m of plain.matchAll(pattern)) {
        const target = (m[2] ?? "").replace(/^<(.*)>$/, "$1");
        const lineOf = line + (plain.slice(0, m.index).match(/\n/g)?.length ?? 0);
        links.push({ file, line: lineOf, target });
      }
    }
  }
  return links;
}

const files = markdownFiles(ROOT);
const docs = new Map(files.map((file) => [file, parse(file)] as const));
const links = files.flatMap((file) => linksIn(file, docs.get(file) ?? parse(file)));

function anchorsOf(file: string): Set<string> {
  let doc = docs.get(file);
  if (!doc) {
    doc = parse(file);
    docs.set(file, doc);
  }
  return doc.anchors;
}

/** Why a link leads nowhere, or null when it leads somewhere (or out of the repository, by its scheme). */
function problem(link: Link): string | null {
  const { target } = link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const hash = target.indexOf("#");
  const rawPath = (hash < 0 ? target : target.slice(0, hash)).replace(/\?.*$/, "");
  const fragment = hash < 0 ? "" : target.slice(hash + 1);
  let path: string;
  let anchor: string;
  try {
    path = decodeURIComponent(rawPath);
    anchor = decodeURIComponent(fragment);
  } catch {
    return "not a valid address";
  }
  const resolved = path === "" ? link.file : path.startsWith("/") ? join(ROOT, path) : resolve(dirname(link.file), path);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) return "outside the repository";
  if (!existsSync(resolved)) return "no such file or folder";
  if (anchor === "") return null;
  if (statSync(resolved).isDirectory() || extname(resolved).toLowerCase() !== ".md") {
    // GitHub's line anchors, in a file's own view; nothing else to check there.
    return /^L\d+(-L\d+)?$/.test(anchor) ? null : "an anchor in a file that isn't Markdown";
  }
  return anchorsOf(resolved).has(anchor) ? null : `no heading with the anchor #${anchor}`;
}

const name = (file: string) => relative(ROOT, file).split(sep).join("/");

describe("the repository's Markdown links", () => {
  it("make anchors as GitHub does", () => {
    const { add } = anchorMaker();
    expect(add("S5. `lockNow` and `<force-lock/>`, and what an update changes")).toBe(
      "s5-locknow-and-force-lock-and-what-an-update-changes",
    );
    expect(add("Phase 3: screen time ([design](docs/design/phase3-screen-time.md)) (built)")).toBe("phase-3-screen-time-design-built");
    expect(add("A4. Play's `allowed_accounts`")).toBe("a4-plays-allowed_accounts");
    expect(add("2. Register the package name first (recommended; your call)")).toBe(
      "2-register-the-package-name-first-recommended-your-call",
    );
    expect(add("The kid's _own_ words — and 988")).toBe("the-kids-own-words--and-988");
    // Repeats get -1, -2, and a heading that reads like a repeat's anchor gets one of its own.
    expect(["Results", "Results", "Results", "Results 1"].map((heading) => add(heading))).toEqual([
      "results",
      "results-1",
      "results-2",
      "results-1-1",
    ]);
  });

  it("say why a link leads nowhere", () => {
    const from = (target: string, file = "docs/guide.md") => problem({ file: join(ROOT, file), line: 1, target });
    expect(from("phase0-checklist.md#2-register-the-package-name-first-recommended-your-call")).toBeNull();
    expect(from("#1-what-belay-is-and-isnt")).toBeNull();
    expect(from("../android/scripts")).toBeNull();
    expect(from("https://developer.android.com/studio/terms")).toBeNull();
    expect(from("phase0-checklist.md#step-9")).toBe("no heading with the anchor #step-9");
    expect(from("#no-such-section")).toBe("no heading with the anchor #no-such-section");
    expect(from("phase99-checklist.md")).toBe("no such file or folder");
    expect(from("../../elsewhere.md")).toBe("outside the repository");
    expect(from("../android/scripts/provision.sh#usage")).toBe("an anchor in a file that isn't Markdown");
  });

  it("are found, in every doc", () => {
    const names = files.map(name);
    for (const doc of ["README.md", "ROADMAP.md", "CLAUDE.md", "docs/guide.md", "docs/platform-notes.md", "docs/design/README.md"]) {
      expect(names).toContain(doc);
    }
    for (const doc of names) expect(doc).not.toMatch(/(^|\/)(node_modules|\.git|\.claude)\//);
    expect(links.length).toBeGreaterThan(250);
    expect(links.filter((link) => link.target.includes("#")).length).toBeGreaterThan(60);
  });

  it("each lead to a file or folder that's there, and each #anchor to a heading in it", () => {
    const broken = links.flatMap((link) => {
      const why = problem(link);
      return why === null ? [] : [`${name(link.file)}:${link.line}: ${link.target} (${why})`];
    });
    expect(broken).toEqual([]);
  });
});
