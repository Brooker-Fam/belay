// The APK reader against made-up APKs that aapt2 and apksigner read the same way
// (test/fixtures/apks.json says what they printed).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apkFacts, inspectApk, sameSha256 } from "../src/apk/inspect.js";
import { readManifest } from "../src/apk/manifest.js";
import { signingCertificate } from "../src/apk/signing.js";
import { readEntry, readZip } from "../src/apk/zip.js";

interface FixtureApk {
  file: string;
  what: string;
  package: string;
  testOnly: boolean;
  sha256?: string;
  dn?: string;
  scheme?: string;
  base64: string;
}
const { apks } = JSON.parse(readFileSync(new URL("fixtures/apks.json", import.meta.url), "utf8")) as { apks: FixtureApk[] };
const bytes = (apk: FixtureApk): Uint8Array => new Uint8Array(Buffer.from(apk.base64, "base64"));

describe("inspectApk", () => {
  for (const apk of apks) {
    it(`reads ${apk.file}: ${apk.what}`, async () => {
      const info = await inspectApk(bytes(apk));
      expect(info.problem).toBeUndefined();
      expect(info.package).toBe(apk.package);
      expect(info.testOnly).toBe(apk.testOnly);
      if (apk.sha256 === undefined) {
        expect(info.certificate).toBeUndefined();
      } else {
        expect(info.certificate).toEqual({ sha256: apk.sha256, dn: apk.dn, scheme: apk.scheme });
      }
      expect(info.size).toBe(bytes(apk).length);
      expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("says what's wrong with something that isn't an APK", async () => {
    const info = await inspectApk(new TextEncoder().encode("not an APK at all"));
    expect(info.problem).toMatch(/isn't a ZIP file/);
    expect(apkFacts(info)).toMatchObject({ found: true, package: "", testOnly: "no", signer: undefined });
  });

  it("says so when a ZIP has no manifest", async () => {
    // An empty ZIP: just the end of central directory record.
    const empty = new Uint8Array(22);
    new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
    expect((await inspectApk(empty)).problem).toMatch(/no AndroidManifest.xml/);
  });

  it("finds nothing to sign with in a damaged signing block", () => {
    const apk = apks.find((a) => a.file === "release.apk")!;
    const zip = readZip(bytes(apk));
    // Breaking the magic makes it an APK without a v2/v3 signature, as Android would see it.
    zip.bytes[zip.centralDirectory - 1] = 0;
    expect(signingCertificate(zip)).toBeUndefined();
  });

  it("reads the compiled manifest directly", async () => {
    const zip = readZip(bytes(apks.find((a) => a.file === "debug.apk")!));
    const manifest = await readEntry(zip, "AndroidManifest.xml");
    expect(readManifest(manifest!)).toEqual({ package: "family.brooker.belay", testOnly: true });
    expect(await readEntry(zip, "classes.dex")).toBeUndefined();
  });
});

describe("apkFacts: the plan's view, as lib.sh's build tools give it", () => {
  it("a missing file", () => {
    expect(apkFacts(undefined)).toEqual({ found: false, package: "", testOnly: "unknown", signerTool: true });
  });

  it("a signed debug build", async () => {
    const facts = apkFacts(await inspectApk(bytes(apks.find((a) => a.file === "debug.apk")!)));
    expect(facts).toEqual({
      found: true,
      package: "family.brooker.belay",
      testOnly: "yes",
      signer: { sha256: "82fc64ffa372193abcb4baefef5c428eb43122a116eaf21a4b257dfaae33d0f0", dn: "CN=Android Debug, O=Android, C=US" },
      signerTool: true,
    });
  });

  it("an unsigned APK has no signer", async () => {
    const facts = apkFacts(await inspectApk(bytes(apks.find((a) => a.file === "unsigned-other.apk")!)));
    expect(facts.signer).toBeUndefined();
    expect(facts.package).toBe("com.example.other");
  });
});

describe("sameSha256", () => {
  const hex = "d8df2f5b8a7d92fad84baf7e1aa5773cc5edffdcbf914164ebc9938c9ce02a55";
  it("ignores case, colons and spaces, as written down", () => {
    const written = hex.toUpperCase().replace(/(..)(?!$)/g, "$1:");
    expect(sameSha256(written, hex)).toBe(true);
    expect(sameSha256(` ${hex.slice(0, 32)} ${hex.slice(32)} `, hex)).toBe(true);
  });
  it("needs all 64 digits", () => {
    expect(sameSha256(hex.slice(0, 63), hex)).toBe(false);
    expect(sameSha256("", "")).toBe(false);
    expect(sameSha256(hex.replace("d8", "d9"), hex)).toBe(false);
  });
});
