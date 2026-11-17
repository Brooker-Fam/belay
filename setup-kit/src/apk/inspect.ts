// What the plan's "apk" step needs to know about an APK, read from its bytes (no Android SDK):
// lib.sh asks aapt2 and apksigner the same questions.

import type { ApkFacts } from "../plan/interpreter.js";
import { readManifest } from "./manifest.js";
import { sha256Hex, signingCertificate, subjectName } from "./signing.js";
import { ApkFormatError, readEntry, readZip } from "./zip.js";

export interface ApkInfo {
  /** The file's own SHA-256. */
  sha256: string;
  size: number;
  /** Empty when the manifest can't be read. */
  package: string;
  testOnly: boolean;
  /** The signing certificate's SHA-256 and subject; undefined when unsigned. */
  certificate?: { sha256: string; dn: string; scheme: string } | undefined;
  /** Why it couldn't be read, if it couldn't. */
  problem?: string | undefined;
}

export async function inspectApk(bytes: Uint8Array): Promise<ApkInfo> {
  const info: ApkInfo = { sha256: await sha256Hex(bytes), size: bytes.length, package: "", testOnly: false };
  try {
    const zip = readZip(bytes);
    const manifest = await readEntry(zip, "AndroidManifest.xml");
    if (manifest === undefined) throw new ApkFormatError("there's no AndroidManifest.xml in it, so it isn't an APK");
    const m = readManifest(manifest);
    info.package = m.package;
    info.testOnly = m.testOnly;
    const cert = signingCertificate(zip);
    if (cert !== undefined) info.certificate = { sha256: await sha256Hex(cert.der), dn: subjectName(cert.der), scheme: cert.scheme };
  } catch (e) {
    if (!(e instanceof ApkFormatError)) throw e;
    info.problem = e.message;
  }
  return info;
}

/**
 * The plan's view of it, as lib.sh's build tools would give it: an APK they can't read is
 * "not test-only" with no package, and one without a signature has no signer.
 */
export function apkFacts(info: ApkInfo | undefined): ApkFacts {
  if (info === undefined) return { found: false, package: "", testOnly: "unknown", signerTool: true };
  return {
    found: true,
    package: info.package,
    testOnly: info.testOnly ? "yes" : "no",
    signer: info.certificate === undefined ? undefined : { sha256: info.certificate.sha256, dn: info.certificate.dn },
    signerTool: true,
  };
}

/** A SHA-256 as a person might have written it down: case, colons and spaces don't matter. */
export function sameSha256(a: string, b: string): boolean {
  const clean = (s: string): string => s.toLowerCase().replace(/[^0-9a-f]/g, "");
  return clean(a).length === 64 && clean(a) === clean(b);
}
