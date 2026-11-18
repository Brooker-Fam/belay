/**
 * The kind of browser and device a request says it came from, coarsely, in a few fixed words:
 * "Chrome on Android", "Safari on iPhone", "an app's web view on Android". It's read from the
 * User-Agent, which is what the browser says it is: any browser can say something else (Chrome's
 * "Desktop site" on Android says Linux, an iPad's Safari says Mac, and a program can send anything),
 * so for a sign-in it's a hint, and the time is what tells a parent it wasn't them (the second
 * bypass audit's B1). Never the User-Agent's own text: it's the sender's, and only these words
 * leave this file.
 */

/** The browser, from the User-Agent, in the order that tells them apart (Edge and Opera say Chrome too, and every iPhone browser says Safari). */
const BROWSERS: [RegExp, string][] = [
  [/; wv\)/, "an app's web view"],
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:OPR|OPiOS)\//, "Opera"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

/** The device, from the User-Agent: an iPhone's says "like Mac OS X", so phones and tablets come first. */
const DEVICES: [RegExp, string][] = [
  [/\biPhone\b|\biPod\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "a Chromebook"],
  [/\bMacintosh\b|\bMac OS X\b/, "a Mac"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

/** A User-Agent is at most this long to be read at all; a longer one is no browser's. */
const MAX_USER_AGENT = 1024;

export interface BrowserKind {
  /** "Chrome", or null when the User-Agent names none Belay knows. */
  browser: string | null;
  /** "Android", or null. */
  device: string | null;
}

export function browserKindOf(userAgent: string | undefined): BrowserKind {
  const ua = userAgent && userAgent.length <= MAX_USER_AGENT ? userAgent : "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const device = DEVICES.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  return { browser, device };
}

/** "Chrome on Android", "a browser on Windows", or "an unknown browser". */
export function browserKind(userAgent: string | undefined): string {
  const { browser, device } = browserKindOf(userAgent);
  if (!device) return browser ?? "an unknown browser";
  return `${browser ?? "a browser"} on ${device}`;
}
