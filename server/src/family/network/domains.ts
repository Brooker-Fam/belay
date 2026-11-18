/**
 * Phase 3's network logging: a website's name as Belay keeps it, the server's half of core's
 * network/Domains.kt. Belay keeps a name's registrable part: its last two labels, or three when the
 * last is a country code and the one before is a second level many countries register under
 * ("bbc.co.uk"), with no Public Suffix List, as on the phone. A private website is one of those, so
 * what a parent types (a name, or a link copied from the browser) becomes the registrable domain
 * it's under: the phone keeps "help.example.org" as "example.org", so neither side could keep part
 * of a site private and note the rest under the same name.
 */
import { isHostname } from "../../device/schemas.js";
import { isCrisis } from "./store.js";

/** Second levels under country codes: co.uk, org.uk, com.au, ne.jp… (core's Domains.SECOND_LEVEL). */
const SECOND_LEVEL: ReadonlySet<string> = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gob",
  "gov",
  "govt",
  "gv",
  "id",
  "ltd",
  "me",
  "mil",
  "ne",
  "net",
  "nhs",
  "or",
  "org",
  "plc",
  "sch",
]);

/** Special-use top levels, never a website Belay notes (core's Domains.LOCAL_TLDS). */
const LOCAL_TLDS: ReadonlySet<string> = new Set(["arpa", "local", "localhost", "invalid", "internal"]);

/** The registrable part of a lowercase hostname: its last two labels, or three under a country's second level. */
export function registrable(host: string): string {
  const labels = host.split(".");
  const keep = labels.length >= 3 && (labels.at(-1) ?? "").length === 2 && SECOND_LEVEL.has(labels.at(-2) ?? "") ? 3 : 2;
  return labels.slice(-keep).join(".");
}

const NOT_A_NAME = "That isn't a website's name: type one like example.org, or paste the website's address.";

/**
 * What a parent typed as a website, as the registrable domain Belay keeps ("https://www.Example.org/help"
 * is "example.org", "Bücher.example" is "xn--bcher-kva.example"), or why it can't be one: not a
 * name, an address, a name that never leaves the phone or the home network, or one of 988's
 * websites, which Belay never notes anyway.
 */
export function typedWebsite(input: string): { domain: string } | { problem: string } {
  const text = input.trim().replace(/^\*\./, "");
  if (!text) return { problem: "Type a website's name, like example.org." };
  if (text.length > 2000) return { problem: NOT_A_NAME };
  let host: string;
  try {
    // The URL parser takes a link apart, lowercases the name and writes it in Punycode.
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname.replace(/\.$/, "");
  } catch {
    return { problem: NOT_A_NAME };
  }
  if (LOCAL_TLDS.has(host.split(".").at(-1) ?? "")) return { problem: "Belay never notes names on the phone itself or the home network, so there's no need to add one." };
  if (!isHostname(host)) return { problem: NOT_A_NAME };
  const domain = registrable(host);
  if (isCrisis(domain)) return { problem: "Belay never notes 988's websites anyway, so there's no need to add one." };
  return { domain };
}
